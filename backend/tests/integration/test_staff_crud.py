"""Staff CRUD on a real Postgres: staff booking, veto and lock, the audit trail, role rules and
email invites. Each guard has a test that fails when the guard is removed (see the PR for the
mutation runs)."""

from __future__ import annotations

import hashlib
import json
import logging
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import asyncpg
import httpx
import pytest

from app.api.deps import get_clock
from app.core.clock import FakeClock
from app.main import create_app
from tests.conftest import FIXED_NOW, make_settings
from tests.integration.staff_support import (
    ADMIN,
    ADMIN2,
    KEY,
    MON_09,
    MON_0920_NOW,
    OTIENO,
    OWNER,
    PATIENT,
    PATIENT_EMAIL,
    PATIENT_NAME,
    PATIENT_PHONE,
    TUE_10,
    TUE_11,
    VIEWER,
    Env,
    audit_rows,
)

pytestmark = pytest.mark.asyncio


def body_without_request_id(resp: httpx.Response) -> dict[str, Any]:
    data: dict[str, Any] = resp.json()
    data.pop("request_id")
    return data


# --- viewer: 403 on every write ---------------------------------------------------------------

A = uuid.UUID("00000000-0000-4000-8000-0000000000a1")
WRITES: list[tuple[str, str, dict[str, Any] | None]] = [
    (
        "POST",
        "/internal/admin/appointments",
        {
            "doctor_id": str(OTIENO),
            "patient_id": str(PATIENT),
            "starts_at": TUE_10,
            "reason": "front desk booking",
        },
    ),
    ("PATCH", f"/internal/admin/appointments/{A}/cancel", {"reason": "front desk cancel"}),
    (
        "PATCH",
        f"/internal/admin/appointments/{A}/reschedule",
        {"starts_at": TUE_11, "reason": "front desk move"},
    ),
    ("POST", f"/internal/admin/appointments/{A}/veto", {"reason": "settled with patient"}),
    ("POST", f"/internal/admin/appointments/{A}/unlock", {"reason": "settled with patient"}),
    ("POST", "/internal/admin/invites", {"email": "new@clinic.example", "role": "viewer"}),
    ("GET", "/internal/admin/invites", None),
    ("DELETE", f"/internal/admin/invites/{A}", None),
    ("GET", "/internal/admin/audit", None),
    ("POST", f"/internal/admin/audit/{A}/notified", None),
    ("PATCH", f"/internal/admin/access/{ADMIN}", {"role": "viewer"}),
    ("DELETE", f"/internal/admin/access/{ADMIN}", None),
]


@pytest.mark.parametrize(("method", "path", "body"), WRITES)
async def test_a_viewer_is_refused_every_write(
    env: Env, method: str, path: str, body: dict[str, Any] | None
) -> None:
    resp = await env.req(method, path, role="viewer", body=body)
    assert resp.status_code == 403
    assert resp.json()["code"] == "FORBIDDEN"


async def test_a_viewer_write_changes_nothing(env: Env, owner_conn: asyncpg.Connection) -> None:
    appt = await env.patient_book()
    await env.req(
        "PATCH",
        f"/internal/admin/appointments/{appt}/cancel",
        role="viewer",
        body={"reason": "front desk cancel"},
    )
    assert (
        await owner_conn.fetchval("SELECT status FROM appointments WHERE id = $1", uuid.UUID(appt))
        == "booked"
    )
    assert await audit_rows(owner_conn) == []


# --- role rank and owner protection -----------------------------------------------------------


