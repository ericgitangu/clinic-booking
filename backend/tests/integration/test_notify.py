"""Reminder-now, doctor-running-late and the day sheet: authorisation, the demo suppression rule,
one audit row per patient, and who gets personal data in the CSV."""

from __future__ import annotations

import csv
import io
import uuid
from typing import Any

import asyncpg
import pytest
import pytest_asyncio

from tests.integration.staff_support import OTIENO, Env
from tests.integration.test_ops import DEMO, KAMAU, REAL, REAL_NAME, REAL_PHONE, SYNTH, add, eat

pytestmark = pytest.mark.asyncio

REAL_EMAIL = "amani.real@gmail.com"
NO_MAIL = uuid.UUID("00000000-0000-4000-8000-0000000000d4")


@pytest_asyncio.fixture
async def world(env: Env, owner_conn: asyncpg.Connection) -> Env:
    ids = [REAL, SYNTH, DEMO, NO_MAIL]
    await owner_conn.execute("DELETE FROM patients WHERE id = ANY($1::uuid[])", ids)
    await owner_conn.execute(
        "INSERT INTO patients (id, full_name, phone, email, synthetic) VALUES "
        "($1, $5, $6, $7, false), ($2, 'Release Smoke', NULL, 'smoke@example.com', true), "
        "($3, 'Demo Patient', NULL, 'demo@example.com', false), "
        "($4, 'No Mail', NULL, NULL, false)",
        REAL,
        SYNTH,
        DEMO,
        NO_MAIL,
        REAL_NAME,
        REAL_PHONE,
        REAL_EMAIL,
    )
    return env


async def audit(conn: asyncpg.Connection, action: str) -> list[asyncpg.Record]:
    rows: list[asyncpg.Record] = await conn.fetch(
        "SELECT * FROM staff_action_audit WHERE action = $1 ORDER BY occurred_at, id", action
    )
    return rows


async def cleanup(conn: asyncpg.Connection) -> None:
    await conn.execute("TRUNCATE appointment_events, appointments RESTART IDENTITY CASCADE")
    await conn.execute(
        "DELETE FROM patients WHERE id = ANY($1::uuid[])", [REAL, SYNTH, DEMO, NO_MAIL]
    )


# --- remind now ------------------------------------------------------------------------------


async def test_remind_now_for_a_real_patient_says_send(
    world: Env, owner_conn: asyncpg.Connection
) -> None:
    appt = await add(owner_conn, OTIENO, REAL, eat(27, 10, 0))
    world.clock.set(eat(27, 8, 0))
    resp = await world.req("POST", f"/internal/admin/appointments/{appt}/remind", role="admin")
    assert resp.status_code == 200, resp.text
    (item,) = resp.json()["items"]
    assert item["deliver"] is True and item["email"] == REAL_EMAIL and item["outcome"] == "to send"
    (row,) = await audit(owner_conn, "reminder_now")
    assert str(row["id"]) == item["audit_id"] and row["notified"] is False
    assert row["actor_email"] == "admin@clinic.example"
    await cleanup(owner_conn)


async def test_remind_now_for_a_demo_patient_sends_nothing(
    world: Env, owner_conn: asyncpg.Connection
) -> None:
    appt = await add(owner_conn, OTIENO, DEMO, eat(27, 10, 0))
    world.clock.set(eat(27, 8, 0))
    resp = await world.req(
        "POST", f"/internal/admin/appointments/{appt}/remind", body={"reason": "patient asked"}
    )
    (item,) = resp.json()["items"]
    assert item["deliver"] is False and item["email"] is None
    assert item["outcome"] == "demo, not sent"
    assert "demo@example.com" not in resp.text
    (row,) = await audit(owner_conn, "reminder_now")
    assert row["notified"] is False and row["reason"] == "patient asked"
    assert '"demo, not sent"' in row["after"]
    await cleanup(owner_conn)


