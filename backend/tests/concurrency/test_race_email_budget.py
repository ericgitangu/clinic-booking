"""Concurrent senders, on several API instances at once, never take more emails than the caps."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import asyncpg
import httpx
import pytest
import pytest_asyncio

from tests.conftest import FIXED_NOW
from tests.integration.test_reminders import MovableClock, _app, internal

pytestmark = [pytest.mark.asyncio, pytest.mark.race]


@pytest_asyncio.fixture
async def fresh_counters(owner_conn: asyncpg.Connection) -> AsyncIterator[None]:
    await owner_conn.execute("TRUNCATE email_counter, email_month_counter")
    yield
    await owner_conn.execute("TRUNCATE email_counter, email_month_counter")


async def _reserve(api: httpx.AsyncClient, clock: MovableClock) -> bool:
    resp = await internal(
        api, clock, "POST", "/internal/emails/reserve?purpose=ack", role="patient", sub="racer"
    )
    assert resp.status_code == 200, resp.text
    return bool(resp.json()["granted"])


@pytest.mark.parametrize(
    ("day_cap", "month_cap", "winners"), [(100, 10, 10), (10, 100, 10), (7, 7, 7)]
)
async def test_forty_concurrent_reservations_never_exceed_the_cap(
    fresh_counters: None,
    owner_conn: asyncpg.Connection,
    day_cap: int,
    month_cap: int,
    winners: int,
) -> None:
    clock = MovableClock(FIXED_NOW)
    opts = {
        "EMAIL_DAILY_LIMIT": day_cap,
        "EMAIL_MONTHLY_LIMIT": month_cap,
        "EMAIL_ACK_RESERVE": 0,  # these are acknowledgements racing for the whole cap
    }
    # three API instances, each with its own connection pool, all asking at once
    async with _app(clock, **opts) as a, _app(clock, **opts) as b, _app(clock, **opts) as c:
        granted = await asyncio.gather(*(_reserve(x, clock) for x in [a, b, c] * 14))
    assert sum(granted) == winners, "the caps must hold under concurrency"
    row = await owner_conn.fetchrow(
        "SELECT (SELECT sent FROM email_counter) AS d, (SELECT sent FROM email_month_counter) AS m"
    )
    assert row is not None and row["d"] == winners and row["m"] == winners, dict(row)
