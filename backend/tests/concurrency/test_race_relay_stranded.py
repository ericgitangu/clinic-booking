"""A committed event is never left waiting for a later trigger because the relay that should have
sent it lost a race. Real Postgres, the real booking route and relay, concurrent bookers.

What strands an event: another relay holds the cursor row (SKIP LOCKED makes the loser return at
once, and the holder may have read its batch before the loser's event committed). The design: a
LOSER returns immediately (no sleep, no retry); the HOLDER drains, re-reading from a fresh snapshot
after each pass until a pass finds nothing, so it sends the losers' events however slow its own
publish was. Each event is still published exactly once, and nothing is published before its
transaction is visible (the ``xmin`` guard).
"""

from __future__ import annotations

import asyncio
import time
import uuid
from collections import Counter

import asyncpg
import httpx
import pytest

from app.core.clock import FakeClock
from app.db.session import get_sessionmaker
from app.services import relay as relay_module
from app.services.publish_budget import PublishBudget
from app.services.relay import Relay
from tests.conftest import FIXED_NOW, make_settings, owner_dsn, seeded_doctor_id
from tests.integration.realtime_support import RecordingPublisher, make_realtime_app

pytestmark = [pytest.mark.asyncio, pytest.mark.race]

OTIENO = str(seeded_doctor_id("otieno"))
SLOTS = [f"2026-10-26T{h:02d}:00:00+03:00" for h in (9, 10, 11, 13, 14)]
CAP = 2.0  # the relay's time budget (REALTIME_RELAY_TIMEOUT_SECONDS)


async def _patients(conn: asyncpg.Connection, n: int) -> list[str]:
    ids = [str(uuid.uuid4()) for _ in range(n)]
    for i, pid in enumerate(ids):
        await conn.execute(
            "INSERT INTO patients (id, full_name) VALUES ($1, $2)", uuid.UUID(pid), f"Racer {i}"
        )
    return ids


async def _book(client: httpx.AsyncClient, patient: str, slot: str) -> tuple[httpx.Response, float]:
    started = time.monotonic()
    resp = await client.post(
        "/appointments", json={"doctor_id": OTIENO, "patient_id": patient, "starts_at": slot}
    )
    return resp, time.monotonic() - started


async def _race(
    n: int, hold: float, conn: asyncpg.Connection
) -> tuple[RecordingPublisher, float, list[float]]:
    """n bookers. The first starts a relay that holds the cursor for ``hold`` seconds while it
    publishes; the rest book while it is publishing, so their events commit after its read and
    their relays are refused the lock. Returns the publisher, the time until every response was
    back, and the losers' response times."""
    publisher = RecordingPublisher(delay=hold)
    patients = await _patients(conn, n)
    app = make_realtime_app(publisher)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        started = time.monotonic()
        first = asyncio.create_task(_book(client, patients[0], SLOTS[0]))
        await asyncio.sleep(hold / 2)
        rest = [asyncio.create_task(_book(client, patients[i], SLOTS[i])) for i in range(1, n)]
        done = await asyncio.gather(first, *rest)
        elapsed = time.monotonic() - started
    assert [r.status_code for r, _ in done] == [201] * n
    return publisher, elapsed, [t for _, t in done[1:]]


def _published_once(publisher: RecordingPublisher, n: int) -> None:
    ids = [m.id for m in publisher.messages]
    assert len(ids) == len(set(ids)), "a message went out twice"
    names = Counter((m.channel.split(":")[0], m.name) for m in publisher.messages)
    assert names[("admin", "booked")] == n, names
    assert names[("slots", "slot_taken")] == n, names


@pytest.mark.parametrize("hold", [0.1, 0.4, 0.6])
@pytest.mark.parametrize("bookers", [2, 5])
async def test_every_concurrent_booking_is_published_once_within_the_cap(
    realtime_clean: None, owner_conn: asyncpg.Connection, bookers: int, hold: float
) -> None:
    publisher, elapsed, loser_times = await _race(bookers, hold, owner_conn)
    assert elapsed < CAP, elapsed
    _published_once(publisher, bookers)
    last = await owner_conn.fetchrow(
        "SELECT txid::text AS txid, id FROM appointment_events ORDER BY txid DESC, id DESC LIMIT 1"
    )
    cursor = await owner_conn.fetchrow("SELECT txid::text AS txid, id FROM event_relay_cursor")
    assert last is not None and cursor is not None
    assert (cursor["txid"], cursor["id"]) == (last["txid"], last["id"])  # nothing left behind
    # The losers did not wait for anyone's publish, nor sleep: they are back in a fraction of it.
    assert max(loser_times) < hold, (hold, loser_times)


