"""Reminder claims with a lease, marking sent, rescheduling, the system gate, the daily budget."""

from __future__ import annotations

import asyncio
import secrets
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import asyncpg
import httpx
import pytest
import pytest_asyncio

from app.api.deps import SYSTEM_SUB, get_clock
from app.core.assertion import AUDIENCE, body_hash, sign
from app.core.clock import Clock
from app.main import create_app
from tests.conftest import FIXED_NOW, make_settings, seeded_doctor_id

pytestmark = pytest.mark.asyncio

KEY = secrets.token_hex(24)  # fresh per run: a throwaway key, never a literal
# FIXED_NOW is Monday 19 Oct 2026, 07:00 in Nairobi, so the run's "tomorrow" is Tuesday the 20th.
TOMORROW = "2026-10-20"


class MovableClock:
    def __init__(self, now: datetime) -> None:
        self.current = now

    def now(self) -> datetime:
        return self.current


@pytest_asyncio.fixture
async def clock() -> MovableClock:
    return MovableClock(FIXED_NOW)


@pytest_asyncio.fixture
async def clean(owner_conn: asyncpg.Connection) -> AsyncIterator[None]:
    await owner_conn.execute("TRUNCATE appointment_events, appointments RESTART IDENTITY CASCADE")
    await owner_conn.execute("TRUNCATE email_counter, email_month_counter")
    yield
    await owner_conn.execute("TRUNCATE email_counter, email_month_counter")


def _app(clock: MovableClock, **overrides: object) -> httpx.AsyncClient:
    app = create_app(make_settings(INTERNAL_SIGNING_KEY=KEY, **overrides))
    app.dependency_overrides[get_clock] = lambda: clock
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    return httpx.AsyncClient(transport=transport, base_url="http://testserver")


@pytest_asyncio.fixture
async def api(clock: MovableClock) -> AsyncIterator[httpx.AsyncClient]:
    async with _app(clock) as c:
        yield c


def _headers(
    method: str,
    path: str,
    clock: Clock,
    *,
    role: str = "system",
    sub: str = SYSTEM_SUB,
    body: bytes = b"",
) -> dict[str, str]:
    at = clock.now()
    claims: dict[str, object] = {
        "aud": AUDIENCE,
        "sub": sub,
        "email": "reminders@clinic.example",
        "role": role,
        "iat": int(at.timestamp()),
        "exp": int(at.timestamp()) + 60,
        "m": method,
        "p": path,
        "bh": body_hash(body),
        "ev": True,
    }
    return {"X-Internal-Assertion": sign(claims, KEY.encode()), "content-type": "application/json"}


async def internal(
    api: httpx.AsyncClient,
    clock: Clock,
    method: str,
    path: str,
    *,
    json_body: str | None = None,
    **kw: str,
) -> httpx.Response:
    body = json_body.encode() if json_body else b""
    return await api.request(
        method, path, headers=_headers(method, path, clock, body=body, **kw), content=body or None
    )


async def mark_sent(
    api: httpx.AsyncClient, clock: Clock, appointment_id: str, item: dict[str, str], **kw: str
) -> httpx.Response:
    """Report a reminder as sent, quoting the claim it was sent under."""
    body = f'{{"claimed_at":"{item["claimed_at"]}","starts_at":"{item["starts_at"]}"}}'
    return await internal(
        api, clock, "POST", f"/internal/reminders/{appointment_id}/sent", json_body=body, **kw
    )


async def make_patient(
    owner_conn: asyncpg.Connection, email: str | None, *, linked: bool = True
) -> uuid.UUID:
    """A patient. ``linked`` means a verified Google account was linked to it (the only kind that is
    ever emailed); an unlinked one is what the public API creates, with any address typed in."""
    pid = uuid.uuid4()
    await owner_conn.execute(
        "INSERT INTO patients (id, full_name, email) VALUES ($1, $2, $3)",
        pid,
        f"P {pid.hex[:6]}",
        email,
    )
    if linked and email is not None:
        await owner_conn.execute(
            "INSERT INTO patient_accounts (google_sub, patient_id, email) VALUES ($1, $2, $3)",
            f"sub-{pid.hex}",
            pid,
            email,
        )
    return pid