async def test_remind_now_without_an_address(world: Env, owner_conn: asyncpg.Connection) -> None:
    appt = await add(owner_conn, OTIENO, NO_MAIL, eat(27, 10, 0))
    world.clock.set(eat(27, 8, 0))
    (item,) = (await world.req("POST", f"/internal/admin/appointments/{appt}/remind")).json()[
        "items"
    ]
    assert item["deliver"] is False and item["outcome"] == "no email on file"
    await cleanup(owner_conn)


async def test_remind_now_refuses_the_wrong_states(
    world: Env, owner_conn: asyncpg.Connection
) -> None:
    past = await add(owner_conn, OTIENO, REAL, eat(27, 8, 0))
    gone = await add(owner_conn, OTIENO, DEMO, eat(27, 11, 0), status="cancelled", reason="rain")
    world.clock.set(eat(27, 9, 0))
    started = await world.req("POST", f"/internal/admin/appointments/{past}/remind")
    cancelled = await world.req("POST", f"/internal/admin/appointments/{gone}/remind")
    missing = await world.req("POST", f"/internal/admin/appointments/{uuid.uuid4()}/remind")
    assert started.json()["code"] == "APPOINTMENT_ALREADY_STARTED"
    assert cancelled.json()["code"] == "APPOINTMENT_ALREADY_CANCELLED"
    assert missing.status_code == 404
    assert await audit(owner_conn, "reminder_now") == []
    await cleanup(owner_conn)


# --- doctor running late ---------------------------------------------------------------------


async def test_running_late_writes_one_audit_row_per_remaining_patient(
    world: Env, owner_conn: asyncpg.Connection
) -> None:
    await add(owner_conn, OTIENO, REAL, eat(27, 8, 0))  # already started: not told
    a = await add(owner_conn, OTIENO, REAL, eat(27, 10, 0))
    b = await add(owner_conn, OTIENO, DEMO, eat(27, 10, 30))
    c = await add(owner_conn, OTIENO, NO_MAIL, eat(27, 11, 0))
    await add(owner_conn, OTIENO, SYNTH, eat(27, 11, 30))  # synthetic: never contacted
    await add(owner_conn, OTIENO, REAL, eat(27, 12, 0), status="cancelled", reason="rain")
    await add(owner_conn, OTIENO, DEMO, eat(27, 13, 0), attendance="arrived")  # already here
    await add(owner_conn, KAMAU, REAL, eat(27, 14, 0))  # another doctor
    await add(owner_conn, OTIENO, REAL, eat(28, 9, 0))  # tomorrow
    world.clock.set(eat(27, 9, 0))
    resp = await world.req(
        "POST", f"/internal/admin/doctors/{OTIENO}/running-late", body={"minutes": 20}
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    got = {i["appointment_id"]: i for i in data["items"]}
    assert set(got) == {str(a), str(b), str(c)}
    assert [got[str(x)]["outcome"] for x in (a, b, c)] == [
        "to send",
        "demo, not sent",
        "no email on file",
    ]
    assert [got[str(x)]["deliver"] for x in (a, b, c)] == [True, False, False]
    assert got[str(a)]["email"] == REAL_EMAIL and got[str(b)]["email"] is None
    rows = await audit(owner_conn, "running_late")
    assert len(rows) == 3 and len({r["id"] for r in rows}) == 3
    assert {str(r["appointment_id"]) for r in rows} == set(got)
    assert all(r["notified"] is False for r in rows)
    assert all('"delay_minutes": 20' in r["after"] for r in rows)
    assert "demo@example.com" not in resp.text and "smoke@example.com" not in resp.text
    await cleanup(owner_conn)


async def test_running_late_with_nobody_left_writes_nothing(
    world: Env, owner_conn: asyncpg.Connection
) -> None:
    world.clock.set(eat(27, 9, 0))
    resp = await world.req(
        "POST", f"/internal/admin/doctors/{OTIENO}/running-late", body={"minutes": 15}
    )
    assert resp.status_code == 200 and resp.json()["items"] == []
    assert await audit(owner_conn, "running_late") == []
    await cleanup(owner_conn)


@pytest.mark.parametrize(
    "body", [{}, {"minutes": 4}, {"minutes": 241}, {"minutes": 20, "extra": 1}]
)
async def test_running_late_validates_input(world: Env, body: dict[str, object]) -> None:
    resp = await world.req("POST", f"/internal/admin/doctors/{OTIENO}/running-late", body=body)
    assert resp.status_code == 422


async def test_running_late_unknown_doctor(world: Env) -> None:
    resp = await world.req(
        "POST", f"/internal/admin/doctors/{uuid.uuid4()}/running-late", body={"minutes": 10}
    )
    assert resp.status_code == 404


async def test_a_viewer_can_send_neither(world: Env, owner_conn: asyncpg.Connection) -> None:
    appt = await add(owner_conn, OTIENO, REAL, eat(27, 10, 0))
    world.clock.set(eat(27, 8, 0))
    one = await world.req("POST", f"/internal/admin/appointments/{appt}/remind", role="viewer")
    many = await world.req(
        "POST",
        f"/internal/admin/doctors/{OTIENO}/running-late",
        role="viewer",
        body={"minutes": 10},
    )
    assert one.status_code == many.status_code == 403
    assert await audit(owner_conn, "reminder_now") == await audit(owner_conn, "running_late") == []
    await cleanup(owner_conn)


async def test_the_switch_turns_these_off_too(owner_conn: asyncpg.Connection) -> None:
    import httpx

    from app.api.deps import get_clock
    from app.core.clock import FakeClock
    from app.main import create_app
    from tests.conftest import FIXED_NOW, make_settings
    from tests.integration.staff_support import KEY, OWNER

    clock = FakeClock(FIXED_NOW)
    app = create_app(
        make_settings(INTERNAL_SIGNING_KEY=KEY, ADMIN_EMAILS=OWNER, STAFF_CRUD_ENABLED=False)
    )
    app.dependency_overrides[get_clock] = lambda: clock
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
    ) as c:
        off = Env(c, clock)
        resp = await off.req(
            "POST", f"/internal/admin/doctors/{OTIENO}/running-late", body={"minutes": 10}
        )
        assert resp.status_code == 404