@pytest.mark.control
@pytest.mark.parametrize("hold", [0.4, 0.6])
async def test_control_a_holder_that_does_not_drain_leaves_events_behind(
    realtime_clean: None,
    owner_conn: asyncpg.Connection,
    monkeypatch: pytest.MonkeyPatch,
    hold: float,
) -> None:
    """The same race with one pass per trigger (no drain): events stay unpublished. If this ever
    stops failing to publish them, the race test above proves nothing."""
    monkeypatch.setattr(relay_module, "MAX_PASSES", 1)
    publisher, _elapsed, _loser_times = await _race(5, hold, owner_conn)
    booked = sum(1 for m in publisher.messages if m.name == "booked")
    assert booked < 5, "with no drain the losers' events should have been left behind"


async def test_a_loser_returns_at_once_when_the_cursor_is_held(
    realtime_clean: None, owner_conn: asyncpg.Connection
) -> None:
    """No sleep ladder: with the cursor row locked by someone else, ``Relay.run`` is back in well
    under 50 ms having published nothing."""
    settings = make_settings()
    sessionmaker = get_sessionmaker(settings)
    publisher = RecordingPublisher()
    relay = Relay(
        sessionmaker,
        publisher,
        PublishBudget(sessionmaker, settings.REALTIME_PUBLISH_CAP_PER_MONTH),
        make_realtime_app(publisher).state.settings,
    )
    holder = await asyncpg.connect(owner_dsn())
    tx = holder.transaction()
    await tx.start()
    await holder.fetchval("SELECT txid FROM event_relay_cursor FOR UPDATE")
    try:
        started = time.monotonic()
        published = await relay.run(FakeClock(FIXED_NOW))
        elapsed = time.monotonic() - started
    finally:
        await tx.rollback()
        await holder.close()
    assert published == 0
    assert elapsed < 0.05, elapsed
    assert publisher.messages == []


async def test_a_token_mint_flushes_a_stranded_event_with_no_further_bookings(
    realtime_clean: None, owner_conn: asyncpg.Connection
) -> None:
    """A committed event that nothing has relayed (the trigger that should have sent it lost) is
    sent by the next token mint, once, without another booking."""
    publisher = RecordingPublisher()
    app = make_realtime_app(publisher)
    patients = await _patients(owner_conn, 1)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    holder = await asyncpg.connect(owner_dsn())
    tx = holder.transaction()
    await tx.start()
    await holder.fetchval(
        "SELECT txid FROM event_relay_cursor FOR UPDATE"
    )  # the booking's relay loses
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            resp, _ = await _book(client, patients[0], SLOTS[0])
            assert resp.status_code == 201
            assert publisher.messages == []  # stranded: committed, not relayed
    finally:
        await tx.rollback()
        await holder.close()
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        today = await owner_conn.fetchval("SELECT '2026-10-26'::date")
        minted = await client.post(
            "/realtime/token/patient",
            json={"doctor_id": OTIENO, "date": today.isoformat()},
            headers={"x-client-ip": "203.0.113.9"},
        )
        assert minted.status_code == 200, minted.text
    _published_once(publisher, 1)
    # A second mint sends nothing more.
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        await client.post(
            "/realtime/token/patient",
            json={"doctor_id": OTIENO, "date": "2026-10-26"},
            headers={"x-client-ip": "203.0.113.10"},
        )
    _published_once(publisher, 1)


async def test_nothing_is_published_while_an_older_transaction_is_open(
    realtime_clean: None, owner_conn: asyncpg.Connection
) -> None:
    """The xmin guard is unchanged: the drain never publishes early, and once the open transaction
    ends the next trigger sends everything, once."""
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
            resp, took = await _book(client, patients[0], SLOTS[0])
            assert resp.status_code == 201
            assert took < 0.5  # it does not wait for the holder
            assert publisher.messages == []  # not visible yet, so not published
            await tx.commit()
            assert (await _book(client, patients[1], SLOTS[1]))[0].status_code == 201
    finally:
        if holder.is_in_transaction():
            await tx.rollback()
        await holder.close()
    _published_once(publisher, 2)