async def book(
    api: httpx.AsyncClient, patient: uuid.UUID, starts_at: str, doctor: str = "otieno"
) -> dict[str, str]:
    resp = await api.post(
        "/appointments",
        json={
            "doctor_id": str(seeded_doctor_id(doctor)),
            "patient_id": str(patient),
            "starts_at": starts_at,
        },
    )
    assert resp.status_code == 201, resp.text
    out: dict[str, str] = resp.json()
    return out


def slot(day: str, hhmm: str) -> str:
    return f"{day}T{hhmm}:00+03:00"


async def claim(api: httpx.AsyncClient, clock: Clock, query: str = "") -> httpx.Response:
    return await internal(api, clock, "POST", f"/internal/reminders/claim{query}")


async def test_a_run_claims_tomorrows_booked_appointments_for_patients_with_an_email(
    api: httpx.AsyncClient, clean: None, clock: MovableClock, owner_conn: asyncpg.Connection
) -> None:
    with_email = await make_patient(owner_conn, "pat@example.test")
    no_email = await make_patient(owner_conn, None)
    a = await book(api, with_email, slot(TOMORROW, "09:00"))
    await book(api, no_email, slot(TOMORROW, "09:30"))
    cancelled = await book(api, with_email, slot(TOMORROW, "10:00"))
    await api.patch(f"/appointments/{cancelled['id']}/cancel", json={"reason": "not coming"})
    await book(api, with_email, slot("2026-10-21", "09:00"))  # the day after tomorrow

    resp = await claim(api, clock)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["date"] == TOMORROW
    assert [i["appointment_id"] for i in body["items"]] == [a["id"]]
    assert body["items"][0]["patient_email"] == "pat@example.test"
    assert body["items"][0]["doctor_name"]
    assert body["sent_today"] == 0 and body["daily_limit"] == 100


async def test_the_claim_is_a_lease_and_a_sent_reminder_is_never_claimed_again(
    api: httpx.AsyncClient, clean: None, clock: MovableClock, owner_conn: asyncpg.Connection
) -> None:
    pid = await make_patient(owner_conn, "pat@example.test")
    a = await book(api, pid, slot(TOMORROW, "09:00"))

    first = await claim(api, clock)
    assert [i["appointment_id"] for i in first.json()["items"]] == [a["id"]]
    # a second run while the lease is live gets nothing (a double delivery of the schedule)
    assert (await claim(api, clock)).json()["items"] == []
    # the run failed and never marked it sent: once the lease has expired it is taken again
    clock.current = FIXED_NOW + timedelta(minutes=16)
    again = await claim(api, clock)
    assert [i["appointment_id"] for i in again.json()["items"]] == [a["id"]]

    marked = await mark_sent(api, clock, a["id"], again.json()["items"][0])
    assert marked.status_code == 200 and marked.json() == {"appointment_id": a["id"], "sent": True}
    clock.current = FIXED_NOW + timedelta(hours=2)
    assert (await claim(api, clock)).json()["items"] == []
    # marking twice is harmless
    again_marked = await mark_sent(api, clock, a["id"], again.json()["items"][0])
    assert again_marked.status_code == 200 and again_marked.json()["sent"] is False


async def test_rescheduling_clears_the_reminder_so_the_new_time_is_reminded(
    api: httpx.AsyncClient, clean: None, clock: MovableClock, owner_conn: asyncpg.Connection
) -> None:
    pid = await make_patient(owner_conn, "pat@example.test")
    a = await book(api, pid, slot(TOMORROW, "09:00"))
    claimed = await claim(api, clock)
    await mark_sent(api, clock, a["id"], claimed.json()["items"][0])
    row = await owner_conn.fetchrow(
        "SELECT reminder_claimed_at, reminder_sent_at FROM appointments WHERE id = $1",
        uuid.UUID(a["id"]),
    )
    assert row is not None and row["reminder_sent_at"] is not None

    moved = await api.patch(
        f"/appointments/{a['id']}/reschedule", json={"starts_at": slot(TOMORROW, "11:00")}
    )
    assert moved.status_code == 200
    row = await owner_conn.fetchrow(
        "SELECT reminder_claimed_at, reminder_sent_at FROM appointments WHERE id = $1",
        uuid.UUID(a["id"]),
    )
    assert (
        row is not None and row["reminder_claimed_at"] is None and row["reminder_sent_at"] is None
    )
    again = await claim(api, clock)
    assert [i["appointment_id"] for i in again.json()["items"]] == [a["id"]]


