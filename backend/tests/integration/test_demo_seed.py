"""The demo seed on the real database: constraints, idempotence, the stated bands, and what the
admin views show (demo rows yes, synthetic rows no)."""

from __future__ import annotations

import re
import secrets
import uuid
from collections.abc import AsyncIterator
from datetime import date, timedelta

import asyncpg
import httpx
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import create_async_engine

from app.api.deps import get_clock
from app.core.assertion import AUDIENCE, body_hash, sign
from app.core.clock import FakeClock
from app.main import create_app
from app.scripts.demo_data import PEOPLE
from app.scripts.seed_demo import apply, build_plan
from tests.conftest import FIXED_NOW, make_settings, owner_sqlalchemy_url

pytestmark = pytest.mark.asyncio

TODAY = date(2026, 10, 19)  # the day FIXED_NOW falls on, clinic time
KEY = secrets.token_hex(24)
OWNER = "owner@clinic.example"
SYNTHETIC = uuid.UUID("00000000-0000-4000-8000-0000000007a1")


async def _wipe(conn: asyncpg.Connection) -> None:
    await conn.execute("TRUNCATE appointment_events, appointments RESTART IDENTITY CASCADE")
    await conn.execute("DELETE FROM patients WHERE demo OR id = $1", SYNTHETIC)


async def _counts(conn: asyncpg.Connection) -> list[int]:
    return [
        await conn.fetchval("SELECT count(*) FROM appointment_attendance"),
        await conn.fetchval("SELECT count(*) FROM staff_action_audit"),
        await conn.fetchval("SELECT count(*) FROM patients"),
        await conn.fetchval("SELECT count(*) FROM appointments"),
        await conn.fetchval("SELECT count(*) FROM appointment_events"),
    ]


async def _run_apply() -> dict[str, int]:
    engine = create_async_engine(owner_sqlalchemy_url())
    try:
        async with engine.begin() as conn:
            return await apply(conn, build_plan(TODAY))
    finally:
        await engine.dispose()


@pytest_asyncio.fixture
async def seeded(owner_conn: asyncpg.Connection) -> AsyncIterator[dict[str, int]]:
    await _wipe(owner_conn)
    counts = await _run_apply()
    yield counts
    await _wipe(owner_conn)


@pytest_asyncio.fixture
async def admin() -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(make_settings(INTERNAL_SIGNING_KEY=KEY, ADMIN_EMAILS=OWNER))
    app.dependency_overrides[get_clock] = lambda: FakeClock(FIXED_NOW)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c


async def _get(admin: httpx.AsyncClient, path: str) -> httpx.Response:
    claims: dict[str, object] = {
        "aud": AUDIENCE, "sub": "s", "email": OWNER, "role": "owner",
        "iat": int(FIXED_NOW.timestamp()), "exp": int(FIXED_NOW.timestamp()) + 60,
        "m": "GET", "p": path, "bh": body_hash(b""), "ev": True,
        "jti": uuid.uuid4().hex,
    }  # fmt: skip
    return await admin.get(path, headers={"X-Internal-Assertion": sign(claims, KEY.encode())})


async def test_a_second_run_writes_nothing(
    seeded: dict[str, int], owner_conn: asyncpg.Connection
) -> None:
    assert seeded["patients"] == len(PEOPLE) and seeded["appointments"] > 600
    before = await _counts(owner_conn)
    again = await _run_apply()
    assert again == {"patients": 0, "appointments": 0, "events": 0, "marks": 0, "skipped": 0}
    after = await _counts(owner_conn)
    assert before == after