# --- day sheet CSV ---------------------------------------------------------------------------


def rows_of(text: str) -> list[dict[str, str]]:
    return list(csv.DictReader(io.StringIO(text)))


async def test_the_day_sheet_has_personal_data_only_for_owner_and_admin(
    world: Env, owner_conn: asyncpg.Connection
) -> None:
    await add(owner_conn, OTIENO, REAL, eat(27, 9, 0), attendance="arrived")
    await add(
        owner_conn, OTIENO, DEMO, eat(27, 9, 30), status="cancelled", reason="my private reason"
    )
    await add(owner_conn, OTIENO, SYNTH, eat(27, 10, 0))
    await add(owner_conn, OTIENO, REAL, eat(28, 9, 0))  # another day
    path = "/internal/admin/ops/day-sheet.csv?date=2026-10-27"
    full = await world.req("GET", path, role="admin")
    assert full.status_code == 200
    assert full.headers["content-type"].startswith("text/csv")
    assert 'filename="day-sheet-2026-10-27.csv"' in full.headers["content-disposition"]
    assert full.headers["cache-control"] == "no-store"
    rows = rows_of(full.text)
    assert [(r["time"], r["status"], r["patient"]) for r in rows] == [
        ("09:00", "arrived", REAL_NAME),
        ("09:30", "cancelled", "Demo Patient"),
    ]
    assert rows[0]["phone"] == REAL_PHONE and rows[0]["email"] == REAL_EMAIL
    assert rows[1]["cancellation_reason"] == "my private reason"
    assert "Release Smoke" not in full.text
    mini = await world.req("GET", path, role="viewer")
    assert mini.status_code == 200
    for secret in (
        REAL_NAME,
        REAL_PHONE,
        REAL_EMAIL,
        "private reason",
        "Demo Patient",
        "example.com",
    ):
        assert secret not in mini.text
    assert [r["patient"] for r in rows_of(mini.text)] == ["A. O.", "D. P."]
    assert (await world.req("GET", path, role="none")).status_code == 403
    only = await world.req("GET", f"{path}&doctor_id={uuid.uuid4()}")
    assert rows_of(only.text) == []
    await cleanup(owner_conn)