async def test_a_cancelled_appointment_is_not_reminded_even_if_it_was_claimed(
    api: httpx.AsyncClient, clean: None, clock: MovableClock, owner_conn: asyncpg.Connection
) -> None:
    pid = await make_patient(owner_conn, "pat@example.test")
    a = await book(api, pid, slot(TOMORROW, "09:00"))
    await claim(api, clock)
    await api.patch(f"/appointments/{a['id']}/cancel", json={"reason": "plans changed"})
    clock.current = FIXED_NOW + timedelta(minutes=20)
    assert (await claim(api, clock)).json()["items"] == []


async def test_two_runs_at_once_never_claim_the_same_appointment(
    api: httpx.AsyncClient, clean: None, clock: MovableClock, owner_conn: asyncpg.Connection
) -> None:
    pid = await make_patient(owner_conn, "pat@example.test")
    times = ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30"]
    ids = {(await book(api, pid, slot(TOMORROW, t)))["id"] for t in times}
    results = await asyncio.gather(*(claim(api, clock, "?limit=3") for _ in range(4)))
    claimed = [i["appointment_id"] for r in results for i in r.json()["items"]]
    assert len(claimed) == len(set(claimed)), "an appointment was claimed twice"
    assert set(claimed) == ids


async def test_the_run_limit_applies(
    api: httpx.AsyncClient, clean: None, clock: MovableClock, owner_conn: asyncpg.Connection
) -> None:
    pid = await make_patient(owner_conn, "pat@example.test")
    for t in ["09:00", "09:30", "10:00"]:
        await book(api, pid, slot(TOMORROW, t))
    first = await claim(api, clock, "?limit=2")
    assert len(first.json()["items"]) == 2
    rest = await claim(api, clock, "?limit=2")
    assert len(rest.json()["items"]) == 1


async def reserve(api: httpx.AsyncClient, clock: Clock, **kw: str) -> httpx.Response:
    return await internal(
        api, clock, "POST", "/internal/emails/reserve", **{"role": "patient", "sub": "sub-x", **kw}
    )


async def budget(api: httpx.AsyncClient, clock: Clock) -> dict[str, object]:
    resp = await internal(api, clock, "GET", "/internal/emails/today", role="patient", sub="sub-x")
    assert resp.status_code == 200, resp.text
    out: dict[str, object] = resp.json()
    return out


async def test_the_daily_budget_counts_every_email_and_shrinks_the_run(
    clean: None, clock: MovableClock, owner_conn: asyncpg.Connection
) -> None:
    async with _app(clock, EMAIL_DAILY_LIMIT=3, EMAIL_ACK_RESERVE=0) as api:
        pid = await make_patient(owner_conn, "pat@example.test")
        for t in ["09:00", "09:30", "10:00"]:
            await book(api, pid, slot(TOMORROW, t))
        # two acknowledgements were already sent today
        for _ in range(2):
            assert (await reserve(api, clock)).json()["granted"] is True
        assert await budget(api, clock) == {
            "day": "2026-10-19",
            "sent": 2,
            "daily_limit": 3,
            "month": "2026-10-01",
            "month_sent": 2,
            "monthly_limit": 3000,
            "remaining": 1,
        }
        batch = await claim(api, clock)
        assert len(batch.json()["items"]) == 1, "only what is left of the day may be claimed"
        assert batch.json()["sent_today"] == 2
        assert (await reserve(api, clock)).json()["granted"] is True
        empty = await claim(api, clock)
        assert empty.json()["items"] == []
        assert (await budget(api, clock))["remaining"] == 0


async def test_the_counter_is_per_utc_day(
    api: httpx.AsyncClient, clean: None, clock: MovableClock
) -> None:
    await reserve(api, clock)
    clock.current = FIXED_NOW + timedelta(days=1)
    today = await budget(api, clock)
    assert today["sent"] == 0 and today["day"] == "2026-10-20"
    assert today["month_sent"] == 1, "the month carries over from one day to the next"


