"""The doctor's address, and the record of telling the doctor a patient arrived."""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any

import asyncpg
import httpx
import pytest
import pytest_asyncio

from tests.integration.staff_support import OTIENO, TUE_10, Env, audit_rows

pytestmark = pytest.mark.asyncio

START = datetime(2026, 10, 27, 7, 0, tzinfo=UTC)  # TUE_10 in Nairobi
ADDRESS = "dr.otieno@clinic.invalid-demo.example"
REAL_LOOKING = "dr.otieno@clinic.co.ke"


@pytest_asyncio.fixture(autouse=True)
async def no_doctor_email(owner_conn: asyncpg.Connection) -> AsyncIterator[None]:
    """Every case starts with the doctor having no address, and leaves it that way."""
    await owner_conn.execute("UPDATE doctors SET email = NULL")
    yield
    await owner_conn.execute("UPDATE doctors SET email = NULL")


def appt_path(appt: str, what: str) -> str:
    return f"/internal/admin/appointments/{appt}/{what}"


async def set_address(env: Env, email: str | None, role: str = "admin") -> httpx.Response:
    return await env.req(
        "PATCH",
        f"/internal/admin/doctors/{OTIENO}/email",
        role=role,
        body={"email": email, "reason": "the clinic's official address"},
    )


async def arrive(env: Env) -> tuple[str, dict[str, Any]]:
    appt = await env.patient_book(TUE_10)
    env.clock.set(START)
    resp = await env.req("POST", appt_path(appt, "arrived"))
    assert resp.status_code == 200, resp.text
    return appt, resp.json()


async def rows(owner_conn: asyncpg.Connection) -> list[asyncpg.Record]:
    found = await owner_conn.fetch("SELECT * FROM doctor_notification ORDER BY created_at, id")
    return list(found)


# --- the record, written with the arrival -------------------------------------------------------


