"""A real Postgres deadlock inside a booking transaction is retried once, then reported.

Nothing is mocked: the ``booking._after_write`` seam takes advisory locks in opposite order
across two transactions, Postgres detects the deadlock and aborts one with SQLSTATE 40P01, and
the service must retry that transaction once. A deadlock that persists across the retry must
surface as 409 CONCURRENT_UPDATE, never a 500.
"""

from __future__ import annotations

import asyncio
import io
import logging
from collections.abc import AsyncIterator
from typing import Any

import asyncpg
import httpx
import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import JsonFormatter
from app.services import booking
from tests.concurrency.harness import count_booked_at, make_patients, make_race_app, race
from tests.conftest import TEST_PUBLIC_BASE_URL, owner_dsn, seeded_doctor_id

pytestmark = [pytest.mark.asyncio, pytest.mark.race]

OTIENO = str(seeded_doctor_id("otieno"))
KEY_A = 424201
KEY_B = 424202
SLOTS = ["2026-10-26T09:00:00+03:00", "2026-10-26T09:30:00+03:00"]


@pytest_asyncio.fixture
async def fast_deadlock_detection() -> AsyncIterator[None]:
    """Make the app role detect deadlocks after 50 ms instead of 1 s.

    ``deadlock_timeout`` is superuser-only, so it is set on the role (new connections pick it
    up) rather than with ``SET LOCAL`` from inside the app's own transaction.
    """
    admin = await asyncpg.connect(owner_dsn())
    try:
        await admin.execute("ALTER ROLE clinic_app SET deadlock_timeout = '50ms'")
        yield
    finally:
        await admin.execute("ALTER ROLE clinic_app RESET deadlock_timeout")
        await admin.close()


async def _advisory_lock(session: AsyncSession, key: int) -> None:
    await session.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": key})


async def test_deadlock_retry_success(
    reset_appointments: None,
    fast_deadlock_detection: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app = make_race_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url=TEST_PUBLIC_BASE_URL) as setup:
        patients = await make_patients(setup, 2)

    barrier = asyncio.Barrier(2)
    roles: list[int] = []
    infos: list[dict[Any, Any]] = []

    async def opposite_order_on_first_attempt(session: AsyncSession) -> None:
        n = session.info.get("hook_calls", 0)
        session.info["hook_calls"] = n + 1
        if n == 0:
            infos.append(session.info)
            role = len(roles)
            roles.append(role)
            first, second = (KEY_A, KEY_B) if role == 0 else (KEY_B, KEY_A)
            await _advisory_lock(session, first)
            await barrier.wait()  # both requests now hold their first lock
            await _advisory_lock(session, second)  # one of the two is deadlocked here
        # Retries (n >= 1) take no locks, so the retried transaction can finish.

    monkeypatch.setattr(booking, "_after_write", opposite_order_on_first_attempt)

    async def task(client: httpx.AsyncClient, i: int) -> httpx.Response:
        return await client.post(
            "/appointments",
            json={"doctor_id": OTIENO, "patient_id": patients[i], "starts_at": SLOTS[i]},
        )

    responses = await race(app, task, 2)

    assert [r.status_code for r in responses] == [201, 201], [r.text for r in responses]
    # Exactly one request was the deadlock victim and ran its seam a second time.
    assert sorted(info["hook_calls"] for info in infos) == [1, 2]
    for slot in SLOTS:
        assert await count_booked_at(OTIENO, slot) == 1


async def test_deadlock_persistent_returns_409_after_one_retry(
    reset_appointments: None,
    fast_deadlock_detection: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app = make_race_app(log_level="info")
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url=TEST_PUBLIC_BASE_URL) as client:
        patient = (await make_patients(client, 1))[0]

        start_q: asyncio.Queue[int] = asyncio.Queue()
        ready_q: asyncio.Queue[bool] = asyncio.Queue()
        hook_calls = 0

        async def always_deadlock(session: AsyncSession) -> None:
            nonlocal hook_calls
            hook_calls += 1
            await _advisory_lock(session, KEY_A)
            await start_q.put(hook_calls)  # ask the adversary to hold B and wait for A
            await ready_q.get()
            await _advisory_lock(session, KEY_B)  # completes the cycle

        monkeypatch.setattr(booking, "_after_write", always_deadlock)

        adversary_conn = await asyncpg.connect(owner_dsn())
        # A long timeout makes the app transaction the one Postgres aborts, deterministically.
        await adversary_conn.execute("SET deadlock_timeout = '10s'")

        async def adversary() -> None:
            while True:
                await start_q.get()
                tx = adversary_conn.transaction()
                await tx.start()
                try:
                    await adversary_conn.execute("SELECT pg_advisory_xact_lock($1)", KEY_B)
                    await ready_q.put(True)
                    await adversary_conn.execute("SELECT pg_advisory_xact_lock($1)", KEY_A)
                finally:
                    await tx.rollback()

        task = asyncio.create_task(adversary())

        buffer = io.StringIO()
        handler = logging.StreamHandler(buffer)
        handler.setFormatter(JsonFormatter())
        root = logging.getLogger()
        root.addHandler(handler)
        try:
            resp = await client.post(
                "/appointments",
                json={"doctor_id": OTIENO, "patient_id": patient, "starts_at": SLOTS[0]},
            )
        finally:
            root.removeHandler(handler)
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            await adversary_conn.close()

    assert resp.status_code == 409, resp.text
    assert resp.json()["code"] == "CONCURRENT_UPDATE"
    assert resp.headers["content-type"].startswith("application/problem+json")
    assert hook_calls == 2  # retried exactly once, not more
    logs = buffer.getvalue()
    assert '"status": 500' not in logs
    assert "unhandled exception" not in logs
    assert await count_booked_at(OTIENO, SLOTS[0]) == 0
