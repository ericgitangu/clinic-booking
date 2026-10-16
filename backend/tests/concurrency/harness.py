"""Race-test harness: a barrier releases N concurrent requests over one ASGI app,
while a sampler on a separate connection watches pg_locks for blocked waiters."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from types import TracebackType

import asyncpg
import httpx
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_clock
from app.core.clock import FakeClock
from app.main import create_app
from tests.conftest import FIXED_NOW, TEST_PUBLIC_BASE_URL, make_settings, owner_dsn

WAITERS_SQL = "SELECT count(*) FROM pg_locks WHERE locktype = 'transactionid' AND NOT granted"


def make_race_app(log_level: str = "warning") -> object:
    # DB_POOL_SIZE=30 so 25 concurrent requests all get a connection.
    app = create_app(make_settings(DB_POOL_SIZE=30, LOG_LEVEL=log_level))
    app.dependency_overrides[get_clock] = lambda: FakeClock(FIXED_NOW)
    return app


async def pg_sleep_after_write(session: AsyncSession) -> None:
    """Widen the contention window: hold the pending write ~0.2 s before commit."""
    await session.execute(text("SELECT pg_sleep(0.2)"))


class LockSampler:
    """Polls pg_locks every 20 ms and records the peak number of blocked waiters."""

    def __init__(self) -> None:
        self.peak = 0
        self._stop = False
        self._task: asyncio.Task[None] | None = None

    async def _run(self) -> None:
        conn = await asyncpg.connect(owner_dsn())
        try:
            while not self._stop:
                n = await conn.fetchval(WAITERS_SQL)
                self.peak = max(self.peak, int(n))
                await asyncio.sleep(0.02)
        finally:
            await conn.close()

    async def __aenter__(self) -> LockSampler:
        self._task = asyncio.create_task(self._run())
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self._stop = True
        if self._task is not None:
            await self._task


async def race(
    app: object,
    task: Callable[[httpx.AsyncClient, int], Awaitable[httpx.Response]],
    n: int,
) -> list[httpx.Response]:
    """Release n concurrent requests simultaneously via an asyncio.Barrier."""
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)  # type: ignore[arg-type]
    barrier = asyncio.Barrier(n)
    async with httpx.AsyncClient(transport=transport, base_url=TEST_PUBLIC_BASE_URL) as client:

        async def one(i: int) -> httpx.Response:
            await barrier.wait()
            return await task(client, i)

        return list(await asyncio.gather(*[one(i) for i in range(n)]))


async def count_booked_at(doctor_id: str, starts_at: str) -> int:
    from datetime import datetime
    from uuid import UUID

    moment = datetime.fromisoformat(starts_at)
    conn = await asyncpg.connect(owner_dsn())
    try:
        val = await conn.fetchval(
            "SELECT count(*) FROM appointments "
            "WHERE doctor_id = $1 AND starts_at = $2 AND status = 'booked'",
            UUID(doctor_id),
            moment,
        )
        return int(val)
    finally:
        await conn.close()


async def make_patients(client: httpx.AsyncClient, n: int) -> list[str]:
    ids: list[str] = []
    for i in range(n):
        resp = await client.post("/patients", json={"full_name": f"Race Patient {i:03d}"})
        assert resp.status_code == 201, resp.text
        ids.append(resp.json()["id"])
    return ids