async def test_an_arrival_writes_exactly_one_pending_row_when_the_doctor_has_an_address(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    assert (await set_address(env, REAL_LOOKING)).status_code == 200
    appt, body = await arrive(env)
    got = await rows(owner_conn)
    assert len(got) == 1
    assert got[0]["status"] == "pending" and got[0]["reason"] is None
    assert got[0]["attempts"] == 0 and got[0]["kind"] == "patient_arrived"
    assert str(got[0]["appointment_id"]) == appt and got[0]["doctor_id"] == OTIENO
    assert body["doctor_notice"]["status"] == "pending"
    assert body["doctor_notice"]["id"] == str(got[0]["id"])


async def test_a_doctor_with_no_address_gets_a_skipped_row_with_the_reason(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    _, body = await arrive(env)  # the arrival still answers 200 (asserted in arrive)
    got = await rows(owner_conn)
    assert [(r["status"], r["reason"]) for r in got] == [("skipped", "no_email")]
    assert body["doctor_notice"]["status"] == "skipped"
    assert body["doctor_notice"]["reason"] == "no_email"


async def test_a_reserved_demo_address_is_skipped_and_never_claimed(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    assert (await set_address(env, "someone@example.com")).status_code == 200
    await arrive(env)
    got = await rows(owner_conn)
    assert [(r["status"], r["reason"]) for r in got] == [("skipped", "demo_address")]


async def test_a_no_show_writes_no_row(env: Env, owner_conn: asyncpg.Connection) -> None:
    await set_address(env, REAL_LOOKING)
    appt = await env.patient_book(TUE_10)
    env.clock.set(START)
    resp = await env.req("POST", appt_path(appt, "no-show"))
    assert resp.status_code == 200 and resp.json()["doctor_notice"] is None
    assert await rows(owner_conn) == []


async def test_a_second_mark_and_a_change_back_make_no_duplicate(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    await set_address(env, REAL_LOOKING)
    appt, first = await arrive(env)
    again = await env.req("POST", appt_path(appt, "arrived"))
    assert again.status_code == 200 and again.json()["doctor_notice"] is None
    await env.req("POST", appt_path(appt, "no-show"), body={"reason": "left before being seen"})
    back = await env.req("POST", appt_path(appt, "arrived"), body={"reason": "came back later"})
    assert back.status_code == 200
    assert back.json()["doctor_notice"]["id"] == first["doctor_notice"]["id"]
    assert len(await rows(owner_conn)) == 1


async def test_a_failed_arrival_leaves_no_row(env: Env, owner_conn: asyncpg.Connection) -> None:
    await set_address(env, REAL_LOOKING)
    appt = await env.patient_book(TUE_10)  # the clock is still far from the visit
    resp = await env.req("POST", appt_path(appt, "arrived"))
    assert resp.status_code == 409
    assert await rows(owner_conn) == []


async def test_the_row_cannot_be_deleted_by_the_app_role(
    env: Env, owner_conn: asyncpg.Connection, app_conn: asyncpg.Connection
) -> None:
    await set_address(env, REAL_LOOKING)
    await arrive(env)
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        await app_conn.execute("DELETE FROM doctor_notification")
    with pytest.raises(asyncpg.UniqueViolationError):
        await owner_conn.execute(
            "INSERT INTO doctor_notification (appointment_id, doctor_id, kind, status) "
            "SELECT appointment_id, doctor_id, kind, 'pending' FROM doctor_notification"
        )


# --- sending: claim, then finish ----------------------------------------------------------------


def notice_path(notice: object, what: str) -> str:
    return f"/internal/admin/doctor-notifications/{notice}/{what}"


async def test_a_claim_hands_out_what_to_send_once_and_a_provider_failure_can_be_retried(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    await set_address(env, REAL_LOOKING)
    _, body = await arrive(env)
    notice = body["doctor_notice"]["id"]

    first = (await env.req("POST", notice_path(notice, "claim"))).json()["send"]
    assert first["doctor_email"] == REAL_LOOKING and first["attempt"] == 1
    assert first["doctor_name"].startswith("Dr")
    # Held by that claim: nobody else is handed the same send.
    held = await env.req("POST", notice_path(notice, "claim"))
    assert held.json()["send"] is None

    failed = await env.req(
        "POST", notice_path(notice, "finish"), body={"outcome": "failed", "error": "timeout"}
    )
    assert failed.status_code == 200 and failed.json()["status"] == "failed"
    row = (await rows(owner_conn))[0]
    assert row["status"] == "failed" and row["attempts"] == 1 and row["last_error"] == "timeout"
    assert row["sent_at"] is None and row["leased_at"] is None

    retry = (await env.req("POST", notice_path(notice, "claim"))).json()["send"]
    assert retry["attempt"] == 2
    sent = await env.req(
        "POST", notice_path(notice, "finish"), body={"outcome": "sent", "provider_id": "re_123"}
    )
    assert sent.json() == {"id": notice, "status": "sent", "updated": True}
    row = (await rows(owner_conn))[0]
    assert row["status"] == "sent" and row["attempts"] == 2 and row["provider_id"] == "re_123"
    assert row["sent_at"] is not None and row["last_error"] is None

    # Sent is final: no more claims, and a late finish changes nothing.
    assert (await env.req("POST", notice_path(notice, "claim"))).json()["send"] is None
    late = await env.req("POST", notice_path(notice, "finish"), body={"outcome": "failed"})
    assert late.json()["status"] == "sent" and late.json()["updated"] is False


async def test_a_lease_that_ran_out_can_be_taken_again(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    await set_address(env, REAL_LOOKING)
    _, body = await arrive(env)
    notice = body["doctor_notice"]["id"]
    assert (await env.req("POST", notice_path(notice, "claim"))).json()["send"]
    env.clock.set(START.replace(hour=START.hour + 1))  # well past the lease
    again = (await env.req("POST", notice_path(notice, "claim"))).json()["send"]
    assert again["attempt"] == 2


async def test_the_attempts_run_out(env: Env, owner_conn: asyncpg.Connection) -> None:
    await set_address(env, REAL_LOOKING)
    _, body = await arrive(env)
    notice = body["doctor_notice"]["id"]
    for n in (1, 2, 3):
        send = (await env.req("POST", notice_path(notice, "claim"))).json()["send"]
        assert send["attempt"] == n
        await env.req("POST", notice_path(notice, "finish"), body={"outcome": "failed"})
    assert (await env.req("POST", notice_path(notice, "claim"))).json()["send"] is None
    assert (await rows(owner_conn))[0]["status"] == "failed"


@pytest.mark.parametrize("reason", ["allowance_day", "allowance_month", "not_configured"])
async def test_a_spent_allowance_is_recorded_as_skipped_and_the_arrival_stands(
    env: Env, owner_conn: asyncpg.Connection, reason: str
) -> None:
    await set_address(env, REAL_LOOKING)
    appt, _ = await arrive(env)
    notice = (await rows(owner_conn))[0]["id"]
    assert (await env.req("POST", notice_path(notice, "claim"))).json()["send"]
    done = await env.req(
        "POST", notice_path(notice, "finish"), body={"outcome": "skipped", "reason": reason}
    )
    assert done.json()["status"] == "skipped"
    row = (await rows(owner_conn))[0]
    assert (row["status"], row["reason"], row["sent_at"]) == ("skipped", reason, None)
    # The arrival is untouched.
    attendance = await owner_conn.fetchval(
        "SELECT kind FROM appointment_attendance WHERE appointment_id = $1", uuid.UUID(appt)
    )
    assert attendance == "arrived"


async def test_an_address_cleared_before_the_claim_skips_the_row(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    await set_address(env, REAL_LOOKING)
    _, body = await arrive(env)
    await set_address(env, None)
    claim = await env.req("POST", notice_path(body["doctor_notice"]["id"], "claim"))
    assert claim.json()["send"] is None
    assert [(r["status"], r["reason"]) for r in await rows(owner_conn)] == [("skipped", "no_email")]


async def test_the_state_is_readable_by_staff_and_a_viewer_is_refused(env: Env) -> None:
    await set_address(env, REAL_LOOKING)
    appt, _ = await arrive(env)
    ok = await env.req("GET", appt_path(appt, "doctor-notification"))
    assert ok.status_code == 200 and ok.json()["status"] == "pending"
    assert "email" not in json.dumps(ok.json()).replace("no_email", "")
    assert (
        await env.req("GET", appt_path(appt, "doctor-notification"), role="viewer")
    ).status_code == 403
    unknown = await env.req("GET", appt_path(str(uuid.uuid4()), "doctor-notification"))
    assert unknown.status_code == 404


async def test_a_viewer_can_neither_claim_nor_finish(env: Env) -> None:
    await set_address(env, REAL_LOOKING)
    _, body = await arrive(env)
    notice = body["doctor_notice"]["id"]
    assert (await env.req("POST", notice_path(notice, "claim"), role="viewer")).status_code == 403
    finish = await env.req(
        "POST", notice_path(notice, "finish"), role="viewer", body={"outcome": "sent"}
    )
    assert finish.status_code == 403


# --- setting the address ------------------------------------------------------------------------


async def test_setting_the_address_normalises_it_and_audits_before_and_after(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    resp = await env.req(
        "PATCH",
        f"/internal/admin/doctors/{OTIENO}/email",
        role="admin",
        body={"email": "  Dr.Otieno@Clinic.CO.KE ", "reason": "the clinic's official address"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["email"] == "dr.otieno@clinic.co.ke" and resp.json()["audit_id"]
    assert await owner_conn.fetchval("SELECT email FROM doctors WHERE id = $1", OTIENO) == (
        "dr.otieno@clinic.co.ke"
    )
    (row,) = [r for r in await audit_rows(owner_conn) if r["action"] == "doctor_email"]
    assert row["reason"] == "the clinic's official address"
    assert row["actor_email"] == "admin@clinic.example" and row["appointment_id"] is None
    assert json.loads(row["before"])["email"] is None
    assert json.loads(row["after"])["email"] == "dr.otieno@clinic.co.ke"

    cleared = await set_address(env, None, role="owner")
    assert cleared.json()["email"] is None
    last = [r for r in await audit_rows(owner_conn) if r["action"] == "doctor_email"][-1]
    assert json.loads(last["before"])["email"] == "dr.otieno@clinic.co.ke"
    assert json.loads(last["after"])["email"] is None


async def test_setting_what_is_already_there_records_nothing(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    await set_address(env, REAL_LOOKING)
    again = await set_address(env, REAL_LOOKING)
    assert again.json()["audit_id"] is None
    assert len([r for r in await audit_rows(owner_conn) if r["action"] == "doctor_email"]) == 1


@pytest.mark.parametrize(
    "bad", ["no-at-sign", "two@@signs.com", "a b@clinic.co.ke", "x@nodot", "@clinic.co.ke", "a@b."]
)
async def test_a_malformed_address_is_refused_at_the_boundary(env: Env, bad: str) -> None:
    resp = await set_address(env, bad)
    assert resp.status_code == 422


async def test_a_reason_is_required_and_a_viewer_is_refused(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    path = f"/internal/admin/doctors/{OTIENO}/email"
    short = await env.req("PATCH", path, body={"email": REAL_LOOKING, "reason": "ab"})
    assert short.status_code == 422
    none = await env.req("PATCH", path, body={"email": REAL_LOOKING})
    assert none.status_code == 422
    viewer = await set_address(env, REAL_LOOKING, role="viewer")
    assert viewer.status_code == 403
    assert await owner_conn.fetchval("SELECT email FROM doctors WHERE id = $1", OTIENO) is None


async def test_an_unknown_doctor_is_a_404(env: Env) -> None:
    resp = await env.req(
        "PATCH",
        f"/internal/admin/doctors/{uuid.uuid4()}/email",
        body={"email": REAL_LOOKING, "reason": "the official address"},
    )
    assert resp.status_code == 404 and resp.json()["code"] == "DOCTOR_NOT_FOUND"


async def test_the_database_refuses_an_address_that_was_not_normalised(
    owner_conn: asyncpg.Connection,
) -> None:
    for bad in ("Dr@Clinic.co.ke", "no-at-sign", "a b@c.de"):
        with pytest.raises(asyncpg.CheckViolationError):
            await owner_conn.execute("UPDATE doctors SET email = $1 WHERE id = $2", bad, OTIENO)


# --- who can see it -----------------------------------------------------------------------------


async def test_the_address_shows_to_owner_and_admin_on_the_today_board_never_to_a_viewer(
    env: Env,
) -> None:
    await set_address(env, REAL_LOOKING)
    env.clock.set(START)

    def mine(board: dict[str, Any]) -> dict[str, Any]:
        return next(d for d in board["doctors"] if d["doctor_id"] == str(OTIENO))

    for role in ("owner", "admin"):
        got = await env.req("GET", "/internal/admin/ops/today", role=role)
        assert mine(got.json())["email"] == REAL_LOOKING
    viewer = await env.req("GET", "/internal/admin/ops/today", role="viewer")
    assert mine(viewer.json())["email"] is None
    assert REAL_LOOKING not in viewer.text


async def test_no_public_response_carries_the_address(env: Env) -> None:
    await set_address(env, REAL_LOOKING)
    listing = await env.client.get("/doctors")
    one = await env.client.get(f"/doctors/{OTIENO}")
    for resp in (listing, one):
        assert resp.status_code == 200
        assert REAL_LOOKING not in resp.text and '"email"' not in resp.text
    avail = await env.client.get(f"/doctors/{OTIENO}/availability?date=2026-10-27")
    assert REAL_LOOKING not in avail.text
    # An appointment's public read and a patient's own list carry the patient's details, never the
    # doctor's address.
    appt = await env.patient_book(TUE_10)
    public = await env.client.get(f"/appointments/{appt}")
    assert REAL_LOOKING not in public.text


async def test_the_row_is_written_in_the_arrivals_own_transaction(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    """If the record cannot be written, the arrival is not recorded either: they commit together."""
    await set_address(env, REAL_LOOKING)
    appt = await env.patient_book(TUE_10)
    env.clock.set(START)
    await owner_conn.execute("REVOKE INSERT ON doctor_notification FROM clinic_app")
    try:
        resp = await env.req("POST", appt_path(appt, "arrived"))
    finally:
        await owner_conn.execute("GRANT INSERT ON doctor_notification TO clinic_app")
    assert resp.status_code == 500
    marks = await owner_conn.fetchval(
        "SELECT count(*) FROM appointment_attendance WHERE appointment_id = $1", uuid.UUID(appt)
    )
    assert marks == 0
    assert await rows(owner_conn) == []
    assert [r for r in await audit_rows(owner_conn) if r["action"] == "arrived"] == []
    # With the privilege back, the same request succeeds and writes both.
    again = await env.req("POST", appt_path(appt, "arrived"))
    assert again.status_code == 200 and len(await rows(owner_conn)) == 1
