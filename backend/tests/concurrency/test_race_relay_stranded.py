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
from collections.abc import Sequence

import asyncpg
import httpx
import pytest
from fastapi import FastAPI

from app.core.clock import FakeClock
from app.db.session import get_sessionmaker
from app.domain.realtime import OutboundMessage
from app.services import relay as relay_module
from app.services.publish_budget import PublishBudget
from app.services.publisher import PublishError
from app.services.relay import Relay
from tests.conftest import FIXED_NOW, make_settings, owner_dsn, seeded_doctor_id
from tests.integration.realtime_support import RecordingPublisher, make_realtime_app
from tests.integration.test_access import KEY as SIGNING_KEY
from tests.integration.test_access import OWNER, _headers

pytestmark = pytest.mark.asyncio

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
    n: int,
    hold: float,
    conn: asyncpg.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[RecordingPublisher, float, list[tuple[bool, float]]]:
    """n bookers. The first starts a relay that holds the cursor for ``hold`` seconds while it
    publishes; the rest book while it is publishing, so their events commit after its read and
    their relays are refused the lock. Returns the publisher, the time until every response was
    back, and every relay pass as (refused the cursor?, seconds). The relay's own time is what
    "the losers never wait" is about: a booking's time is not, and on a slow runner five bookings
    at once take far longer than ``hold`` with no relay involved."""
    real = relay_module.relay_once
    passes: list[tuple[bool, float]] = []

    async def _timed(*args: object, **kwargs: object) -> relay_module.RelayResult:
        begun = time.monotonic()
        result = await real(*args, **kwargs)  # type: ignore[arg-type]  # forwarded as received
        passes.append((result.contended, time.monotonic() - begun))
        return result

    monkeypatch.setattr(relay_module, "relay_once", _timed)
    publisher = RecordingPublisher(delay=hold)
    patients = await _patients(conn, n)
    app = make_realtime_app(publisher)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        started = time.monotonic()
        first = asyncio.create_task(_book(client, patients[0], SLOTS[0]))
        # Wait until that relay is really publishing (it has read its batch and holds the cursor):
        # a fixed sleep let a slow first request lose the cursor to a later booker on a slow runner.
        try:
            await asyncio.wait_for(publisher.publishing.wait(), timeout=10)
        except TimeoutError:
            pytest.fail("the first booker's relay never started publishing within 10 s")
        rest = [asyncio.create_task(_book(client, patients[i], SLOTS[i])) for i in range(1, n)]
        done = await asyncio.gather(first, *rest)
        elapsed = time.monotonic() - started
    assert [r.status_code for r, _ in done] == [201] * n
    return publisher, elapsed, passes


def _published_once(publisher: RecordingPublisher, n: int) -> None:
    ids = [m.id for m in publisher.messages]
    assert len(ids) == len(set(ids)), "a message went out twice"
    names = Counter((m.channel.split(":")[0], m.name) for m in publisher.messages)
    assert names[("admin", "booked")] == n, names
    assert names[("slots", "slot_taken")] == n, names


async def _cursor_at_last(conn: asyncpg.Connection) -> bool:
    last = await conn.fetchrow(
        "SELECT txid::text AS txid, id FROM appointment_events ORDER BY txid DESC, id DESC LIMIT 1"
    )
    cursor = await conn.fetchrow("SELECT txid::text AS txid, id FROM event_relay_cursor")
    assert last is not None and cursor is not None
    return (cursor["txid"], cursor["id"]) == (last["txid"], last["id"])


async def _mint(app: FastAPI, ip: str) -> httpx.Response:
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        return await c.post(
            "/realtime/token/patient",
            json={"doctor_id": OTIENO, "date": "2026-10-26"},
            headers={"x-client-ip": ip},
        )