async def test_a_refusal_names_the_cap_and_moves_neither_counter(
    clean: None, clock: MovableClock
) -> None:
    async with _app(clock, EMAIL_DAILY_LIMIT=5, EMAIL_MONTHLY_LIMIT=2, EMAIL_ACK_RESERVE=0) as api:
        for _ in range(2):
            assert (await reserve(api, clock)).json()["granted"] is True
        refused = (await reserve(api, clock)).json()
        assert refused["granted"] is False and refused["reason"] == "month"
        assert (await budget(api, clock))["sent"] == 2
    async with _app(clock, EMAIL_DAILY_LIMIT=2, EMAIL_MONTHLY_LIMIT=10, EMAIL_ACK_RESERVE=0) as api:
        # the day is already at 2 (from above): the day refuses, and the month it had already
        # incremented in the same attempt is rolled back, so the month still reads 2
        refused = (await reserve(api, clock)).json()
        assert refused["granted"] is False and refused["reason"] == "day"
        today = await budget(api, clock)
        assert today["sent"] == 2 and today["month_sent"] == 2


async def test_the_month_rolls_over_with_the_clock_and_a_release_gives_one_back(
    clean: None, clock: MovableClock
) -> None:
    async with _app(clock, EMAIL_DAILY_LIMIT=5, EMAIL_MONTHLY_LIMIT=2, EMAIL_ACK_RESERVE=0) as api:
        first = (await reserve(api, clock)).json()
        assert (await reserve(api, clock)).json()["granted"] is True
        assert (await reserve(api, clock)).json()["granted"] is False  # October is spent
        # a send that failed gives its email back, to the day and month it was taken from
        released = await internal(
            api,
            clock,
            "POST",
            "/internal/emails/release",
            json_body=f'{{"day":"{first["day"]}","month":"{first["month"]}"}}',
            role="patient",
            sub="sub-x",
        )
        assert released.status_code == 200 and released.json()["month_sent"] == 1
        assert (await reserve(api, clock)).json()["granted"] is True
        assert (await reserve(api, clock)).json()["granted"] is False
        # 1 November (UTC) starts a new month, with a new day as well
        clock.current = datetime(2026, 11, 1, 0, 0, 1, tzinfo=UTC)
        nov = (await reserve(api, clock)).json()
        assert nov["granted"] is True and nov["month"] == "2026-11-01"
        assert nov["budget"]["month_sent"] == 1 and nov["budget"]["sent"] == 1


async def test_only_the_system_caller_may_run_reminders(
    api: httpx.AsyncClient, clean: None, clock: MovableClock
) -> None:
    anon = await api.post("/internal/reminders/claim")
    assert anon.status_code == 401
    for role, sub in [("owner", "sub-o"), ("patient", "sub-p"), ("system", "someone-else")]:
        resp = await claim_as(api, clock, role, sub)
        assert resp.status_code == 403, (role, resp.text)
    item = {"claimed_at": "2026-10-19T07:00:00+03:00", "starts_at": "2026-10-20T09:00:00+03:00"}
    marked = await mark_sent(api, clock, str(uuid.uuid4()), item, role="patient", sub="sub-p")
    assert marked.status_code == 403


async def claim_as(api: httpx.AsyncClient, clock: Clock, role: str, sub: str) -> httpx.Response:
    return await internal(api, clock, "POST", "/internal/reminders/claim", role=role, sub=sub)


async def test_rehearsing_for_a_date_and_refusing_today_or_the_past(
    api: httpx.AsyncClient, clean: None, clock: MovableClock, owner_conn: asyncpg.Connection
) -> None:
    pid = await make_patient(owner_conn, "pat@example.test")
    a = await book(api, pid, slot("2026-10-22", "09:00"))
    ok = await claim(api, clock, "?on=2026-10-22")
    assert [i["appointment_id"] for i in ok.json()["items"]] == [a["id"]]
    for bad in ("2026-10-19", "2026-10-01"):
        refused = await claim(api, clock, f"?on={bad}")
        assert refused.status_code == 422 and refused.json()["code"] == "DATE_OUT_OF_RANGE"


