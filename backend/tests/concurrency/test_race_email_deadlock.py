"""Reserving and releasing email allowance at the same time never deadlocks.

A reserve writes the month counter and the day counter, a release gives one back to both. If one
locked month then day and the other day then month, two concurrent transactions would each hold
one row and wait for the other, and Postgres would abort one with SQLSTATE 40P01. Real Postgres,
real sessions on several engines (as several API instances would have), the seam between the two
writes widened with ``pg_sleep`` so the window is certain. A test with the old release order, kept
here as the mutation, proves the harness would catch the bug.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import date

import asyncpg
import httpx
import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db.errors import DEADLOCK_DETECTED, extract_sqlstate_constraint
from app.repositories import reminders as repo
from tests.conftest import FIXED_NOW, app_sqlalchemy_url
from tests.integration.test_reminders import MovableClock, _app, internal

pytestmark = [pytest.mark.asyncio, pytest.mark.race]

DAY = date(2026, 10, 19)
MONTH = date(2026, 10, 1)
START = 100
N = 12  # reserves, and as many releases, at once


@pytest_asyncio.fixture
async def counters(owner_conn: asyncpg.Connection) -> AsyncIterator[None]:
    """Both counters at START, deadlock detection after 50 ms instead of 1 s."""
    await owner_conn.execute("TRUNCATE email_counter, email_month_counter")
    await owner_conn.execute("INSERT INTO email_counter (day, sent) VALUES ($1, $2)", DAY, START)
    await owner_conn.execute(
        "INSERT INTO email_month_counter (month, sent) VALUES ($1, $2)", MONTH, START
    )
    await owner_conn.execute("ALTER ROLE clinic_app SET deadlock_timeout = '50ms'")
    yield
    await owner_conn.execute("ALTER ROLE clinic_app RESET deadlock_timeout")
    await owner_conn.execute("TRUNCATE email_counter, email_month_counter")


async def _sleep_between(session: AsyncSession) -> None:
    await session.execute(text("SELECT pg_sleep(0.05)"))


async def _old_release(session: AsyncSession, *, day: date, month: date) -> None:
    """The release as it was first written: day, then month. The mutation under test."""
    await session.execute(repo._DAY_DOWN, {"day": day})
    await _sleep_between(session)
    await session.execute(repo._MONTH_DOWN, {"month": month})


async def _run(
    release_fn: Callable[..., Awaitable[None]], monkeypatch: pytest.MonkeyPatch
) -> list[BaseException | None]:
    monkeypatch.setattr(repo, "_between_counters", _sleep_between)
    engines = [create_async_engine(app_sqlalchemy_url(), pool_size=N) for _ in range(3)]
    makers = [async_sessionmaker(e, expire_on_commit=False) for e in engines]

    async def reserve(i: int) -> None:
        async with makers[i % 3]() as session, session.begin():
            reason = await repo.reserve(
                session, day=DAY, month=MONTH, day_cap=10_000, month_cap=10_000
            )
            assert reason is None

    async def release(i: int) -> None:
        async with makers[i % 3]() as session, session.begin():
            await release_fn(session, day=DAY, month=MONTH)

    try:
        results = await asyncio.gather(
            *([reserve(i) for i in range(N)] + [release(i) for i in range(N)]),
            return_exceptions=True,
        )
    finally:
        for e in engines:
            await e.dispose()
    return [r if isinstance(r, BaseException) else None for r in results]


def _states(results: list[BaseException | None]) -> set[str | None]:
    return {extract_sqlstate_constraint(r)[0] for r in results if isinstance(r, DBAPIError)}


async def test_concurrent_reserves_and_releases_never_deadlock_and_end_exact(
    counters: None, owner_conn: asyncpg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    results = await _run(repo.release, monkeypatch)
    assert [r for r in results if r is not None] == [], "no transaction may fail"
    day = await owner_conn.fetchval("SELECT sent FROM email_counter WHERE day = $1", DAY)
    month = await owner_conn.fetchval(
        "SELECT sent FROM email_month_counter WHERE month = $1", MONTH
    )
    # N reserved and N given back: exactly where it started, in both counters
    assert (day, month) == (START, START)


async def test_the_old_release_order_would_deadlock_here(
    counters: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The mutation: release locking day before month. The same load must hit 40P01, so the test
    above is able to fail."""
    results = await _run(_old_release, monkeypatch)
    assert DEADLOCK_DETECTED in _states(results), [repr(r) for r in results if r is not None]


async def test_the_api_survives_concurrent_reserves_and_releases_across_instances(
    counters: None, owner_conn: asyncpg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(repo, "_between_counters", _sleep_between)
    clock = MovableClock(FIXED_NOW)  # 2026-10-19: the counters' day and month
    opts = {"EMAIL_DAILY_LIMIT": 10_000, "EMAIL_MONTHLY_LIMIT": 10_000}

    async def reserve(api: httpx.AsyncClient) -> int:
        r = await internal(
            api, clock, "POST", "/internal/emails/reserve?purpose=ack", role="patient", sub="racer"
        )
        return r.status_code

    async def release(api: httpx.AsyncClient) -> int:
        body = f'{{"day":"{DAY}","month":"{MONTH}"}}'
        r = await internal(
            api,
            clock,
            "POST",
            "/internal/emails/release",
            json_body=body,
            role="patient",
            sub="racer",
        )
        return r.status_code

    async with _app(clock, **opts) as a, _app(clock, **opts) as b, _app(clock, **opts) as c:
        apis = [a, b, c]
        codes = await asyncio.gather(
            *([reserve(apis[i % 3]) for i in range(N)] + [release(apis[i % 3]) for i in range(N)])
        )
    assert set(codes) == {200}, codes
    day = await owner_conn.fetchval("SELECT sent FROM email_counter WHERE day = $1", DAY)
    assert day == START