async def test_an_admin_cannot_demote_or_revoke_an_admin(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    await owner_conn.execute(
        "INSERT INTO staff_access (email, role, granted_by) VALUES ($1, 'admin', $2)", ADMIN2, OWNER
    )
    demote = await env.req(
        "PATCH", f"/internal/admin/access/{ADMIN2}", role="admin", body={"role": "viewer"}
    )
    revoke = await env.req("DELETE", f"/internal/admin/access/{ADMIN2}", role="admin")
    for resp in (demote, revoke):
        assert resp.status_code == 403, resp.text
        assert resp.json()["code"] == "ROLE_ESCALATION"
    assert (
        await owner_conn.fetchval("SELECT role::text FROM staff_access WHERE email = $1", ADMIN2)
        == "admin"
    )
    assert (
        await owner_conn.fetchval("SELECT revoked_at FROM staff_access WHERE email = $1", ADMIN2)
        is None
    )


async def test_nobody_changes_their_own_row(env: Env) -> None:
    resp = await env.req(
        "PATCH", f"/internal/admin/access/{ADMIN}", role="admin", body={"role": "viewer"}
    )
    assert resp.status_code == 403
    assert resp.json()["code"] == "ROLE_ESCALATION"
    gone = await env.req("DELETE", f"/internal/admin/access/{ADMIN}", role="admin")
    assert gone.json()["code"] == "ROLE_ESCALATION"


async def test_the_owner_manages_admins_and_an_admin_manages_viewers(env: Env) -> None:
    owner_demotes = await env.req(
        "PATCH", f"/internal/admin/access/{ADMIN}", role="owner", body={"role": "viewer"}
    )
    assert owner_demotes.status_code == 200, owner_demotes.text
    assert owner_demotes.json()["role"] == "viewer"
    promote = await env.req(
        "PATCH", f"/internal/admin/access/{ADMIN}", role="owner", body={"role": "admin"}
    )
    assert promote.status_code == 200
    admin_on_viewer = await env.req("DELETE", f"/internal/admin/access/{VIEWER}", role="admin")
    assert admin_on_viewer.status_code == 200, admin_on_viewer.text
    assert admin_on_viewer.json()["revoked_at"] is not None


async def test_nobody_acts_on_the_owner(env: Env) -> None:
    for role in ("owner", "admin"):
        patch = await env.req(
            "PATCH", f"/internal/admin/access/{OWNER}", role=role, body={"role": "viewer"}
        )
        delete = await env.req("DELETE", f"/internal/admin/access/{OWNER}", role=role)
        invite = await env.req(
            "POST", "/internal/admin/invites", role=role, body={"email": OWNER, "role": "admin"}
        )
        for resp in (patch, delete, invite):
            assert resp.status_code == 409, (role, resp.text)
            assert resp.json()["code"] == "OWNER_PROTECTED"
    grant = await env.req(
        "POST", "/internal/admin/access", role="owner", body={"email": OWNER, "role": "admin"}
    )
    assert grant.json()["code"] == "OWNER_PROTECTED"
    owner_role = await env.req(
        "POST",
        "/internal/admin/invites",
        role="owner",
        body={"email": "x@clinic.example", "role": "owner"},
    )
    assert owner_role.status_code == 422


# --- staff booking, the lead-time exemption and the audit row -----------------------------------


async def test_staff_book_inside_the_hour_where_a_patient_cannot(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    env.clock.set(MON_0920_NOW)
    patient = await env.client.post(
        "/appointments",
        json={"doctor_id": str(OTIENO), "patient_id": str(PATIENT), "starts_at": MON_09},
    )
    assert patient.status_code == 422
    assert patient.json()["code"] == "BOOKING_TOO_SOON"
    staff = await env.req(
        "POST",
        "/internal/admin/appointments",
        body={
            "doctor_id": str(OTIENO),
            "patient_id": str(PATIENT),
            "starts_at": MON_09,
            "reason": "walked in at the desk",
        },
    )
    assert staff.status_code == 201, staff.text
    data = staff.json()
    assert data["audit_id"] and data["patient_email"] == PATIENT_EMAIL and data["doctor_name"]
    assert data["previous_starts_at"] is None
    (row,) = await audit_rows(owner_conn)
    assert str(row["id"]) == data["audit_id"]
    assert (row["action"], row["actor_email"], row["actor_role"]) == ("book", OWNER, "owner")
    assert row["notified"] is False


async def test_a_staff_reschedule_inside_the_hour_succeeds_and_the_patients_does_not(
    env: Env,
) -> None:
    appt = await env.patient_book(TUE_10)
    env.clock.set(MON_0920_NOW)
    patient = await env.client.patch(f"/appointments/{appt}/reschedule", json={"starts_at": MON_09})
    # A new time inside the hour is a refused booking time (422); only a current start inside the
    # hour is a refused change (409).
    assert patient.status_code == 422
    assert patient.json()["code"] == "BOOKING_TOO_SOON"
    staff = await env.req(
        "PATCH",
        f"/internal/admin/appointments/{appt}/reschedule",
        role="admin",
        body={"starts_at": MON_09, "reason": "doctor is free now"},
    )
    assert staff.status_code == 200, staff.text
    assert staff.json()["previous_starts_at"].startswith("2026-10-27T10:00:00")


async def test_staff_are_still_bound_by_the_invariants(env: Env) -> None:
    env.clock.set(datetime(2026, 10, 19, 7, 0, tzinfo=UTC))  # 10:00 EAT on Monday
    past = await env.req(
        "POST",
        "/internal/admin/appointments",
        body={
            "doctor_id": str(OTIENO),
            "patient_id": str(PATIENT),
            "starts_at": "2026-10-19T09:00:00+03:00",
            "reason": "backdated entry",
        },
    )
    assert past.status_code == 422
    assert past.json()["code"] == "SLOT_IN_PAST"
    first = await env.req(
        "POST",
        "/internal/admin/appointments",
        body={
            "doctor_id": str(OTIENO),
            "patient_id": str(PATIENT),
            "starts_at": TUE_10,
            "reason": "desk booking",
        },
    )
    assert first.status_code == 201
    taken = await env.req(
        "POST",
        "/internal/admin/appointments",
        body={
            "doctor_id": str(OTIENO),
            "patient": {"full_name": "Someone Else"},
            "starts_at": TUE_10,
            "reason": "desk booking",
        },
    )
    assert taken.status_code == 409
    assert taken.json()["code"] == "SLOT_TAKEN"
    off_hours = await env.req(
        "POST",
        "/internal/admin/appointments",
        body={
            "doctor_id": str(OTIENO),
            "patient_id": str(PATIENT),
            "starts_at": "2026-10-27T23:00:00+03:00",
            "reason": "late night",
        },
    )
    assert off_hours.json()["code"] == "OUTSIDE_WORKING_HOURS"


async def test_a_refused_booking_leaves_no_orphan_patient(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    await env.req(
        "POST",
        "/internal/admin/appointments",
        body={
            "doctor_id": str(OTIENO),
            "patient_id": str(PATIENT),
            "starts_at": TUE_10,
            "reason": "desk booking",
        },
    )
    before = await owner_conn.fetchval("SELECT count(*) FROM patients")
    resp = await env.req(
        "POST",
        "/internal/admin/appointments",
        body={
            "doctor_id": str(OTIENO),
            "patient": {"full_name": "Orphan Test", "phone": "+254700000001"},
            "starts_at": TUE_10,
            "reason": "desk booking",
        },
    )
    assert resp.status_code == 409
    assert await owner_conn.fetchval("SELECT count(*) FROM patients") == before
    ok = await env.req(
        "POST",
        "/internal/admin/appointments",
        body={
            "doctor_id": str(OTIENO),
            "patient": {
                "full_name": "New Walkin",
                "phone": "+254700000001",
                "email": "walkin@example.com",
            },
            "starts_at": TUE_11,
            "reason": "walk-in at the desk",
        },
    )
    assert ok.status_code == 201, ok.text
    assert ok.json()["patient_name"] == "New Walkin"
    assert await owner_conn.fetchval("SELECT count(*) FROM patients") == before + 1


@pytest.mark.parametrize(
    "extra",
    [{}, {"patient_id": str(PATIENT), "patient": {"full_name": "Both Given"}}],
)
async def test_exactly_one_patient_source(env: Env, extra: dict[str, Any]) -> None:
    resp = await env.req(
        "POST",
        "/internal/admin/appointments",
        body={"doctor_id": str(OTIENO), "starts_at": TUE_10, "reason": "desk booking", **extra},
    )
    assert resp.status_code == 422


async def test_a_reason_is_required_on_every_staff_write(env: Env) -> None:
    appt = await env.patient_book()
    for method, path, body in [
        ("PATCH", f"/internal/admin/appointments/{appt}/cancel", {}),
        ("PATCH", f"/internal/admin/appointments/{appt}/cancel", {"reason": "ab"}),
        ("PATCH", f"/internal/admin/appointments/{appt}/reschedule", {"starts_at": TUE_11}),
        ("POST", f"/internal/admin/appointments/{appt}/veto", {"reason": "  "}),
        ("POST", f"/internal/admin/appointments/{appt}/unlock", {"reason": "x" * 501}),
        (
            "POST",
            "/internal/admin/appointments",
            {"doctor_id": str(OTIENO), "patient_id": str(PATIENT), "starts_at": TUE_10},
        ),
    ]:
        resp = await env.req(method, path, body=body)
        assert resp.status_code == 422, (path, resp.text)


PII = ("name", "phone", "email")


async def test_each_write_leaves_exactly_one_audit_row_without_pii(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    created = await env.req(
        "POST",
        "/internal/admin/appointments",
        body={
            "doctor_id": str(OTIENO),
            "patient_id": str(PATIENT),
            "starts_at": TUE_10,
            "reason": "desk booking",
        },
    )
    appt = created.json()["id"]
    moved = await env.req(
        "PATCH",
        f"/internal/admin/appointments/{appt}/reschedule",
        body={"starts_at": TUE_11, "reason": "doctor asked for 11"},
    )
    cancelled = await env.req(
        "PATCH", f"/internal/admin/appointments/{appt}/cancel", body={"reason": "patient phoned in"}
    )
    assert (created.status_code, moved.status_code, cancelled.status_code) == (201, 200, 200)
    rows = await audit_rows(owner_conn)
    assert [r["action"] for r in rows] == ["book", "reschedule", "cancel"]
    assert [str(r["id"]) for r in rows] == [
        created.json()["audit_id"],
        moved.json()["audit_id"],
        cancelled.json()["audit_id"],
    ]
    assert [r["reason"] for r in rows] == [
        "desk booking",
        "doctor asked for 11",
        "patient phoned in",
    ]
    assert all(str(r["appointment_id"]) == appt for r in rows)
    move_before, move_after = json.loads(rows[1]["before"]), json.loads(rows[1]["after"])
    assert move_before["starts_at"].startswith("2026-10-27T07:00:00")  # UTC of 10:00 EAT
    assert move_after["starts_at"].startswith("2026-10-27T08:00:00")
    assert json.loads(rows[2]["after"]) == {"status": "cancelled"}
    blob = " ".join(f"{r['before']} {r['after']}" for r in rows)
    for needle in (PATIENT_NAME, PATIENT_PHONE, PATIENT_EMAIL, "Zainab"):
        assert needle not in blob
    for r in rows:
        for part in (json.loads(r["before"]), json.loads(r["after"])):
            assert not any(p in key for key in part for p in PII)
    # The lifecycle events record who acted.
    actors = await owner_conn.fetch("SELECT actor FROM appointment_events ORDER BY id")
    assert [a["actor"] for a in actors] == ["staff", "staff", "staff"]


async def test_a_patient_change_is_recorded_as_the_patients_and_writes_no_audit(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    appt = await env.patient_book()
    await env.client.patch(f"/appointments/{appt}/cancel", json={"reason": "cannot make it"})
    assert [
        r["actor"]
        for r in await owner_conn.fetch("SELECT actor FROM appointment_events ORDER BY id")
    ] == ["patient", "patient"]
    assert await audit_rows(owner_conn) == []


async def test_a_refused_write_leaves_no_audit_row(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    appt = await env.patient_book()
    first = await env.req(
        "PATCH", f"/internal/admin/appointments/{appt}/cancel", body={"reason": "patient phoned in"}
    )
    again = await env.req(
        "PATCH", f"/internal/admin/appointments/{appt}/cancel", body={"reason": "patient phoned in"}
    )
    assert (first.status_code, again.status_code) == (200, 409)
    assert len(await audit_rows(owner_conn)) == 1


async def test_a_reschedule_to_the_same_time_changes_nothing_and_audits_nothing(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    appt = await env.patient_book(TUE_10)
    resp = await env.req(
        "PATCH",
        f"/internal/admin/appointments/{appt}/reschedule",
        body={"starts_at": TUE_10, "reason": "no real change"},
    )
    assert resp.status_code == 200
    assert resp.json()["audit_id"] is None
    assert await audit_rows(owner_conn) == []


# --- veto, lock, unlock --------------------------------------------------------------------------


async def test_veto_of_a_reschedule_moves_it_back_and_locks_it(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    appt = await env.patient_book(TUE_10)
    moved = await env.client.patch(f"/appointments/{appt}/reschedule", json={"starts_at": TUE_11})
    assert moved.status_code == 200
    veto = await env.req(
        "POST", f"/internal/admin/appointments/{appt}/veto", body={"reason": "doctor is away at 11"}
    )
    assert veto.status_code == 200, veto.text
    assert veto.json()["id"] == appt
    assert veto.json()["starts_at"].startswith("2026-10-27T10:00:00")
    assert await owner_conn.fetchval(
        "SELECT staff_locked_at IS NOT NULL FROM appointments WHERE id = $1", uuid.UUID(appt)
    )
    (row,) = await audit_rows(owner_conn)
    assert row["action"] == "veto"


async def test_a_patient_change_on_a_locked_appointment_is_locked(env: Env) -> None:
    appt = await env.patient_book(TUE_10)
    await env.client.patch(f"/appointments/{appt}/reschedule", json={"starts_at": TUE_11})
    await env.req(
        "POST", f"/internal/admin/appointments/{appt}/veto", body={"reason": "doctor is away at 11"}
    )
    for resp in (
        await env.client.patch(f"/appointments/{appt}/reschedule", json={"starts_at": TUE_11}),
        await env.client.patch(f"/appointments/{appt}/cancel", json={"reason": "cannot make it"}),
    ):
        assert resp.status_code == 409
        assert resp.json()["code"] == "APPOINTMENT_LOCKED"
    # The lock follows a staff reschedule: it is the same row.
    staff_move = await env.req(
        "PATCH",
        f"/internal/admin/appointments/{appt}/reschedule",
        body={"starts_at": "2026-10-27T14:00:00+03:00", "reason": "better afternoon slot"},
    )
    assert staff_move.status_code == 200
    still = await env.client.patch(
        f"/appointments/{appt}/cancel", json={"reason": "cannot make it"}
    )
    assert still.json()["code"] == "APPOINTMENT_LOCKED"


async def test_veto_of_a_cancel_rebooks_as_a_new_locked_appointment(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    appt = await env.patient_book(TUE_10)
    cancelled = await env.client.patch(
        f"/appointments/{appt}/cancel", json={"reason": "cannot make it"}
    )
    assert cancelled.status_code == 200
    veto = await env.req(
        "POST",
        f"/internal/admin/appointments/{appt}/veto",
        body={"reason": "patient is insured only today"},
    )
    assert veto.status_code == 200, veto.text
    new_id = veto.json()["id"]
    assert new_id != appt and veto.json()["status"] == "booked"
    assert veto.json()["starts_at"].startswith("2026-10-27T10:00:00")
    row = await owner_conn.fetchrow(
        "SELECT predecessor_id, staff_locked_at FROM appointments WHERE id = $1", uuid.UUID(new_id)
    )
    assert str(row["predecessor_id"]) == appt and row["staff_locked_at"] is not None
    assert (
        await owner_conn.fetchval("SELECT status FROM appointments WHERE id = $1", uuid.UUID(appt))
        == "cancelled"
    )
    refused = await env.client.patch(
        f"/appointments/{new_id}/cancel", json={"reason": "cannot make it"}
    )
    assert refused.json()["code"] == "APPOINTMENT_LOCKED"
    (audit,) = await audit_rows(owner_conn)
    assert str(audit["appointment_id"]) == new_id and audit["action"] == "veto"
    assert json.loads(audit["before"])["appointment_id"] == appt
    # The old cancelled row has a successor now: a second veto has nothing to undo.
    again = await env.req(
        "POST", f"/internal/admin/appointments/{appt}/veto", body={"reason": "once more please"}
    )
    assert again.status_code == 409
    assert again.json()["code"] == "NOTHING_TO_VETO"


async def test_nothing_to_veto(env: Env, owner_conn: asyncpg.Connection) -> None:
    appt = await env.patient_book(TUE_10)
    fresh = await env.req(
        "POST", f"/internal/admin/appointments/{appt}/veto", body={"reason": "just in case"}
    )
    assert fresh.status_code == 409 and fresh.json()["code"] == "NOTHING_TO_VETO"
    # The latest change is staff's, not the patient's.
    await env.req(
        "PATCH",
        f"/internal/admin/appointments/{appt}/reschedule",
        body={"starts_at": TUE_11, "reason": "doctor asked for 11"},
    )
    staff_last = await env.req(
        "POST", f"/internal/admin/appointments/{appt}/veto", body={"reason": "just in case"}
    )
    assert staff_last.json()["code"] == "NOTHING_TO_VETO"
    assert await audit_rows(owner_conn) != []
    assert len(await audit_rows(owner_conn)) == 1  # only the staff reschedule
    missing = await env.req(
        "POST", f"/internal/admin/appointments/{uuid.uuid4()}/veto", body={"reason": "just in case"}
    )
    assert missing.status_code == 404


async def test_unlock_lets_the_patient_change_it_again(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    appt = await env.patient_book(TUE_10)
    nothing = await env.req(
        "POST", f"/internal/admin/appointments/{appt}/unlock", body={"reason": "not locked yet"}
    )
    assert nothing.status_code == 409 and nothing.json()["code"] == "NOTHING_TO_VETO"
    await env.client.patch(f"/appointments/{appt}/reschedule", json={"starts_at": TUE_11})
    await env.req(
        "POST", f"/internal/admin/appointments/{appt}/veto", body={"reason": "doctor is away at 11"}
    )
    unlocked = await env.req(
        "POST",
        f"/internal/admin/appointments/{appt}/unlock",
        role="admin",
        body={"reason": "sorted out by phone"},
    )
    assert unlocked.status_code == 200, unlocked.text
    ok = await env.client.patch(f"/appointments/{appt}/cancel", json={"reason": "cannot make it"})
    assert ok.status_code == 200
    assert [r["action"] for r in await audit_rows(owner_conn)] == ["veto", "unlock"]


# --- audit table: append-only for the runtime role ----------------------------------------------


async def test_the_audit_table_cannot_be_rewritten_or_erased_by_the_app_role(
    env: Env, owner_conn: asyncpg.Connection, app_conn: asyncpg.Connection
) -> None:
    appt = await env.patient_book()
    resp = await env.req(
        "PATCH", f"/internal/admin/appointments/{appt}/cancel", body={"reason": "patient phoned in"}
    )
    audit_id = uuid.UUID(resp.json()["audit_id"])
    for statement in (
        "DELETE FROM staff_action_audit",
        "UPDATE staff_action_audit SET reason = 'edited reason'",
        "UPDATE staff_action_audit SET actor_email = 'someone@else.example'",
        "UPDATE staff_action_audit SET before = '{}'::jsonb, after = '{}'::jsonb",
        "TRUNCATE staff_action_audit",
    ):
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await app_conn.execute(statement)
    assert len(await audit_rows(owner_conn)) == 1
    # The one exception: the notified flag, set once the patient email went, never unset.
    async with app_conn.transaction():
        await app_conn.execute("SELECT set_config('app.actor', $1, true)", OWNER)
        await app_conn.execute(
            "UPDATE staff_action_audit SET notified = true WHERE id = $1", audit_id
        )
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        await app_conn.execute(
            "UPDATE staff_action_audit SET notified = false WHERE id = $1", audit_id
        )
    assert (await audit_rows(owner_conn))[0]["notified"] is True


async def test_notified_is_set_through_the_api(env: Env, owner_conn: asyncpg.Connection) -> None:
    appt = await env.patient_book()
    resp = await env.req(
        "PATCH", f"/internal/admin/appointments/{appt}/cancel", body={"reason": "patient phoned in"}
    )
    audit_id = resp.json()["audit_id"]
    done = await env.req("POST", f"/internal/admin/audit/{audit_id}/notified")
    assert done.status_code == 200 and done.json() == {"audit_id": audit_id, "notified": True}
    assert (await audit_rows(owner_conn))[0]["notified"] is True
    again = await env.req("POST", f"/internal/admin/audit/{audit_id}/notified")
    assert again.status_code == 200  # marking twice is harmless
    missing = await env.req("POST", f"/internal/admin/audit/{uuid.uuid4()}/notified")
    assert missing.status_code == 404


async def test_the_audit_trail_is_readable_by_owner_and_admin_newest_first(env: Env) -> None:
    appt = await env.patient_book()
    await env.req(
        "PATCH",
        f"/internal/admin/appointments/{appt}/reschedule",
        body={"starts_at": TUE_11, "reason": "doctor asked for 11"},
    )
    await env.req(
        "PATCH",
        f"/internal/admin/appointments/{appt}/cancel",
        role="admin",
        body={"reason": "patient phoned in"},
    )
    page = await env.req("GET", "/internal/admin/audit?limit=1", role="admin")
    assert page.status_code == 200
    assert [i["action"] for i in page.json()["items"]] == ["cancel"]
    assert page.json()["items"][0]["actor_email"] == ADMIN
    nxt = await env.req("GET", f"/internal/admin/audit?limit=5&cursor={page.json()['next_cursor']}")
    assert [i["action"] for i in nxt.json()["items"]] == ["reschedule"]
    assert nxt.json()["next_cursor"] is None
    bad = await env.req("GET", "/internal/admin/audit?cursor=garbage")
    assert bad.status_code == 422


# --- what a viewer sees -----------------------------------------------------------------------


async def test_the_viewer_projection_is_chosen_by_the_api(env: Env) -> None:
    appt = await env.patient_book()
    await env.client.patch(
        f"/appointments/{appt}/cancel", json={"reason": "my private medical reason"}
    )
    full = (await env.req("GET", "/internal/admin/appointments", role="admin")).json()
    mini = (await env.req("GET", "/internal/admin/appointments", role="viewer")).json()
    assert full["view"] == "full" and mini["view"] == "minimised"
    f, m = full["items"][0], mini["items"][0]
    assert (f["patient_name"], f["patient_phone"], f["patient_email"]) == (
        PATIENT_NAME,
        PATIENT_PHONE,
        PATIENT_EMAIL,
    )
    assert f["cancellation_reason"] == "my private medical reason"
    assert m["patient_name"] == "Z. W."
    assert m["patient_phone"] == "+**********78"
    assert m["patient_email"] is None and m["cancellation_reason"] is None
    text = json.dumps(mini)
    for secret in (PATIENT_NAME, PATIENT_PHONE, PATIENT_EMAIL, "private medical"):
        assert secret not in text


# --- invites ----------------------------------------------------------------------------------


async def make_invite(
    env: Env, email: str = "new.doc@clinic.example", role: str = "viewer", by: str = "owner"
) -> dict[str, Any]:
    resp = await env.req(
        "POST", "/internal/admin/invites", role=by, body={"email": email, "role": role}
    )
    assert resp.status_code == 201, resp.text
    data: dict[str, Any] = resp.json()
    return data


async def accept(env: Env, token: str, email: str, *, verified: bool = True) -> httpx.Response:
    return await env.req(
        "POST",
        "/internal/admin/invites/accept",
        role="none",
        email=email,
        verified=verified,
        body={"token": token},
    )


async def test_invite_roundtrip_and_what_is_stored(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    invite = await make_invite(env, role="admin", by="owner")
    token = invite["token"]
    row = await owner_conn.fetchrow(
        "SELECT * FROM staff_invites WHERE id = $1", uuid.UUID(invite["id"])
    )
    assert row["token_hash"] == hashlib.sha256(token.encode()).hexdigest()
    assert token not in " ".join(str(v) for v in row.values())
    assert row["expires_at"] - row["created_at"] == timedelta(hours=72)
    listing = await env.req("GET", "/internal/admin/invites", role="admin")
    assert [(i["email"], i["status"]) for i in listing.json()["items"]] == [
        ("new.doc@clinic.example", "open")
    ]
    assert token not in listing.text
    resp = await accept(env, token, "New.Doc@Clinic.Example")
    assert resp.status_code == 200, resp.text
    assert resp.json()["role"] == "admin" and resp.json()["granted_by"] == OWNER
    me = await env.req(
        "GET", "/internal/admin/session", role="admin", email="new.doc@clinic.example"
    )
    assert me.json()["role"] == "admin"
    audit = await owner_conn.fetchrow(
        "SELECT actor_email, action, target_email FROM staff_access_audit"
    )
    assert tuple(audit) == (OWNER, "grant", "new.doc@clinic.example")
    assert (await env.req("GET", "/internal/admin/invites")).json()["items"][0][
        "status"
    ] == "consumed"


async def test_every_invite_failure_is_the_same_404(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    good = await make_invite(env, "a@clinic.example")
    reused = await make_invite(env, "b@clinic.example")
    assert (await accept(env, reused["token"], "b@clinic.example")).status_code == 200
    revoked = await make_invite(env, "c@clinic.example")
    assert (await env.req("DELETE", f"/internal/admin/invites/{revoked['id']}")).status_code == 200
    expired = await make_invite(env, "d@clinic.example")
    await owner_conn.execute(
        "UPDATE staff_invites SET expires_at = created_at + interval '1 second' WHERE id = $1",
        uuid.UUID(expired["id"]),
    )
    env.clock.set(env.clock.now() + timedelta(minutes=5))
    cases = [
        ("reused", await accept(env, reused["token"], "b@clinic.example")),
        ("revoked", await accept(env, revoked["token"], "c@clinic.example")),
        ("expired", await accept(env, expired["token"], "d@clinic.example")),
        ("mismatch", await accept(env, good["token"], "someone.else@clinic.example")),
        ("unknown", await accept(env, secrets.token_urlsafe(32), "a@clinic.example")),
        ("unverified", await accept(env, good["token"], "a@clinic.example", verified=False)),
    ]
    bodies = {name: body_without_request_id(r) for name, r in cases}
    for name, resp in cases:
        assert resp.status_code == 404, name
        assert resp.json()["code"] == "INVITE_INVALID", name
    assert len({json.dumps(b, sort_keys=True) for b in bodies.values()}) == 1, bodies
    # The right person with the right token still gets in after all those failures.
    assert (await accept(env, good["token"], "a@clinic.example")).status_code == 200


async def test_invite_rules(env: Env, owner_conn: asyncpg.Connection) -> None:
    exists = await env.req(
        "POST", "/internal/admin/invites", body={"email": VIEWER, "role": "admin"}
    )
    assert exists.status_code == 409 and exists.json()["code"] == "ACCESS_EXISTS"
    me = await env.req(
        "POST", "/internal/admin/invites", role="admin", body={"email": ADMIN, "role": "viewer"}
    )
    assert me.json()["code"] in ("ROLE_ESCALATION", "ACCESS_EXISTS")
    first = await make_invite(env, "twice@clinic.example")
    second = await make_invite(env, "twice@clinic.example", role="admin")
    assert first["id"] != second["id"]
    states = {
        r["id"]: r for r in await owner_conn.fetch("SELECT id, revoked_at FROM staff_invites")
    }
    assert states[uuid.UUID(first["id"])]["revoked_at"] is not None
    assert states[uuid.UUID(second["id"])]["revoked_at"] is None
    superseded = await accept(env, first["token"], "twice@clinic.example")
    assert superseded.json()["code"] == "INVITE_INVALID"
    assert (await accept(env, second["token"], "twice@clinic.example")).json()["role"] == "admin"


async def test_an_invite_is_void_once_its_sender_lost_the_right(env: Env) -> None:
    invite = await make_invite(env, "late@clinic.example", by="admin")
    assert (await env.req("DELETE", f"/internal/admin/access/{ADMIN}")).status_code == 200
    assert (await accept(env, invite["token"], "late@clinic.example")).json()[
        "code"
    ] == "INVITE_INVALID"


async def test_ten_invites_a_day_per_person(env: Env) -> None:
    for i in range(10):
        await make_invite(env, f"person{i}@clinic.example", by="admin")
    over = await env.req(
        "POST",
        "/internal/admin/invites",
        role="admin",
        body={"email": "p10@clinic.example", "role": "viewer"},
    )
    assert over.status_code == 429 and over.json()["code"] == "RATE_LIMITED"
    assert int(over.headers["retry-after"]) > 0
    other = await env.req(
        "POST",
        "/internal/admin/invites",
        role="owner",
        body={"email": "p11@clinic.example", "role": "viewer"},
    )
    assert other.status_code == 201
    env.clock.set(env.clock.now() + timedelta(hours=24, minutes=1))
    again = await env.req(
        "POST",
        "/internal/admin/invites",
        role="admin",
        body={"email": "p12@clinic.example", "role": "viewer"},
    )
    assert again.status_code == 201


async def test_a_revoke_does_not_refund_the_daily_budget(env: Env) -> None:
    for i in range(10):
        inv = await make_invite(env, f"r{i}@clinic.example", by="admin")
        await env.req("DELETE", f"/internal/admin/invites/{inv['id']}", role="admin")
    over = await env.req(
        "POST",
        "/internal/admin/invites",
        role="admin",
        body={"email": "r10@clinic.example", "role": "viewer"},
    )
    assert over.status_code == 429


async def test_revoking_an_unknown_or_closed_invite_is_the_same_404(env: Env) -> None:
    inv = await make_invite(env)
    assert (await env.req("DELETE", f"/internal/admin/invites/{inv['id']}")).status_code == 200
    again = await env.req("DELETE", f"/internal/admin/invites/{inv['id']}")
    unknown = await env.req("DELETE", f"/internal/admin/invites/{uuid.uuid4()}")
    assert again.status_code == unknown.status_code == 404
    assert again.json()["code"] == unknown.json()["code"] == "INVITE_INVALID"


async def test_no_email_or_token_reaches_the_logs(
    env: Env, caplog: pytest.LogCaptureFixture, capsys: pytest.CaptureFixture[str]
) -> None:
    caplog.set_level(logging.DEBUG)
    invite = await make_invite(env, "private.person@clinic.example")
    await accept(env, invite["token"], "private.person@clinic.example")
    await accept(env, invite["token"], "other.person@clinic.example")
    out = capsys.readouterr().out + caplog.text
    assert out
    for needle in (
        invite["token"],
        "private.person",
        "other.person",
        hashlib.sha256(invite["token"].encode()).hexdigest(),
    ):
        assert needle not in out


# --- the switch -------------------------------------------------------------------------------


async def test_the_switch_turns_the_routes_off() -> None:
    clock = FakeClock(FIXED_NOW)
    app = create_app(
        make_settings(INTERNAL_SIGNING_KEY=KEY, ADMIN_EMAILS=OWNER, STAFF_CRUD_ENABLED=False)
    )
    app.dependency_overrides[get_clock] = lambda: clock
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        off = Env(c, clock)
        for method, path, body in [
            (
                "POST",
                "/internal/admin/appointments",
                {
                    "doctor_id": str(OTIENO),
                    "patient_id": str(PATIENT),
                    "starts_at": TUE_10,
                    "reason": "desk booking",
                },
            ),
            ("POST", f"/internal/admin/appointments/{A}/veto", {"reason": "settled with patient"}),
            ("POST", "/internal/admin/invites", {"email": "x@clinic.example", "role": "viewer"}),
            ("GET", "/internal/admin/audit", None),
        ]:
            resp = await off.req(method, path, body=body)
            assert resp.status_code == 404, path
            assert resp.json()["code"] == "NOT_FOUND"
        # Access management goes back to the owner alone.
        admin = await off.req("DELETE", f"/internal/admin/access/{VIEWER}", role="admin")
        assert admin.status_code == 403


async def test_a_staff_change_within_the_hour_succeeds_where_the_patient_gets_change_too_late(
    env: Env,
) -> None:
    appt = await env.patient_book(TUE_10)
    env.clock.set(datetime(2026, 10, 27, 6, 20, tzinfo=UTC))  # 09:20 EAT, 40 minutes before 10:00
    patient_move = await env.client.patch(
        f"/appointments/{appt}/reschedule", json={"starts_at": "2026-10-27T14:00:00+03:00"}
    )
    patient_cancel = await env.client.patch(
        f"/appointments/{appt}/cancel", json={"reason": "cannot make it"}
    )
    for resp in (patient_move, patient_cancel):
        assert resp.status_code == 409
        assert resp.json()["code"] == "CHANGE_TOO_LATE"
    staff_move = await env.req(
        "PATCH",
        f"/internal/admin/appointments/{appt}/reschedule",
        body={"starts_at": "2026-10-27T14:00:00+03:00", "reason": "doctor is free this afternoon"},
    )
    assert staff_move.status_code == 200, staff_move.text
    staff_cancel = await env.req(
        "PATCH",
        f"/internal/admin/appointments/{appt}/cancel",
        body={"reason": "doctor called in sick"},
    )
    assert staff_cancel.status_code == 200, staff_cancel.text