async def test_marking_an_unknown_appointment_sent_is_not_found(
    api: httpx.AsyncClient, clean: None, clock: MovableClock
) -> None:
    item = {"claimed_at": "2026-10-19T07:00:00+03:00", "starts_at": "2026-10-20T09:00:00+03:00"}
    resp = await mark_sent(api, clock, str(uuid.uuid4()), item)
    assert resp.status_code == 404 and resp.json()["code"] == "APPOINTMENT_NOT_FOUND"


async def test_an_address_typed_into_the_public_api_is_never_emailed(
    api: httpx.AsyncClient, clean: None, clock: MovableClock, owner_conn: asyncpg.Connection
) -> None:
    """Only a patient with a linked, verified Google account gets reminders. The public API accepts
    any address, so a reminder to one would let anyone make us mail strangers and use up the day."""
    stranger = await make_patient(owner_conn, "victim@example.test", linked=False)
    await book(api, stranger, slot(TOMORROW, "09:00"))
    batch = await claim(api, clock)
    assert batch.json()["items"] == []
    # nothing was claimed either, so the row stays untouched
    claimed = await owner_conn.fetchval(
        "SELECT count(*) FROM appointments WHERE reminder_claimed_at IS NOT NULL"
    )
    assert claimed == 0
    # the same address, once its owner has signed in and linked it, is reminded
    linked = await make_patient(owner_conn, "owner@example.test")
    a = await book(api, linked, slot(TOMORROW, "09:30"))
    again = await claim(api, clock)
    assert [i["appointment_id"] for i in again.json()["items"]] == [a["id"]]
    assert again.json()["items"][0]["patient_email"] == "owner@example.test"


async def test_the_email_used_is_the_one_the_account_was_linked_with(
    api: httpx.AsyncClient, clean: None, clock: MovableClock, owner_conn: asyncpg.Connection
) -> None:
    pid = await make_patient(owner_conn, "linked@example.test")
    await owner_conn.execute("UPDATE patients SET email = 'edited@example.test' WHERE id = $1", pid)
    await book(api, pid, slot(TOMORROW, "09:00"))
    items = (await claim(api, clock)).json()["items"]
    assert items[0]["patient_email"] == "linked@example.test"


async def test_a_late_sent_for_the_old_claim_does_not_suppress_the_moved_reminder(
    api: httpx.AsyncClient, clean: None, clock: MovableClock, owner_conn: asyncpg.Connection
) -> None:
    pid = await make_patient(owner_conn, "pat@example.test")
    a = await book(api, pid, slot(TOMORROW, "09:00"))
    stale = (await claim(api, clock)).json()["items"][0]
    # the patient moves the appointment while the email is still being sent
    moved = await api.patch(
        f"/appointments/{a['id']}/reschedule", json={"starts_at": slot(TOMORROW, "11:00")}
    )
    assert moved.status_code == 200
    # ... and the run then reports the old email as sent
    late = await mark_sent(api, clock, a["id"], stale)
    assert late.status_code == 200 and late.json()["sent"] is False
    row = await owner_conn.fetchrow(
        "SELECT reminder_sent_at FROM appointments WHERE id = $1", uuid.UUID(a["id"])
    )
    assert row is not None and row["reminder_sent_at"] is None
    fresh = (await claim(api, clock)).json()["items"]
    assert [i["appointment_id"] for i in fresh] == [a["id"]]
    assert fresh[0]["starts_at"].startswith(f"{TOMORROW}T11:00")
    # a "sent" quoting a different claim time is also ignored; the right one counts
    wrong = dict(fresh[0], claimed_at="2026-10-19T06:59:00+03:00")
    assert (await mark_sent(api, clock, a["id"], wrong)).json()["sent"] is False
    assert (await mark_sent(api, clock, a["id"], fresh[0])).json()["sent"] is True


