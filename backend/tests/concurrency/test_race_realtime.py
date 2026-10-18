"""Concurrency on the real database: the publish budget never overspends, and concurrent relays
never publish an event twice."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import asyncpg
import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.clock import FakeClock
from app.db.session import get_sessionmaker
from app.services.publish_budget import PublishBudget
from app.services.relay import relay_once
from tests.conftest import FIXED_NOW, make_settings, seeded_doctor_id, seeded_patient_id
from tests.integration.realtime_support import RecordingPublisher

pytestmark = [pytest.mark.asyncio, pytest.mark.race]

HUGE = timedelta(days=3650)


def _sessionmaker() -> async_sessionmaker[AsyncSession]:
    return get_sessionmaker(make_settings(DB_POOL_SIZE=30))


async def test_concurrent_debits_never_exceed_the_cap(
    realtime_clean: None, owner_conn: asyncpg.Connection
) -> None:
    cap, attempts = 25, 80
    budget = PublishBudget(_sessionmaker(), cap)
    barrier = asyncio.Barrier(attempts)

    async def one() -> bool:
        await barrier.wait()
        return await budget.debit(1, FIXED_NOW)

    results = await asyncio.gather(*[one() for _ in range(attempts)])
    assert sum(results) == cap
    assert await owner_conn.fetchval("SELECT used FROM realtime_publish_budget") == cap
    assert await budget.exhausted(FIXED_NOW)


async def test_concurrent_batch_debits_never_exceed_the_cap(
    realtime_clean: None, owner_conn: asyncpg.Connection
) -> None:
    cap = 100
    budget = PublishBudget(_sessionmaker(), cap)
    sizes = [7, 13, 21, 9, 30, 4, 16, 11, 25, 6, 19, 8] * 2
    barrier = asyncio.Barrier(len(sizes))

    async def one(n: int) -> int:
        await barrier.wait()
        return n if await budget.debit(n, FIXED_NOW) else 0

    granted = sum(await asyncio.gather(*[one(n) for n in sizes]))
    used = await owner_conn.fetchval("SELECT used FROM realtime_publish_budget")
    assert used == granted <= cap


async def test_a_new_month_starts_a_fresh_budget_even_under_contention(
    realtime_clean: None, owner_conn: asyncpg.Connection
) -> None:
    budget = PublishBudget(_sessionmaker(), 5)
    october, november = FIXED_NOW, datetime(2026, 11, 1, 0, 0, 1, tzinfo=UTC)
    assert all([await budget.debit(1, october) for _ in range(5)])
    assert not await budget.debit(1, october)
    results = await asyncio.gather(*[budget.debit(1, november) for _ in range(12)])
    assert sum(results) == 5
    rows = await owner_conn.fetch(
        "SELECT month::text, used FROM realtime_publish_budget ORDER BY 1"
    )
    assert [(r[0], r[1]) for r in rows] == [("2026-10-01", 5), ("2026-11-01", 5)]


async def test_concurrent_relays_publish_each_event_exactly_once(
    realtime_clean: None, owner_conn: asyncpg.Connection
) -> None:
    appt = await owner_conn.fetchval(
        "INSERT INTO appointments (doctor_id, patient_id, starts_at, ends_at) "
        "VALUES ($1, $2, $3::timestamptz, $3::timestamptz + interval '30 minutes') RETURNING id",
        seeded_doctor_id("otieno"),
        seeded_patient_id("amina"),
        datetime(2026, 10, 28, 6, 0, tzinfo=UTC),
    )
    await owner_conn.execute(
        "INSERT INTO appointment_events "
        "(appointment_id, doctor_id, event_type, to_starts_at, local_date) "
        "SELECT $1, $2, 'booked', $3, '2026-10-28' FROM generate_series(1, 40)",
        appt,
        seeded_doctor_id("otieno"),
        datetime(2026, 10, 28, 6, 0, tzinfo=UTC),
    )
    sessionmaker = _sessionmaker()
    budget = PublishBudget(sessionmaker, 25_000)
    publisher = RecordingPublisher(delay=0.2)  # holds the cursor row while the others arrive
    barrier = asyncio.Barrier(8)

    async def relay() -> int:
        await barrier.wait()
        result = await relay_once(
            sessionmaker, publisher, budget, FakeClock(FIXED_NOW), max_age=HUGE, limit=100
        )
        return result.published

    sent = await asyncio.gather(*[relay() for _ in range(8)])
    assert sorted(sent) == [0] * 7 + [80], sent  # one relay took the row, the rest skipped it
    ids = [m.id for m in publisher.messages]
    assert len(ids) == len(set(ids)) == 80
    assert await owner_conn.fetchval("SELECT count(*) FROM appointment_events") == 40


async def test_a_second_relay_does_not_wait_for_the_one_holding_the_cursor(
    realtime_clean: None, owner_conn: asyncpg.Connection
) -> None:
    import time

    appt = await owner_conn.fetchval(
        "INSERT INTO appointments (doctor_id, patient_id, starts_at, ends_at) "
        "VALUES ($1, $2, $3::timestamptz, $3::timestamptz + interval '30 minutes') RETURNING id",
        seeded_doctor_id("otieno"),
        seeded_patient_id("amina"),
        datetime(2026, 10, 28, 6, 0, tzinfo=UTC),
    )
    await owner_conn.execute(
        "INSERT INTO appointment_events "
        "(appointment_id, doctor_id, event_type, to_starts_at, local_date) "
        "VALUES ($1, $2, 'booked', $3, '2026-10-28')",
        appt,
        seeded_doctor_id("otieno"),
        datetime(2026, 10, 28, 6, 0, tzinfo=UTC),
    )
    sessionmaker = _sessionmaker()
    budget = PublishBudget(sessionmaker, 25_000)
    slow = RecordingPublisher(delay=1.5)  # the first relay holds the cursor row this long
    first = asyncio.create_task(
        relay_once(sessionmaker, slow, budget, FakeClock(FIXED_NOW), max_age=HUGE)
    )
    await asyncio.sleep(0.4)  # the first has taken the row and is inside its publish
    started = time.monotonic()
    second = await relay_once(
        sessionmaker, RecordingPublisher(), budget, FakeClock(FIXED_NOW), max_age=HUGE
    )
    waited = time.monotonic() - started
    assert second.published == 0
    assert waited < 0.5, f"the second relay waited {waited:.2f}s for the lease instead of skipping"
    assert (await first).published == 2
