"""A committed event is never left waiting for a later trigger because the relay that should have
sent it lost a race. Real Postgres, the real booking route and relay, concurrent bookers.

What strands an event: another relay holds the cursor row (SKIP LOCKED returns at once, and the
holder may have read its batch before this event committed). ``Relay.run`` now retries, a bounded
number of times with a short backoff, and the batch the winner sends includes the stranded events.
Each event is still published exactly once, and nothing is published before its transaction is
visible (the ``xmin`` guard).
"""

from __future__ import annotations

import asyncio
import time
import uuid
from collections import Counter

import asyncpg
import httpx
import pytest

from app.services import relay as relay_module
from tests.conftest import owner_dsn, seeded_doctor_id
from tests.integration.realtime_support import RecordingPublisher, make_realtime_app

pytestmark = [pytest.mark.asyncio, pytest.mark.race]

OTIENO = str(seeded_doctor_id("otieno"))
SLOTS = [f"2026-10-26T{h:02d}:00:00+03:00" for h in (9, 10, 11, 13, 14)]
HOLD = 0.15  # how long the first relay holds the cursor while it publishes (seconds)


async def _patients(conn: asyncpg.Connection, n: int) -> list[str]:
    ids = [str(uuid.uuid4()) for _ in range(n)]
    for i, pid in enumerate(ids):
        await conn.execute(
            "INSERT INTO patients (id, full_name) VALUES ($1, $2)", uuid.UUID(pid), f"Racer {i}"
        )
    return ids


async def _book(client: httpx.AsyncClient, patient: str, slot: str) -> httpx.Response:
    return await client.post(
        "/appointments", json={"doctor_id": OTIENO, "patient_id": patient, "starts_at": slot}
    )


async def _race(n: int, conn: asyncpg.Connection) -> tuple[RecordingPublisher, float, int]:
    """n bookers: the first starts a relay that holds the cursor for HOLD seconds, the rest book
    while it is publishing (their events commit after its read, and their relays are refused the
    lock). Returns the publisher, the time until every response was back, and the event count."""
    publisher = RecordingPublisher(delay=HOLD)
    patients = await _patients(conn, n)
    app = make_realtime_app(publisher)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        started = time.monotonic()
        first = asyncio.create_task(_book(client, patients[0], SLOTS[0]))
        await asyncio.sleep(HOLD / 2)
        rest = [asyncio.create_task(_book(client, patients[i], SLOTS[i])) for i in range(1, n)]
        responses = await asyncio.gather(first, *rest)
        elapsed = time.monotonic() - started
    assert [r.status_code for r in responses] == [201] * n
    return publisher, elapsed, await conn.fetchval("SELECT count(*) FROM appointment_events")


def _published_once(publisher: RecordingPublisher, n: int) -> None:
    ids = [m.id for m in publisher.messages]
    assert len(ids) == len(set(ids)), "a message went out twice"
    names = Counter((m.channel.split(":")[0], m.name) for m in publisher.messages)
    assert names[("admin", "booked")] == n, names
    assert names[("slots", "slot_taken")] == n, names


@pytest.mark.parametrize("bookers", [2, 5])
async def test_every_concurrent_booking_is_published_once_within_two_seconds(
    realtime_clean: None, owner_conn: asyncpg.Connection, bookers: int
) -> None:
    publisher, elapsed, events = await _race(bookers, owner_conn)
    assert events == bookers
    assert elapsed < 2.0, elapsed
    _published_once(publisher, bookers)
    last = await owner_conn.fetchrow(
        "SELECT txid::text AS txid, id FROM appointment_events ORDER BY txid DESC, id DESC LIMIT 1"
    )
    cursor = await owner_conn.fetchrow("SELECT txid::text AS txid, id FROM event_relay_cursor")
    assert last is not None and cursor is not None
    assert (cursor["txid"], cursor["id"]) == (last["txid"], last["id"])  # nothing left behind


@pytest.mark.control
async def test_control_without_the_retry_an_event_is_left_waiting(
    realtime_clean: None, owner_conn: asyncpg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The same race with one try per trigger (the old behaviour): events stay unpublished. If this
    ever passes the assertion below for the wrong reason, the race test above proves nothing."""
    monkeypatch.setattr(relay_module, "ATTEMPTS", 1)
    publisher, _elapsed, events = await _race(5, owner_conn)
    assert events == 5
    booked = sum(1 for m in publisher.messages if m.name == "booked")
    assert booked < 5, "with no retry the losing relays should have left events behind"


async def test_nothing_is_published_while_an_older_transaction_is_open(
    realtime_clean: None, owner_conn: asyncpg.Connection
) -> None:
    """The xmin guard is unchanged: the retry waits, it never publishes early, and once the open
    transaction ends the next trigger sends everything, once."""
    publisher = RecordingPublisher()
    patients = await _patients(owner_conn, 2)
    app = make_realtime_app(publisher)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    holder = await asyncpg.connect(owner_dsn())
    tx = holder.transaction()
    await tx.start()
    await holder.fetchval("SELECT pg_current_xact_id()")  # takes an xid: pins the horizon
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            started = time.monotonic()
            assert (await _book(client, patients[0], SLOTS[0])).status_code == 201
            assert time.monotonic() - started < 1.0  # bounded: it does not wait for the holder
            assert publisher.messages == []  # not visible yet, so not published
            await tx.commit()
            assert (await _book(client, patients[1], SLOTS[1])).status_code == 201
    finally:
        if holder.is_in_transaction():
            await tx.rollback()
        await holder.close()
    _published_once(publisher, 2)


async def test_a_retry_never_publishes_an_event_twice(
    realtime_clean: None, owner_conn: asyncpg.Connection
) -> None:
    """Many triggers, some retried: every event is in the log exactly once."""
    publisher, _elapsed, events = await _race(5, owner_conn)
    assert events == 5
    ids = [m.id for m in publisher.messages]
    assert len(ids) == len(set(ids))