@pytest.mark.race
@pytest.mark.parametrize("hold", [0.1, 0.4, 0.6, 1.0])
@pytest.mark.parametrize("bookers", [2, 5])
async def test_every_concurrent_booking_is_published_once_within_the_cap(
    realtime_clean: None,
    owner_conn: asyncpg.Connection,
    monkeypatch: pytest.MonkeyPatch,
    bookers: int,
    hold: float,
) -> None:
    """When the holder's passes fit in the 2 s budget (publish round trip up to 0.6 s) every event
    is out when the responses are back. At 1.0 s the holder publishes what fits and STOPS before a
    pass the budget would cancel mid-publish; the rest is sent by the next trigger. In every case:
    nothing is lost, nothing goes out twice, the cursor ends at the last event, and the losers
    never wait."""
    publisher, elapsed, passes = await _race(bookers, hold, owner_conn, monkeypatch)
    assert elapsed < CAP, elapsed
    refused = [t for contended, t in passes if contended]
    held = [t for contended, t in passes if not contended and t >= hold]
    assert refused and held, passes  # there were losers, and a holder that kept the cursor
    # A loser that waited for the holder would take as long as the holder's pass. Compared with
    # the holder's own pass, not a fixed 0.1 s, so a slow runner cannot fail it.
    assert max(refused) < min(held), (hold, refused, held)
    fits = hold <= 0.6
    if fits:
        _published_once(publisher, bookers)
        assert await _cursor_at_last(owner_conn)
        return
    booked = sum(1 for m in publisher.messages if m.name == "booked")
    assert 1 <= booked < bookers, (
        "the holder sent its own batch and left the rest for the next trigger"
    )
    assert not await _cursor_at_last(owner_conn)
    # The next trigger (a token mint, as an open page would) sends the remainder, once.
    app = make_realtime_app(publisher)
    assert (await _mint(app, "203.0.113.50")).status_code == 200
    _published_once(publisher, bookers)
    assert await _cursor_at_last(owner_conn)


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
    publisher, _elapsed, _passes = await _race(5, hold, owner_conn, monkeypatch)
    booked = sum(1 for m in publisher.messages if m.name == "booked")
    assert booked < 5, "with no drain the losers' events should have been left behind"


@pytest.mark.race
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
    # Warm the pool first: the first checkout pays for opening a connection, which is not the
    # loser path and made this 50 ms bound flaky on a busy box.
    assert await relay.run(FakeClock(FIXED_NOW)) == 0
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


@pytest.mark.race
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


@pytest.mark.race
async def test_nothing_is_published_while_an_older_transaction_is_open(
    realtime_clean: None, owner_conn: asyncpg.Connection, capsys: pytest.CaptureFixture[str]
) -> None:
    """The xmin guard is unchanged: the drain never publishes early, and once the open transaction
    ends the next trigger sends everything, once. A transaction that never ends costs a booking at
    most the bounded wait. The relay says so at the default log level: a trigger that left an event
    unsent logs a warning with the reason, and the trigger that sends it logs what it published."""
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
            # It waits for the open transaction only up to the relay's bound, never for good.
            assert took < relay_module.HORIZON_WAIT + 0.5
            assert publisher.messages == []  # not visible yet, so not published
            # The app configures its own JSON handler on stdout (caplog's handler is replaced), so
            # the log is read from what it printed.
            out = capsys.readouterr().out
            left = [ln for ln in out.splitlines() if "left events unsent" in ln]
            assert len(left) == 1 and '"WARNING"' in left[0] and "held_back" in left[0], out
            await tx.commit()
            assert (await _book(client, patients[1], SLOTS[1]))[0].status_code == 201
            out = capsys.readouterr().out
            sent = [ln for ln in out.splitlines() if "relay published" in ln]
            assert len(sent) == 1 and "published 4 messages" in sent[0], out
            assert "left events unsent" not in out
    finally:
        if holder.is_in_transaction():
            await tx.rollback()
        await holder.close()
    _published_once(publisher, 2)


@pytest.mark.race
async def test_an_admin_token_mint_flushes_a_stranded_event_too(
    realtime_clean: None, owner_conn: asyncpg.Connection
) -> None:
    publisher = RecordingPublisher()
    app = make_realtime_app(publisher, INTERNAL_SIGNING_KEY=SIGNING_KEY, ADMIN_EMAILS=OWNER)
    patients = await _patients(owner_conn, 1)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    holder = await asyncpg.connect(owner_dsn())
    tx = holder.transaction()
    await tx.start()
    await holder.fetchval("SELECT txid FROM event_relay_cursor FOR UPDATE")
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
            assert (await _book(c, patients[0], SLOTS[0]))[0].status_code == 201
            assert publisher.messages == []  # stranded: committed, not relayed
    finally:
        await tx.rollback()
        await holder.close()
    path = "/internal/realtime/token/admin"
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        minted = await c.post(path, headers=_headers("POST", path, email=OWNER, role="owner"))
        assert minted.status_code == 200, minted.text
        again = await c.post(path, headers=_headers("POST", path, email=OWNER, role="owner"))
        assert again.status_code == 200
    _published_once(publisher, 1)