async def test_spreadsheet_formulas_are_neutralised(
    world: Env, owner_conn: asyncpg.Connection
) -> None:
    evil = uuid.UUID("00000000-0000-4000-8000-0000000000d5")
    await owner_conn.execute("DELETE FROM patients WHERE id = $1", evil)
    await owner_conn.execute(
        "INSERT INTO patients (id, full_name) VALUES ($1, '=HYPERLINK(\"x\")')", evil
    )
    await add(owner_conn, OTIENO, evil, eat(27, 9, 0))
    text = (await world.req("GET", "/internal/admin/ops/day-sheet.csv?date=2026-10-27")).text
    assert rows_of(text)[0]["patient"] == '\'=HYPERLINK("x")'
    await cleanup(owner_conn)
    await owner_conn.execute("DELETE FROM patients WHERE id = $1", evil)


BAD_REASONS = ["a", "ab", "x" * 501, "bad\u0000reason"]


@pytest.mark.parametrize("reason", BAD_REASONS)
async def test_a_bad_optional_reason_is_a_422_not_a_500(
    world: Env, owner_conn: asyncpg.Connection, reason: str
) -> None:
    appt = await add(owner_conn, OTIENO, REAL, eat(27, 10, 0))
    world.clock.set(eat(27, 8, 0))
    paths: list[tuple[str, dict[str, Any]]] = [
        (f"/internal/admin/appointments/{appt}/remind", {"reason": reason}),
        (f"/internal/admin/doctors/{OTIENO}/running-late", {"minutes": 20, "reason": reason}),
        (f"/internal/admin/appointments/{appt}/arrived", {"reason": reason}),
    ]
    for path, body in paths:
        resp = await world.req("POST", path, body=body)
        assert resp.status_code == 422, (path, reason, resp.text)
    assert await audit(owner_conn, "reminder_now") == []
    await cleanup(owner_conn)


@pytest.mark.parametrize("reason", ["abc", "x" * 500])
async def test_the_edges_of_a_good_reason_are_accepted(
    world: Env, owner_conn: asyncpg.Connection, reason: str
) -> None:
    appt = await add(owner_conn, OTIENO, REAL, eat(27, 10, 0))
    world.clock.set(eat(27, 8, 0))
    one = await world.req(
        "POST", f"/internal/admin/appointments/{appt}/remind", body={"reason": reason}
    )
    many = await world.req(
        "POST",
        f"/internal/admin/doctors/{OTIENO}/running-late",
        body={"minutes": 20, "reason": reason},
    )
    assert one.status_code == many.status_code == 200
    await cleanup(owner_conn)


@pytest.mark.parametrize("blank", ["", "   ", "\t\n"])
async def test_a_blank_reason_is_the_same_as_none(
    world: Env, owner_conn: asyncpg.Connection, blank: str
) -> None:
    appt = await add(owner_conn, OTIENO, REAL, eat(27, 10, 0))
    world.clock.set(eat(27, 8, 0))
    one = await world.req(
        "POST", f"/internal/admin/appointments/{appt}/remind", body={"reason": blank}
    )
    many = await world.req(
        "POST",
        f"/internal/admin/doctors/{OTIENO}/running-late",
        body={"minutes": 20, "reason": blank},
    )
    mark = await world.req(
        "POST", f"/internal/admin/appointments/{appt}/arrived", body={"reason": None}
    )
    assert one.status_code == many.status_code == 200
    rows = await audit(owner_conn, "reminder_now")
    assert rows[0]["reason"] == "Reminder sent now at staff request"
    assert mark.status_code == 409  # window not open yet: the body was accepted, the rule applied
    await cleanup(owner_conn)