async def test_rows_are_valid_and_flagged(
    seeded: dict[str, int], owner_conn: asyncpg.Connection
) -> None:
    # The database itself enforced its CHECKs and unique indexes during the insert; here: shape.
    patients = await owner_conn.fetch("SELECT * FROM patients WHERE demo")
    assert len(patients) == len(PEOPLE)
    assert all(p["email"].endswith("@example.com") for p in patients)
    assert all(re.fullmatch(r"\+254700000\d{3}", p["phone"]) for p in patients)
    assert not any(p["synthetic"] for p in patients)
    bad_grid = await owner_conn.fetchval(
        "SELECT count(*) FROM appointments WHERE extract(epoch FROM starts_at)::numeric % 1800 <> 0"
    )
    assert bad_grid == 0
    outside = await owner_conn.fetchval(
        """
        SELECT count(*) FROM appointments a
        JOIN doctors d ON d.id = a.doctor_id
        JOIN clinics c ON c.id = d.clinic_id
        WHERE NOT EXISTS (
          SELECT 1 FROM working_hours w
          WHERE w.doctor_id = a.doctor_id
            AND w.weekday = extract(isodow FROM a.starts_at AT TIME ZONE c.timezone)
            AND (a.starts_at AT TIME ZONE c.timezone)::time >= w.start_time
            AND (a.starts_at AT TIME ZONE c.timezone)::time + interval '30 minutes' <= w.end_time)
        """
    )
    assert outside == 0
    # every event of an appointment is in the order it happened
    disordered = await owner_conn.fetchval(
        """
        SELECT count(*) FROM (
          SELECT occurred_at < lag(occurred_at)
                   OVER (PARTITION BY appointment_id ORDER BY id) AS bad
          FROM appointment_events) t WHERE bad
        """
    )
    assert disordered == 0
    window = await owner_conn.fetchrow(
        "SELECT min(starts_at) lo, max(starts_at) hi FROM appointments"
    )
    assert window is not None
    assert window["lo"].astimezone().date() >= TODAY - timedelta(days=15)
    assert window["hi"].astimezone().date() <= TODAY + timedelta(days=15)


async def test_cancellations_are_about_a_tenth_with_plain_reasons(
    seeded: dict[str, int], owner_conn: asyncpg.Connection
) -> None:
    total = await owner_conn.fetchval("SELECT count(*) FROM appointments")
    cancelled = await owner_conn.fetchval(
        "SELECT count(*) FROM appointments WHERE status = 'cancelled'"
    )
    assert 0.08 <= cancelled / total <= 0.12, (cancelled, total)
    reasons = {
        r["cancellation_reason"]
        for r in await owner_conn.fetch(
            "SELECT DISTINCT cancellation_reason FROM appointments WHERE status = 'cancelled'"
        )
    }
    assert len(reasons) >= 8
    assert "Child unwell, staying home" in reasons or "Shift changed at work" in reasons
    cancelled_events = await owner_conn.fetchval(
        "SELECT count(*) FROM appointment_events WHERE event_type = 'cancelled'"
    )
    assert cancelled_events == cancelled


async def test_utilisation_and_metrics_fall_in_the_stated_bands(
    seeded: dict[str, int], admin: httpx.AsyncClient
) -> None:
    for lo, hi in ((TODAY - timedelta(days=14), TODAY), (TODAY, TODAY + timedelta(days=14))):
        resp = await _get(admin, f"/internal/admin/metrics?from={lo}&to={hi}")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        loads = body["per_doctor"]
        assert len(loads) == 5
        for d in loads:
            assert 0.45 <= d["utilization"] <= 0.75, (lo, d)
        booked = sum(d["booked_visits"] for d in loads)
        capacity = sum(d["capacity"] for d in loads)
        assert 0.45 <= booked / capacity <= 0.75
    month = await _get(
        admin,
        f"/internal/admin/metrics?from={TODAY - timedelta(days=28)}&to={TODAY}",
    )
    totals = month.json()["totals"]
    assert totals["booked"] > 300 and totals["rescheduled"] > 20
    assert 0.06 <= totals["cancelled"] / totals["booked"] <= 0.14
    assert len(month.json()["series"]) >= 20  # activity on most days