class _FlakyPublisher(RecordingPublisher):
    """Succeeds on its first call (and, in that call, commits one more event, as another writer
    would while the holder publishes), then fails the second call with a response that may have
    been counted over there."""

    def __init__(self, conn: asyncpg.Connection, patient: str) -> None:
        super().__init__()
        self.conn, self.patient, self.calls = conn, patient, 0

    async def publish(self, messages: Sequence[OutboundMessage]) -> None:
        self.calls += 1
        if self.calls == 1:
            await super().publish(messages)
            appt = uuid.uuid4()
            await self.conn.execute(
                "INSERT INTO appointments (id, doctor_id, patient_id, starts_at, ends_at) "
                "VALUES ($1, $2, $3, '2026-10-27 06:00+00', '2026-10-27 06:30+00')",
                appt,
                uuid.UUID(OTIENO),
                uuid.UUID(self.patient),
            )
            await self.conn.execute(
                "INSERT INTO appointment_events (appointment_id, doctor_id, event_type, "
                "to_starts_at, local_date, occurred_at) VALUES ($1, $2, 'booked', "
                "'2026-10-27 06:00+00', '2026-10-27', $3)",
                appt,
                uuid.UUID(OTIENO),
                FIXED_NOW,
            )
            return
        if self.calls == 2:
            raise PublishError("push service answered 503", sent=True)
        await super().publish(messages)


@pytest.mark.race
async def test_a_failure_in_a_later_pass_keeps_what_the_earlier_pass_sent(
    realtime_clean: None, owner_conn: asyncpg.Connection
) -> None:
    """Pass 1 sends event A; during it event B commits; pass 2 fails. The trigger returns A's
    messages (not 0), counts ONE breaker failure, leaves the cursor at A with B's debit kept (the
    answer may have been counted), and the next trigger sends B once without debiting it again."""
    patients = await _patients(owner_conn, 2)
    settings = make_settings(REALTIME_MAX_EVENT_AGE_SECONDS=10**9)
    sessionmaker = get_sessionmaker(settings)
    publisher = _FlakyPublisher(owner_conn, patients[1])
    relay = Relay(sessionmaker, publisher, PublishBudget(sessionmaker, 25_000), settings)
    # Event A, committed before the trigger.
    appt = uuid.uuid4()
    await owner_conn.execute(
        "INSERT INTO appointments (id, doctor_id, patient_id, starts_at, ends_at) "
        "VALUES ($1, $2, $3, '2026-10-26 06:00+00', '2026-10-26 06:30+00')",
        appt, uuid.UUID(OTIENO), uuid.UUID(patients[0]),
    )  # fmt: skip
    await owner_conn.execute(
        "INSERT INTO appointment_events (appointment_id, doctor_id, event_type, to_starts_at, "
        "local_date, occurred_at) VALUES ($1, $2, 'booked', '2026-10-26 06:00+00', "
        "'2026-10-26', $3)",
        appt, uuid.UUID(OTIENO), FIXED_NOW,
    )  # fmt: skip
    clock = FakeClock(FIXED_NOW)

    returned = await relay.run(clock)
    assert returned == 2  # A's slot message and admin message: the success is not hidden
    assert relay._failures == 1  # one breaker failure for the failed pass 2
    assert [m.name for m in publisher.messages] == ["slot_taken", "booked"]
    used_after_failure = await owner_conn.fetchval("SELECT used FROM realtime_publish_budget")
    assert used_after_failure == 4  # A's 2 and B's 2, B's kept because the answer may have counted
    assert not await _cursor_at_last(owner_conn)  # the cursor is at A, B is still owed

    returned = await relay.run(clock)  # the push works again
    assert returned == 2 and relay._failures == 0
    assert [m.name for m in publisher.messages] == ["slot_taken", "booked", "slot_taken", "booked"]
    assert len({m.id for m in publisher.messages}) == 4  # each of the four exactly once
    assert await owner_conn.fetchval("SELECT used FROM realtime_publish_budget") == 4  # no re-debit
    assert await _cursor_at_last(owner_conn)