async def test_an_unsent_reminder_is_still_due_later_the_same_day_and_never_after_it_started(
    api: httpx.AsyncClient, clean: None, clock: MovableClock, owner_conn: asyncpg.Connection
) -> None:
    """Tomorrow's run covers everything still ahead up to the end of tomorrow, so a reminder that
    could not be sent on an earlier run is tried again while the appointment is still to come."""
    pid = await make_patient(owner_conn, "pat@example.test")
    later_today = await book(api, pid, slot("2026-10-19", "16:00"))
    tomorrow = await book(api, pid, slot(TOMORROW, "09:00"))
    await book(api, pid, slot("2026-10-21", "09:00"))  # beyond tomorrow: not yet
    first = {i["appointment_id"] for i in (await claim(api, clock)).json()["items"]}
    assert first == {later_today["id"], tomorrow["id"]}
    # the run failed to send; once the lease has passed a later run (the clock moved on) retries
    clock.current = FIXED_NOW + timedelta(hours=3)  # 10:00 in Nairobi, today's 16:00 still ahead
    retry = {i["appointment_id"] for i in (await claim(api, clock)).json()["items"]}
    assert retry == {later_today["id"], tomorrow["id"]}
    # an appointment that has already started is no longer reminded
    clock.current = FIXED_NOW + timedelta(hours=10)  # 17:00 in Nairobi, today's 16:00 has begun
    late = {i["appointment_id"] for i in (await claim(api, clock)).json()["items"]}
    assert late == {tomorrow["id"]}


async def test_the_acknowledgement_reserve_keeps_room_and_the_cap_is_logged(
    clean: None,
    clock: MovableClock,
    owner_conn: asyncpg.Connection,
    capsys: pytest.CaptureFixture[str],
) -> None:
    async with _app(clock, EMAIL_DAILY_LIMIT=10, EMAIL_ACK_RESERVE=4) as api:
        pid = await make_patient(owner_conn, "pat@example.test")
        for t in ["09:00", "09:30", "10:00", "10:30", "11:00"]:
            await book(api, pid, slot(TOMORROW, t))
        for _ in range(3):
            assert (await reserve(api, clock)).json()["granted"] is True
        batch = await claim(api, clock)
        # 10 a day, 3 sent, 4 kept back for acknowledgements: 3 reminders may go
        assert len(batch.json()["items"]) == 3
        # the application logs to stdout as one JSON line per event
        assert "reminder claim limited by the email budget" in capsys.readouterr().out


@pytest.mark.parametrize("zone", ["Europe/Berlin"])
async def test_each_claimed_reminder_carries_its_own_clinics_zone(
    api: httpx.AsyncClient,
    clean: None,
    clock: MovableClock,
    owner_conn: asyncpg.Connection,
    other_clinic: uuid.UUID,
    zone: str,
) -> None:
    """The email shows the time in the clinic's own zone, so a claim names that zone and renders its
    instants in that offset: Berlin is on CET (+01:00) on Monday 26 Oct, Nairobi stays at +03:00."""
    day = "2026-10-26"
    pid = await make_patient(owner_conn, "pat@example.test")
    nairobi = await book(api, pid, slot(day, "09:00"))
    berlin = await api.post(
        "/appointments",
        json={
            "doctor_id": str(other_clinic),
            "patient_id": str(pid),
            "starts_at": f"{day}T08:00:00+01:00",
        },
    )
    assert berlin.status_code == 201, berlin.text

    items = (await claim(api, clock, f"?on={day}")).json()["items"]
    by_id = {i["appointment_id"]: i for i in items}
    assert set(by_id) == {nairobi["id"], berlin.json()["id"]}
    assert by_id[nairobi["id"]]["timezone"] == "Africa/Nairobi"
    assert by_id[nairobi["id"]]["starts_at"] == f"{day}T09:00:00+03:00"
    assert by_id[berlin.json()["id"]]["timezone"] == zone
    assert by_id[berlin.json()["id"]]["starts_at"] == f"{day}T08:00:00+01:00"
    assert by_id[berlin.json()["id"]]["claimed_at"] == "2026-10-19T06:00:00+02:00"
    # The claim time is in the clinic zone too (CEST that day); "sent" quotes it as handed out.
    marked = await mark_sent(api, clock, berlin.json()["id"], by_id[berlin.json()["id"]])
    assert marked.json()["sent"] is True
