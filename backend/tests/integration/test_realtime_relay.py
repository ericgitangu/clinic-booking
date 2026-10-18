"""The outbox relay on the real database: order, cursor, failure, budget, the snapshot guard."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import asyncpg
import httpx
import pytest
from fastapi import FastAPI

from app.core.clock import FakeClock
from app.db.session import get_sessionmaker
from app.services.publish_budget import PublishBudget
from app.services.relay import relay_once
from tests.conftest import FIXED_NOW, owner_dsn, seeded_doctor_id, seeded_patient_id
from tests.integration.realtime_support import RecordingPublisher, make_realtime_app

pytestmark = pytest.mark.asyncio

OTIENO = str(seeded_doctor_id("otieno"))
AMINA = str(seeded_patient_id("amina"))
BRIAN = str(seeded_patient_id("brian"))
SLOT_9 = "2026-10-26T09:00:00+03:00"
SLOT_10 = "2026-10-26T10:00:00+03:00"
SLOT_11 = "2026-10-26T11:00:00+03:00"
HUGE = timedelta(days=3650)


async def _client(app: FastAPI) -> httpx.AsyncClient:
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    return httpx.AsyncClient(transport=transport, base_url="http://testserver")


async def _cursor(conn: asyncpg.Connection) -> tuple[int, int]:
    row = await conn.fetchrow("SELECT txid::text AS txid, id FROM event_relay_cursor")
    assert row is not None
    return int(row["txid"]), int(row["id"])


async def _events(conn: asyncpg.Connection) -> list[tuple[int, int]]:
    rows = await conn.fetch(
        "SELECT txid::text AS txid, id FROM appointment_events ORDER BY txid, id"
    )
    return [(int(r["txid"]), int(r["id"])) for r in rows]


def _body(patient: str = AMINA, at: str = SLOT_9) -> dict[str, str]:
    return {"doctor_id": OTIENO, "patient_id": patient, "starts_at": at}


async def test_a_booking_is_pushed_before_the_response_and_the_cursor_follows(
    realtime_clean: None, owner_conn: asyncpg.Connection
) -> None:
    publisher = RecordingPublisher()
    async with await _client(make_realtime_app(publisher)) as c:
        resp = await c.post("/appointments", json=_body())
    assert resp.status_code == 201, resp.text
    ((txid, event_id),) = await _events(owner_conn)
    assert [(m.channel.split(":")[0], m.name, m.id) for m in publisher.messages] == [
        ("slots", "slot_taken", f"{txid}.{event_id}.1"),
        ("admin", "booked", f"{txid}.{event_id}"),
    ]
    assert await _cursor(owner_conn) == (txid, event_id)


async def test_cancel_and_reschedule_push_freed_and_taken_in_order(
    realtime_clean: None, owner_conn: asyncpg.Connection
) -> None:
    publisher = RecordingPublisher()

    def patient_names() -> list[str]:
        return [m.name for m in publisher.messages if m.channel != "admin:events"]

    async with await _client(make_realtime_app(publisher)) as c:
        appt = (await c.post("/appointments", json=_body())).json()["id"]
        assert patient_names() == ["slot_taken"], "book pushed before its response"
        moved = await c.patch(f"/appointments/{appt}/reschedule", json={"starts_at": SLOT_10})
        assert moved.status_code == 200
        # The reschedule itself pushed: 09:00 freed, 10:00 taken (checked before the next write).
        assert patient_names() == ["slot_taken", "slot_freed", "slot_taken"]
        gone = await c.patch(f"/appointments/{appt}/cancel", json={"reason": "plans changed"})
        assert gone.status_code == 200
        assert patient_names() == ["slot_taken", "slot_freed", "slot_taken", "slot_freed"]
    assert [m.name for m in publisher.messages if m.channel == "admin:events"] == [
        "booked",
        "rescheduled",
        "cancelled",
    ]
    ids = [m.id for m in publisher.messages if m.channel != "admin:events"]
    assert len(set(ids)) == len(ids)
    last = (await _events(owner_conn))[-1]
    assert await _cursor(owner_conn) == last


async def test_a_failing_push_never_fails_the_booking_and_the_next_trigger_retries(
    realtime_clean: None, owner_conn: asyncpg.Connection
) -> None:
    publisher = RecordingPublisher(fail=True)
    async with await _client(make_realtime_app(publisher)) as c:
        first = await c.post("/appointments", json=_body())
        assert first.status_code == 201
        before = await _cursor(owner_conn)
        assert publisher.messages == [] and before < (await _events(owner_conn))[-1]
        publisher.fail = False
        second = await c.post("/appointments", json=_body(BRIAN, SLOT_10))
        assert second.status_code == 201
    names = [m.name for m in publisher.messages if m.channel != "admin:events"]
    assert names == ["slot_taken", "slot_taken"]  # the first event was retried, in order
    ids = [m.id for m in publisher.messages if m.channel != "admin:events"]
    assert ids == sorted(ids, key=lambda i: tuple(int(p) for p in i.split(".")))
    assert await _cursor(owner_conn) == (await _events(owner_conn))[-1]


async def test_an_unexpected_error_in_the_relay_still_returns_the_booking(
    realtime_clean: None,
) -> None:
    class Exploding(RecordingPublisher):
        async def publish(self, messages: object) -> None:
            raise RuntimeError("boom")

    async with await _client(make_realtime_app(Exploding())) as c:
        assert (await c.post("/appointments", json=_body())).status_code == 201


async def test_with_no_key_nothing_is_published_and_the_cursor_does_not_move(
    realtime_clean: None, owner_conn: asyncpg.Connection
) -> None:
    before = await _cursor(owner_conn)
    async with await _client(make_realtime_app(key=None)) as c:
        assert (await c.post("/appointments", json=_body())).status_code == 201
    assert await _cursor(owner_conn) == before


async def test_the_snapshot_guard_holds_back_events_behind_an_open_transaction(
    realtime_clean: None, owner_conn: asyncpg.Connection
) -> None:
    """Transaction A takes the lower event id and the lower txid but commits last. A reader that
    only remembered the highest id would skip A for ever; the relay waits, then sends A then B."""
    publisher = RecordingPublisher()
    a = await asyncpg.connect(owner_dsn())
    tx = a.transaction()
    await tx.start()
    try:
        appt_a = await a.fetchval(
            "INSERT INTO appointments (doctor_id, patient_id, starts_at, ends_at) "
            "VALUES ($1, $2, $3::timestamptz, $3::timestamptz + interval '30 minutes') "
            "RETURNING id",
            uuid.UUID(OTIENO),
            uuid.UUID(BRIAN),
            datetime(2026, 10, 27, 6, 0, tzinfo=UTC),
        )
        await a.execute(
            "INSERT INTO appointment_events "
            "(appointment_id, doctor_id, event_type, to_starts_at, local_date) "
            "VALUES ($1, $2, 'booked', $3, '2026-10-27')",
            appt_a,
            uuid.UUID(OTIENO),
            datetime(2026, 10, 27, 6, 0, tzinfo=UTC),
        )
        async with await _client(make_realtime_app(publisher)) as c:
            assert (await c.post("/appointments", json=_body())).status_code == 201  # B commits
        assert publisher.messages == [], "B must wait for A: A's transaction is still open"
        # The control: the naive reader (highest id seen) sees only B ...
        visible = [r["id"] for r in await owner_conn.fetch("SELECT id FROM appointment_events")]
        assert len(visible) == 1
        await tx.commit()
    except BaseException:
        await tx.rollback()
        raise
    finally:
        await a.close()
    # ... and once past B it would never see A (A.id < B.id).
    (first, second) = await _events(owner_conn)
    assert first[0] < second[0] and first[1] < second[1]

    app = make_realtime_app(publisher)
    sessionmaker = get_sessionmaker(app.state.settings)
    budget = PublishBudget(sessionmaker, 25_000)
    sent = await relay_once(sessionmaker, publisher, budget, FakeClock(FIXED_NOW), max_age=HUGE)
    assert sent.published == 4
    patient_ids = [m.id for m in publisher.messages if m.channel != "admin:events"]
    assert patient_ids == [f"{first[0]}.{first[1]}.1", f"{second[0]}.{second[1]}.1"]
    assert await _cursor(owner_conn) == second


async def test_a_backlog_larger_than_a_batch_arrives_complete_in_order_once(
    realtime_clean: None, owner_conn: asyncpg.Connection
) -> None:
    appt = await owner_conn.fetchval(
        "INSERT INTO appointments (doctor_id, patient_id, starts_at, ends_at) "
        "VALUES ($1, $2, $3::timestamptz, $3::timestamptz + interval '30 minutes') RETURNING id",
        uuid.UUID(OTIENO),
        uuid.UUID(AMINA),
        datetime(2026, 10, 28, 6, 0, tzinfo=UTC),
    )
    await owner_conn.execute(
        "INSERT INTO appointment_events "
        "(appointment_id, doctor_id, event_type, to_starts_at, local_date) "
        "SELECT $1, $2, 'booked', $3, '2026-10-28' FROM generate_series(1, 450)",
        appt,
        uuid.UUID(OTIENO),
        datetime(2026, 10, 28, 6, 0, tzinfo=UTC),
    )
    publisher = RecordingPublisher()
    app = make_realtime_app(publisher)
    sessionmaker = get_sessionmaker(app.state.settings)
    budget = PublishBudget(sessionmaker, 25_000)
    rounds = 0
    while (
        await relay_once(sessionmaker, publisher, budget, FakeClock(FIXED_NOW), max_age=HUGE)
    ).published:
        rounds += 1
        assert rounds < 10
    assert rounds == 5  # 450 events at 100 a batch
    admin_ids = [m.id for m in publisher.messages if m.channel == "admin:events"]
    expected = [f"{t}.{i}" for t, i in await _events(owner_conn)]
    assert admin_ids == expected and len(set(admin_ids)) == 450
    # Running it again publishes nothing: the cursor is past everything.
    again = await relay_once(sessionmaker, publisher, budget, FakeClock(FIXED_NOW), max_age=HUGE)
    assert again.published == 0


async def test_events_older_than_the_max_age_are_dropped_not_replayed(
    realtime_clean: None, owner_conn: asyncpg.Connection
) -> None:
    publisher = RecordingPublisher()
    app = make_realtime_app(publisher, REALTIME_MAX_EVENT_AGE_SECONDS=600)
    async with await _client(app) as c:
        # The test clock is far from the database's real clock, so this booking's event is "old".
        assert (await c.post("/appointments", json=_body())).status_code == 201
    assert publisher.messages == []
    assert await _cursor(owner_conn) == (await _events(owner_conn))[-1]  # moved past, not stuck


async def test_the_budget_stops_publishing_logs_once_and_resets_next_month(
    realtime_clean: None, owner_conn: asyncpg.Connection, capsys: pytest.CaptureFixture[str]
) -> None:
    publisher = RecordingPublisher()
    clock = FakeClock(FIXED_NOW)  # 19 October
    app = make_realtime_app(publisher, clock=clock, REALTIME_PUBLISH_CAP_PER_MONTH=3)
    async with await _client(app) as c:
        assert (await c.post("/appointments", json=_body(AMINA, SLOT_9))).status_code == 201
        assert len(publisher.messages) == 2  # one booking = a slot message and an admin message
        for patient, at in ((BRIAN, SLOT_10), (AMINA, SLOT_11)):
            assert (await c.post("/appointments", json=_body(patient, at))).status_code == 201
        assert len(publisher.messages) == 2, "2 + 2 > 3: the rest is dropped, not published"
        used = await owner_conn.fetchval("SELECT used FROM realtime_publish_budget")
        assert used == 2
        assert await _cursor(owner_conn) == (await _events(owner_conn))[-1]  # dropped, not stuck
        logged = capsys.readouterr().out.count("publish budget spent")
        assert logged == 1, "the switch is logged once per month"

        clock.set(datetime(2026, 11, 1, 0, 0, 1, tzinfo=UTC))  # the month turns
        assert (
            await c.post("/appointments", json=_body(AMINA, "2026-11-02T09:00:00+03:00"))
        ).status_code == 201
    assert len(publisher.messages) == 4, "a new month, a new budget"
    rows = await owner_conn.fetch("SELECT month, used FROM realtime_publish_budget ORDER BY month")
    assert [(r["month"].isoformat(), r["used"]) for r in rows] == [
        ("2026-10-01", 2),
        ("2026-11-01", 2),
    ]


async def test_a_push_that_never_left_this_process_gives_its_budget_back(
    realtime_clean: None, owner_conn: asyncpg.Connection
) -> None:
    from app.services.publisher import PublishError

    class Unreachable(RecordingPublisher):
        async def publish(self, messages: object) -> None:
            raise PublishError("push service unreachable", sent=False)

    async with await _client(make_realtime_app(Unreachable())) as c:
        assert (await c.post("/appointments", json=_body())).status_code == 201
    # Nothing left this process: the whole transaction, debit included, was rolled back.
    assert await owner_conn.fetchval("SELECT count(*) FROM realtime_publish_budget") == 0
    # An answer from the service may have been counted there, so that debit stays.
    async with await _client(make_realtime_app(RecordingPublisher(fail=True))) as c:
        assert (await c.post("/appointments", json=_body(BRIAN, SLOT_10))).status_code == 201
    assert await owner_conn.fetchval("SELECT used FROM realtime_publish_budget") > 0


async def test_an_admin_metrics_request_retries_events_a_failed_push_left_behind(
    realtime_clean: None, owner_conn: asyncpg.Connection
) -> None:
    from tests.integration.test_access import KEY, OWNER, _headers

    publisher = RecordingPublisher(fail=True)
    app = make_realtime_app(publisher, INTERNAL_SIGNING_KEY=KEY, ADMIN_EMAILS=OWNER)
    async with await _client(app) as c:
        assert (await c.post("/appointments", json=_body())).status_code == 201
        assert publisher.messages == []
        publisher.fail = False
        path = "/internal/admin/metrics?from=2026-10-12&to=2026-10-19"
        resp = await c.get(path, headers=_headers("GET", path, email=OWNER, role="owner"))
        assert resp.status_code == 200
    assert [m.name for m in publisher.messages] == ["slot_taken", "booked"]
    assert await _cursor(owner_conn) == (await _events(owner_conn))[-1]


# --- an outage costs each event once; the breaker; the single "spent" test ---------------------


async def _used(conn: asyncpg.Connection) -> int:
    value = await conn.fetchval("SELECT used FROM realtime_publish_budget")
    return int(value) if value is not None else 0


async def test_an_outage_debits_each_event_once_however_many_triggers_retry_it(
    realtime_clean: None, owner_conn: asyncpg.Connection
) -> None:
    publisher = RecordingPublisher(fail=True)
    clock = FakeClock(FIXED_NOW)
    # The breaker is not under test here: a huge threshold-free relay is built by hand.
    app = make_realtime_app(publisher, clock=clock)
    async with await _client(app) as c:
        assert (await c.post("/appointments", json=_body())).status_code == 201  # 1 event, 2 msgs
    sessionmaker = get_sessionmaker(app.state.settings)
    budget = PublishBudget(sessionmaker, 25_000)
    for _ in range(10):
        result = await relay_once(sessionmaker, publisher, budget, clock, max_age=HUGE)
        assert result.failed and result.published == 0
    assert await _used(owner_conn) == 2, "ten retries of the same event, one debit"
    # A second event costs its own two, once, and the first is still not charged again.
    async with await _client(app) as c:
        assert (await c.post("/appointments", json=_body(BRIAN, SLOT_10))).status_code == 201
    for _ in range(5):
        await relay_once(sessionmaker, publisher, budget, clock, max_age=HUGE)
    assert await _used(owner_conn) == 4
    publisher.fail = False
    done = await relay_once(sessionmaker, publisher, budget, clock, max_age=HUGE)
    assert done.published == 4 and not done.failed  # both events, in order, at last
    assert await _used(owner_conn) == 4
    assert await _cursor(owner_conn) == (await _events(owner_conn))[-1]


async def test_a_hanging_service_that_times_out_keeps_its_debit_once(
    realtime_clean: None, owner_conn: asyncpg.Connection
) -> None:
    publisher = RecordingPublisher(delay=30)
    app = make_realtime_app(publisher, REALTIME_RELAY_TIMEOUT_SECONDS=0.3)
    async with await _client(app) as c:
        for _ in range(3):
            assert (await c.post("/appointments", json=_body(BRIAN, SLOT_10))).status_code in (
                201,
                409,
            )
    assert await _used(owner_conn) == 2, "the batch may have been accepted over there: counted once"


async def test_the_breaker_opens_after_three_failures_and_closes_after_a_minute(
    realtime_clean: None, owner_conn: asyncpg.Connection, capsys: pytest.CaptureFixture[str]
) -> None:
    publisher = RecordingPublisher(fail=True)
    clock = FakeClock(FIXED_NOW)
    app = make_realtime_app(publisher, clock=clock)
    async with await _client(app) as c:
        assert (await c.post("/appointments", json=_body())).status_code == 201  # failure 1
        assert (await c.post("/appointments", json=_body(BRIAN, SLOT_10))).status_code == 201  # 2
        assert (await c.post("/appointments", json=_body(AMINA, SLOT_11))).status_code == 201  # 3
        calls = len(publisher.batches)
        publisher.fail = False
        # Open: further triggers do not even try, though the service has recovered.
        for patient, at in (
            (BRIAN, "2026-10-26T13:00:00+03:00"),
            (AMINA, "2026-10-26T14:00:00+03:00"),
        ):
            assert (await c.post("/appointments", json=_body(patient, at))).status_code == 201
        assert len(publisher.batches) == calls == 0
        assert capsys.readouterr().out.count("not trying again") == 1, "logged once"
        clock.set(FIXED_NOW + timedelta(seconds=59))
        assert (
            await c.post("/appointments", json=_body(BRIAN, "2026-10-26T15:00:00+03:00"))
        ).status_code == 201
        assert publisher.messages == []
        clock.set(FIXED_NOW + timedelta(seconds=61))  # closed: the next trigger goes through
        assert (
            await c.post("/appointments", json=_body(AMINA, "2026-10-26T16:00:00+03:00"))
        ).status_code == 201
    assert len(publisher.messages) == 14, "all seven events, in order, once the breaker closed"
    assert await _cursor(owner_conn) == (await _events(owner_conn))[-1]


async def test_the_breaker_resets_on_a_success(realtime_clean: None) -> None:
    publisher = RecordingPublisher(fail=True)
    clock = FakeClock(FIXED_NOW)
    app = make_realtime_app(publisher, clock=clock)
    async with await _client(app) as c:
        await c.post("/appointments", json=_body())
        await c.post("/appointments", json=_body(BRIAN, SLOT_10))
        publisher.fail = False
        await c.post("/appointments", json=_body(AMINA, SLOT_11))  # success: failures back to 0
        publisher.fail = True
        await c.post("/appointments", json=_body(BRIAN, "2026-10-26T13:00:00+03:00"))
        publisher.fail = False
        await c.post("/appointments", json=_body(AMINA, "2026-10-26T14:00:00+03:00"))
    assert len(publisher.messages) > 0, "two failures, a success, one failure: never three in a row"


@pytest.mark.parametrize(("remaining", "spent"), [(4, False), (2, False), (1, True), (0, True)])
async def test_one_test_for_spent_tokens_and_the_relay_agree_at_the_boundary(
    realtime_clean: None, owner_conn: asyncpg.Connection, remaining: int, spent: bool
) -> None:
    # The smallest event is two messages, so with fewer than two left the month counts as spent
    # for the token endpoints and for the relay alike.
    cap = 10
    await owner_conn.execute(
        "INSERT INTO realtime_publish_budget (month, used) VALUES ('2026-10-01', $1)",
        cap - remaining,
    )
    publisher = RecordingPublisher()
    app = make_realtime_app(publisher, REALTIME_PUBLISH_CAP_PER_MONTH=cap)
    async with await _client(app) as c:
        token = await c.post(
            "/realtime/token/patient",
            json={"doctor_id": OTIENO, "date": "2026-10-26"},
            headers={"x-client-ip": "203.0.113.50"},
        )
        booked = await c.post("/appointments", json=_body())
    assert booked.status_code == 201
    assert (token.status_code == 503) is spent
    assert (len(publisher.messages) == 0) is spent