@pytest.mark.race
async def test_an_event_that_commits_during_the_holders_last_empty_pass_is_still_sent(
    realtime_clean: None, owner_conn: asyncpg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The holder's final pass finds nothing and still holds the cursor row when another booking
    commits its event; that booking's relay is refused the row and returns. Nothing triggers
    again, yet both events must be published by the time the first request is done."""
    publisher = RecordingPublisher()
    patients = await _patients(owner_conn, 2)
    app = make_realtime_app(publisher)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    real = relay_module._relay_in
    state = {"calls": 0, "inside": False}

    async def _relay_in(*args: object, **kwargs: object) -> relay_module.RelayResult:
        result = await real(*args, **kwargs)  # type: ignore[arg-type]  # forwarded as received
        if state["inside"]:
            return result
        state["calls"] += 1
        if state["calls"] == 2:  # the holder's empty pass: the row is still locked
            assert result.consumed == 0 and not result.contended
            state["inside"] = True
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
                resp, _ = await _book(c, patients[1], SLOTS[1])
            state["inside"] = False
            assert resp.status_code == 201
        return result

    monkeypatch.setattr(relay_module, "_relay_in", _relay_in)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        first, _ = await _book(client, patients[0], SLOTS[0])
    assert first.status_code == 201
    assert state["calls"] >= 2
    _published_once(publisher, 2)
    assert await _cursor_at_last(owner_conn)


@pytest.mark.race
@pytest.mark.parametrize("ends", ["commit", "rollback"])
async def test_an_event_behind_an_older_open_transaction_is_sent_when_that_transaction_ends(
    realtime_clean: None, owner_conn: asyncpg.Connection, ends: str
) -> None:
    """The ``xmin`` guard holds back an event while an OLDER transaction is still open (it could
    still commit an earlier event). When that transaction ends by a rollback, as a lost booking
    race does, nothing triggers a relay, so the event used to wait for the next unrelated trigger.
    The holder now waits out the older transaction (a short, bounded wait, only when a committed
    event is owed) and sends it within the same request."""
    publisher = RecordingPublisher()
    patients = await _patients(owner_conn, 1)
    older = await asyncpg.connect(owner_dsn())
    tx = older.transaction()
    await tx.start()
    await older.fetchval("SELECT txid_current()")  # an xid older than the booking's

    async def _end_later() -> None:
        await asyncio.sleep(0.1)
        await (tx.commit() if ends == "commit" else tx.rollback())

    app = make_realtime_app(publisher)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    ender = asyncio.create_task(_end_later())
    try:
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            started = time.monotonic()
            resp, _ = await _book(client, patients[0], SLOTS[0])
            elapsed = time.monotonic() - started
        await ender
    finally:
        await older.close()
    assert resp.status_code == 201
    assert elapsed < CAP, elapsed
    _published_once(publisher, 1)
    assert await _cursor_at_last(owner_conn)


@pytest.mark.race
async def test_a_pass_that_ran_out_of_time_is_finished_by_the_next_availability_read(
    realtime_clean: None,
    owner_conn: asyncpg.Connection,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A slow publish (1.0 s, against the 2 s budget) makes the holder stop before another pass and
    leave the other bookers' events. Nothing else is booked, no token is minted: a plain read of
    the availability list (what an open page's poll is) sends them, once, and says so."""
    publisher, _elapsed, _passes = await _race(5, 1.0, owner_conn, monkeypatch)
    booked = sum(1 for m in publisher.messages if m.name == "booked")
    assert 1 <= booked < 5, "the budget should have left events behind"
    assert not await _cursor_at_last(owner_conn)
    assert "left events unsent (time)" in capsys.readouterr().out
    publisher.delay = 0  # the follow-up must not depend on a slow service
    app = make_realtime_app(publisher)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        got = await client.get(f"/doctors/{OTIENO}/availability", params={"date": "2026-10-26"})
    assert got.status_code == 200
    _published_once(publisher, 5)
    assert await _cursor_at_last(owner_conn)
    # A read with nothing owed sends nothing more.
    sent = len(publisher.messages)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        await client.get(f"/doctors/{OTIENO}/availability", params={"date": "2026-10-26"})
    assert len(publisher.messages) == sent