async def test_demo_rows_show_in_admin_and_synthetic_rows_do_not(
    seeded: dict[str, int], owner_conn: asyncpg.Connection, admin: httpx.AsyncClient
) -> None:
    await owner_conn.execute(
        "INSERT INTO patients (id, full_name, synthetic) VALUES ($1, 'verify-claims 1 1', true)",
        SYNTHETIC,
    )
    doctor = await owner_conn.fetchval("SELECT id FROM doctors LIMIT 1")
    await owner_conn.execute(
        "INSERT INTO appointments (doctor_id, patient_id, starts_at, ends_at) "
        "VALUES ($1, $2, '2026-12-01 06:00+00', '2026-12-01 06:30+00')",
        doctor,
        SYNTHETIC,
    )
    names: set[str] = set()
    cursor = ""
    while True:
        resp = await _get(admin, f"/internal/admin/appointments?limit=100{cursor}")
        assert resp.status_code == 200
        page = resp.json()
        names |= {i["patient_name"] for i in page["items"]}
        assert all(i["avatar_url"] is None for i in page["items"])  # demo patients: initials
        if not page["next_cursor"]:
            break
        cursor = f"&cursor={page['next_cursor']}"
    assert names & {p.full_name for p in PEOPLE}
    assert "verify-claims 1 1" not in names


async def test_the_desk_marks_past_visits_the_way_the_app_does(
    seeded: dict[str, int], owner_conn: asyncpg.Connection
) -> None:
    """Attendance row + staff audit row + annotation event per mark, inside the attendance window,
    only on booked visits that have happened; patients' own events say 'patient'."""
    from app.domain.attendance import window_is_open

    marks = await owner_conn.fetch(
        "SELECT t.appointment_id, t.kind, t.marked_by, t.marked_at, a.starts_at, a.status "
        "FROM appointment_attendance t JOIN appointments a ON a.id = t.appointment_id"
    )
    assert len(marks) == seeded["marks"] > 200
    assert {m["status"] for m in marks} == {"booked"}
    assert {m["marked_by"] for m in marks} == {"reception@example.com"}
    assert all(window_is_open(m["starts_at"], m["marked_at"], m["kind"]) for m in marks)
    no_show = sum(1 for m in marks if m["kind"] == "no_show")
    assert 0.02 <= no_show / len(marks) <= 0.10
    assert all(m["starts_at"] < FIXED_NOW for m in marks)  # nothing is marked before it happened
    audit = await owner_conn.fetch(
        "SELECT action, actor_email, actor_role::text AS role, reason, (before ->> 'attendance') b "
        "FROM staff_action_audit"
    )
    assert len(audit) == len(marks)
    assert {a["actor_email"] for a in audit} == {"reception@example.com"}
    assert {a["role"] for a in audit} == {"admin"} and {a["b"] for a in audit} == {None}
    events = await owner_conn.fetch(
        "SELECT event_type, actor, count(*) n FROM appointment_events GROUP BY 1, 2"
    )
    by = {(e["event_type"], e["actor"]): e["n"] for e in events}
    assert by[("arrived", "staff")] + by.get(("no_show", "staff"), 0) == len(marks)
    assert {actor for (kind, actor) in by if kind in ("booked", "rescheduled", "cancelled")} == {
        "patient"
    }
    # The desk's address is a label, not an account: it opens nothing.
    assert not await owner_conn.fetchval(
        "SELECT count(*) FROM staff_access WHERE email = 'reception@example.com'"
    )


async def test_running_again_on_a_later_day_extends_the_window_and_changes_nothing_that_exists(
    seeded: dict[str, int], owner_conn: asyncpg.Connection
) -> None:
    before = {
        r["id"]: tuple(r)
        for r in await owner_conn.fetch(
            "SELECT id, doctor_id, patient_id, starts_at, status, cancellation_reason, created_at "
            "FROM appointments"
        )
    }
    engine = create_async_engine(owner_sqlalchemy_url())
    try:
        async with engine.begin() as conn:
            later = await apply(conn, build_plan(TODAY + timedelta(days=3)))
        async with engine.begin() as conn:
            again = await apply(conn, build_plan(TODAY + timedelta(days=3)))
    finally:
        await engine.dispose()
    assert later["appointments"] > 0  # three more days ahead (and three fewer behind)
    assert again == {"patients": 0, "appointments": 0, "events": 0, "marks": 0, "skipped": 0}
    after = {
        r["id"]: tuple(r)
        for r in await owner_conn.fetch(
            "SELECT id, doctor_id, patient_id, starts_at, status, cancellation_reason, created_at "
            "FROM appointments"
        )
    }
    assert all(after[i] == row for i, row in before.items()), "an existing row changed"
    latest = max(r[3] for r in after.values())
    assert latest.astimezone().date() > max(r[3] for r in before.values()).astimezone().date()
