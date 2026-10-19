"""Review findings on the staff backend, each with the test that pins the fix."""

from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import asyncpg
import httpx
import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.services import booking
from tests.conftest import seeded_patient_id
from tests.integration.staff_support import (
    ADMIN,
    OTIENO,
    OWNER,
    PATIENT,
    TUE_10,
    TUE_11,
    VIEWER,
    Env,
    audit_rows,
)
from tests.integration.test_ops import SYNTH, add, eat

pytestmark = pytest.mark.asyncio


# --- 4: an admin reaches admin through an invitation, not a PATCH ------------------------------


async def test_an_admin_cannot_promote_a_viewer_to_admin_but_the_owner_can(env: Env) -> None:
    refused = await env.req(
        "PATCH", f"/internal/admin/access/{VIEWER}", role="admin", body={"role": "admin"}
    )
    assert refused.status_code == 403
    assert refused.json()["code"] == "ROLE_ESCALATION"
    still = await env.req("GET", "/internal/admin/access")
    assert [i["role"] for i in still.json()["items"] if i["email"] == VIEWER] == ["viewer"]
    ok = await env.req(
        "PATCH", f"/internal/admin/access/{VIEWER}", role="owner", body={"role": "admin"}
    )
    assert ok.status_code == 200 and ok.json()["role"] == "admin"


async def test_admin_invites_are_the_owners_to_send(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    body = {"email": "n@clinic.example", "role": "admin"}
    refused = await env.req("POST", "/internal/admin/invites", role="admin", body=body)
    assert refused.status_code == 403 and refused.json()["code"] == "ROLE_ESCALATION"
    assert await owner_conn.fetchval("SELECT count(*) FROM staff_invites") == 0
    viewer = await env.req(
        "POST", "/internal/admin/invites", role="admin", body={**body, "role": "viewer"}
    )
    assert viewer.status_code == 201
    assert (await env.req("POST", "/internal/admin/invites", body=body)).status_code == 201


async def test_an_admin_cannot_bring_back_an_admin_the_owner_revoked(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    other = "second.admin@clinic.example"
    await owner_conn.execute(
        "INSERT INTO staff_access (email, role, granted_by) VALUES ($1, 'admin', $2)", other, OWNER
    )
    assert (await env.req("DELETE", f"/internal/admin/access/{other}")).status_code == 200
    body = {"email": other, "role": "admin"}
    again = await env.req("POST", "/internal/admin/invites", role="admin", body=body)
    assert again.status_code == 403 and again.json()["code"] == "ROLE_ESCALATION"
    assert await owner_conn.fetchval("SELECT count(*) FROM staff_invites") == 0
    # The owner may; and the person then gets in only as what the owner invited.
    sent = await env.req("POST", "/internal/admin/invites", body=body)
    assert sent.status_code == 201
    accepted = await env.req(
        "POST",
        "/internal/admin/invites/accept",
        role="none",
        email=other,
        body={"token": sent.json()["token"]},
    )
    assert accepted.status_code == 200 and accepted.json()["role"] == "admin"


# --- 5: an unverified email is refused on every staff route ---


@pytest.mark.parametrize("verified", [False, None])
@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/internal/admin/appointments"),
        ("GET", "/internal/admin/ops/today"),
        ("GET", "/internal/admin/access"),
        ("GET", "/internal/admin/audit"),
        ("GET", "/internal/admin/session"),
    ],
)
async def test_an_unverified_email_is_refused(
    env: Env, method: str, path: str, verified: bool | None
) -> None:
    resp = await env.req(method, path, role="owner", verified=verified)
    if path.endswith("/session"):
        assert resp.status_code == 200  # who-am-I needs only a valid assertion
    else:
        assert resp.status_code == 403
        assert resp.json()["code"] == "FORBIDDEN"


async def test_a_verified_email_is_let_through(env: Env) -> None:
    assert (await env.req("GET", "/internal/admin/appointments", verified=True)).status_code == 200


# --- 6: staff never act on synthetic patients ---


@pytest_asyncio.fixture
async def synthetic(env: Env, owner_conn: asyncpg.Connection) -> AsyncIterator[uuid.UUID]:
    await owner_conn.execute("DELETE FROM patients WHERE id = $1", SYNTH)
    await owner_conn.execute(
        "INSERT INTO patients (id, full_name, email, synthetic) "
        "VALUES ($1, 'Release Smoke', 'smoke@example.com', true)",
        SYNTH,
    )
    appt = await add(owner_conn, OTIENO, SYNTH, eat(27, 10, 0))
    await owner_conn.execute(
        "INSERT INTO appointment_events (appointment_id, doctor_id, event_type, local_date, actor) "
        "VALUES ($1, $2, 'rescheduled', '2026-10-27', 'patient')",
        appt,
        OTIENO,
    )
    env.clock.set(eat(27, 10, 0))
    yield appt
    await owner_conn.execute("TRUNCATE appointment_events, appointments RESTART IDENTITY CASCADE")
    await owner_conn.execute("DELETE FROM patients WHERE id = $1", SYNTH)


async def test_staff_writes_on_a_synthetic_appointment_are_not_found(
    env: Env, owner_conn: asyncpg.Connection, synthetic: uuid.UUID
) -> None:
    base = f"/internal/admin/appointments/{synthetic}"
    calls = [
        ("PATCH", f"{base}/cancel", {"reason": "staff cancel"}),
        (
            "PATCH",
            f"{base}/reschedule",
            {"starts_at": "2026-10-27T14:00:00+03:00", "reason": "staff move"},
        ),
        ("POST", f"{base}/veto", {"reason": "staff veto"}),
        ("POST", f"{base}/unlock", {"reason": "staff unlock"}),
        ("POST", f"{base}/arrived", None),
        ("POST", f"{base}/no-show", None),
        ("POST", f"{base}/remind", None),
    ]
    for method, path, body in calls:
        resp = await env.req(method, path, body=body)
        assert resp.status_code == 404, (path, resp.text)
        assert resp.json()["code"] == "APPOINTMENT_NOT_FOUND"
    assert await audit_rows(owner_conn) == []
    assert (
        await owner_conn.fetchval("SELECT status FROM appointments WHERE id = $1", synthetic)
        == "booked"
    )


async def test_staff_cannot_book_for_a_synthetic_patient(env: Env, synthetic: uuid.UUID) -> None:
    resp = await env.req(
        "POST",
        "/internal/admin/appointments",
        body={
            "doctor_id": str(OTIENO),
            "patient_id": str(SYNTH),
            "starts_at": TUE_10,
            "reason": "desk booking",
        },
    )
    assert resp.status_code == 422
    assert resp.json()["code"] == "UNKNOWN_PATIENT"


# --- 8: invite and accept compare addresses after NFKC + casefold ---


async def accept(env: Env, token: str, email: str) -> httpx.Response:
    return await env.req(
        "POST", "/internal/admin/invites/accept", role="none", email=email, body={"token": token}
    )


@pytest.mark.parametrize(
    ("invited", "signs_in_as", "stored"),
    [
        ("ｎｅｗ.Ｄoc@Clinic.Example", "NEW.doc@clinic.example", "new.doc@clinic.example"),
        (
            "new.doc@clinic.example",
            "ｎｅｗ.ｄｏｃ@ｃｌｉｎｉｃ.ｅｘａｍｐｌｅ",
            "new.doc@clinic.example",
        ),
        ("Straße@clinic.example", "STRASSE@clinic.example", "strasse@clinic.example"),
    ],
)
async def test_invite_emails_are_compared_after_nfkc_and_casefold(
    env: Env, owner_conn: asyncpg.Connection, invited: str, signs_in_as: str, stored: str
) -> None:
    created = await env.req(
        "POST", "/internal/admin/invites", body={"email": invited, "role": "viewer"}
    )
    assert created.status_code == 201, created.text
    assert created.json()["email"] == stored
    resp = await accept(env, created.json()["token"], signs_in_as)
    assert resp.status_code == 200, resp.text
    assert resp.json()["email"] == stored
    row = await owner_conn.fetchval("SELECT email::text FROM staff_access WHERE email = $1", stored)
    assert row == stored
    me = await env.req("GET", "/internal/admin/session", role="viewer", email=signs_in_as)
    assert me.json()["role"] == "viewer"


async def test_a_lookalike_address_is_still_a_different_person(env: Env) -> None:
    created = await env.req(
        "POST", "/internal/admin/invites", body={"email": "alice@clinic.example", "role": "viewer"}
    )
    other = await accept(env, created.json()["token"], "alice@clinlc.example")
    assert other.status_code == 404


# --- 9: accepting is attempt-limited ---


async def test_accept_attempts_are_limited_per_person_per_day(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    await owner_conn.execute("TRUNCATE invite_accept_cap")
    guesses = [secrets.token_urlsafe(32) for _ in range(21)]
    bodies = []
    for token in guesses[:20]:
        r = await accept(env, token, "guesser@clinic.example")
        assert r.status_code == 404
        data = r.json()
        data.pop("request_id")
        bodies.append(json.dumps(data, sort_keys=True))
    assert len(set(bodies)) == 1  # the generic body is unchanged
    over = await accept(env, guesses[20], "guesser@clinic.example")
    assert over.status_code == 429
    assert over.json()["code"] == "RATE_LIMITED"
    assert int(over.headers["retry-after"]) > 0
    # A valid token is limited just the same, and stays unused.
    real = await env.req(
        "POST",
        "/internal/admin/invites",
        body={"email": "guesser@clinic.example", "role": "viewer"},
    )
    blocked = await accept(env, real.json()["token"], "guesser@clinic.example")
    assert blocked.status_code == 429
    assert (
        await owner_conn.fetchval(
            "SELECT consumed_at FROM staff_invites WHERE id = $1", uuid.UUID(real.json()["id"])
        )
        is None
    )
    # Someone else is not limited, and the next day starts afresh.
    other = await accept(env, guesses[0], "someone.else@clinic.example")
    assert other.status_code == 404
    env.clock.set(env.clock.now() + timedelta(days=1))
    good = await accept(env, real.json()["token"], "guesser@clinic.example")
    assert good.status_code == 200
    key = hashlib.sha256(b"guesser@clinic.example").hexdigest()
    assert (
        await owner_conn.fetchval("SELECT n FROM invite_accept_cap WHERE actor_key = $1", key) == 1
    )
    await owner_conn.execute("TRUNCATE invite_accept_cap")


_UNUSED = (ADMIN, OWNER)


# --- 7: who may mark an audit row notified ---


async def test_only_the_actor_can_mark_their_audit_row(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    appt = await env.patient_book()
    cancelled = await env.req(
        "PATCH", f"/internal/admin/appointments/{appt}/cancel", body={"reason": "patient phoned in"}
    )
    audit_id = cancelled.json()["audit_id"]
    other = await env.req("POST", f"/internal/admin/audit/{audit_id}/notified", role="admin")
    assert other.status_code == 404  # the same answer as an unknown id
    viewer = await env.req("POST", f"/internal/admin/audit/{audit_id}/notified", role="viewer")
    assert viewer.status_code == 403
    assert (await audit_rows(owner_conn))[0]["notified"] is False
    mine = await env.req("POST", f"/internal/admin/audit/{audit_id}/notified")
    assert mine.status_code == 200
    assert (await audit_rows(owner_conn))[0]["notified"] is True


async def test_a_row_recorded_as_not_sent_cannot_be_marked_notified(
    env: Env, owner_conn: asyncpg.Connection, app_conn: asyncpg.Connection
) -> None:
    demo = uuid.UUID("00000000-0000-4000-8000-0000000000d3")
    await owner_conn.execute("DELETE FROM patients WHERE id = $1", demo)
    await owner_conn.execute(
        "INSERT INTO patients (id, full_name, email) VALUES ($1, 'Demo Patient', 'd@example.com')",
        demo,
    )
    appt = await add(owner_conn, OTIENO, demo, eat(27, 10, 0))
    env.clock.set(eat(27, 8, 0))
    sent = await env.req("POST", f"/internal/admin/appointments/{appt}/remind", role="admin")
    audit_id = sent.json()["items"][0]["audit_id"]
    assert sent.json()["items"][0]["outcome"] == "demo, not sent"
    via_api = await env.req("POST", f"/internal/admin/audit/{audit_id}/notified", role="admin")
    assert via_api.status_code == 404
    # The database refuses it too, even for a caller that skips the API.
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        await app_conn.execute(
            "UPDATE staff_action_audit SET notified = true WHERE id = $1", uuid.UUID(audit_id)
        )
    assert (await audit_rows(owner_conn))[0]["notified"] is False
    await owner_conn.execute("TRUNCATE appointment_events, appointments RESTART IDENTITY CASCADE")
    await owner_conn.execute("DELETE FROM patients WHERE id = $1", demo)


async def test_an_action_that_sends_no_email_cannot_be_marked_notified(
    env: Env, owner_conn: asyncpg.Connection, app_conn: asyncpg.Connection
) -> None:
    appt = await env.patient_book(TUE_10)
    env.clock.set(eat(27, 10, 0))
    marked = await env.req("POST", f"/internal/admin/appointments/{appt}/arrived")
    audit_id = marked.json()["audit_id"]
    assert (await env.req("POST", f"/internal/admin/audit/{audit_id}/notified")).status_code == 404
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        await app_conn.execute(
            "UPDATE staff_action_audit SET notified = true WHERE id = $1", uuid.UUID(audit_id)
        )


# --- 10: the patient re-booking a vetoed slot is told it is locked ---


async def test_a_patient_rebooking_a_vetoed_cancel_gets_locked_not_slot_taken(env: Env) -> None:
    appt = await env.patient_book(TUE_10)
    await env.client.patch(f"/appointments/{appt}/cancel", json={"reason": "cannot make it"})
    veto = await env.req(
        "POST", f"/internal/admin/appointments/{appt}/veto", body={"reason": "insured only today"}
    )
    assert veto.status_code == 200
    same = await env.client.post(
        "/appointments",
        json={"doctor_id": str(OTIENO), "patient_id": str(PATIENT), "starts_at": TUE_10},
    )
    assert same.status_code == 409
    assert same.json()["code"] == "APPOINTMENT_LOCKED"
    stranger = await env.client.post(
        "/appointments",
        json={
            "doctor_id": str(OTIENO),
            "patient_id": str(seeded_patient_id("amina")),
            "starts_at": TUE_10,
        },
    )
    assert stranger.json()["code"] == "SLOT_TAKEN"  # someone else's slot is still just taken


# --- 11: concurrent vetoes ---


@pytest.fixture
def slow_writes(monkeypatch: pytest.MonkeyPatch) -> None:
    """Hold each write open for a moment so the racing request arrives while it is in flight."""

    async def slow(session: AsyncSession) -> None:
        await session.execute(text("SELECT pg_sleep(0.05)"))

    monkeypatch.setattr(booking, "_after_write", slow)


async def veto_twice(env: Env, appt: str) -> list[httpx.Response]:
    body = {"reason": "settled with the patient"}
    return list(
        await asyncio.gather(
            env.req("POST", f"/internal/admin/appointments/{appt}/veto", body=body),
            env.req("POST", f"/internal/admin/appointments/{appt}/veto", role="admin", body=body),
        )
    )


@pytest.mark.race
@pytest.mark.parametrize("round_", range(4))
async def test_two_vetoes_of_a_cancel_one_wins_the_other_has_nothing_to_veto(
    env: Env, slow_writes: None, round_: int
) -> None:
    appt = await env.patient_book(TUE_10)
    await env.client.patch(f"/appointments/{appt}/cancel", json={"reason": "cannot make it"})
    results = await veto_twice(env, appt)
    codes = sorted(r.status_code for r in results)
    assert codes == [200, 409], [r.text for r in results]
    loser = next(r for r in results if r.status_code == 409)
    assert loser.json()["code"] == "NOTHING_TO_VETO"


@pytest.mark.race
@pytest.mark.parametrize("round_", range(4))
async def test_two_vetoes_of_a_reschedule_one_wins_the_other_has_nothing_to_veto(
    env: Env, slow_writes: None, round_: int
) -> None:
    appt = await env.patient_book(TUE_10)
    await env.client.patch(f"/appointments/{appt}/reschedule", json={"starts_at": TUE_11})
    results = await veto_twice(env, appt)
    assert sorted(r.status_code for r in results) == [200, 409], [r.text for r in results]
    loser = next(r for r in results if r.status_code == 409)
    assert loser.json()["code"] == "NOTHING_TO_VETO"


@pytest.mark.race
@pytest.mark.parametrize("round_", range(4))
async def test_a_veto_racing_a_staff_rebooking_never_reports_slot_taken(
    env: Env, slow_writes: None, round_: int
) -> None:
    appt = await env.patient_book(TUE_10)
    await env.client.patch(f"/appointments/{appt}/cancel", json={"reason": "cannot make it"})
    rebook = {
        "doctor_id": str(OTIENO),
        "patient_id": str(PATIENT),
        "starts_at": TUE_10,
        "reason": "desk rebooking",
    }
    veto, create = await asyncio.gather(
        env.req(
            "POST",
            f"/internal/admin/appointments/{appt}/veto",
            body={"reason": "settled with the patient"},
        ),
        env.req("POST", "/internal/admin/appointments", role="admin", body=rebook),
    )
    assert {veto.status_code, create.status_code} in ({200, 409}, {409, 201}), (
        veto.text,
        create.text,
    )
    if veto.status_code == 409:
        assert veto.json()["code"] == "NOTHING_TO_VETO"  # the slot is already the patient's again
    else:
        assert create.json()["code"] == "SLOT_TAKEN"


# --- 12: events from before actors were recorded ---


async def test_an_event_with_no_recorded_actor_cannot_be_vetoed(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    appt = await env.patient_book(TUE_10)
    moved = await env.client.patch(f"/appointments/{appt}/reschedule", json={"starts_at": TUE_11})
    assert moved.status_code == 200
    await owner_conn.execute(
        "UPDATE appointment_events SET actor = NULL WHERE appointment_id = $1", uuid.UUID(appt)
    )
    unknown = await env.req(
        "POST", f"/internal/admin/appointments/{appt}/veto", body={"reason": "settled with patient"}
    )
    assert unknown.status_code == 409 and unknown.json()["code"] == "NOTHING_TO_VETO"
    await owner_conn.execute(
        "UPDATE appointment_events SET actor = 'patient' "
        "WHERE appointment_id = $1 AND event_type = 'rescheduled'",
        uuid.UUID(appt),
    )
    known = await env.req(
        "POST", f"/internal/admin/appointments/{appt}/veto", body={"reason": "settled with patient"}
    )
    assert known.status_code == 200


# --- 13: granted_by records who changed the role ---


async def test_a_role_change_records_who_made_it(env: Env, owner_conn: asyncpg.Connection) -> None:
    # Seed the original grant from the fake clock, a day earlier, so the comparison does not depend
    # on the wall clock the database happens to run under.
    await owner_conn.execute(
        "UPDATE staff_access SET granted_at = $2 WHERE email = $1",
        VIEWER,
        env.clock.now() - timedelta(days=1),
    )
    before = await owner_conn.fetchrow(
        "SELECT granted_by, granted_at FROM staff_access WHERE email = $1", VIEWER
    )
    assert before["granted_by"] == OWNER
    changed = await env.req(
        "PATCH", f"/internal/admin/access/{VIEWER}", role="admin", body={"role": "viewer"}
    )
    assert changed.status_code == 200
    assert changed.json()["granted_by"] == ADMIN
    after = await owner_conn.fetchrow(
        "SELECT granted_by, granted_at FROM staff_access WHERE email = $1", VIEWER
    )
    assert after["granted_by"] == ADMIN
    assert after["granted_at"] == env.clock.now() > before["granted_at"]
    audit = await owner_conn.fetchrow(
        "SELECT actor_email, action FROM staff_access_audit ORDER BY id DESC LIMIT 1"
    )
    assert tuple(audit) == (ADMIN, "change")


# --- a too-short or too-long reason says so in words ---


@pytest.mark.parametrize(
    ("method", "path", "extra"),
    [
        ("PATCH", "/cancel", {}),
        ("PATCH", "/reschedule", {"starts_at": TUE_11}),
        ("POST", "/veto", {}),
        ("POST", "/unlock", {}),
        ("POST", "/remind", {}),
        ("POST", "/running-late", {"minutes": 20}),
    ],
)
@pytest.mark.parametrize(
    ("reason", "message"),
    [
        ("ab", "Give a reason of at least 3 characters."),
        ("x" * 501, "Keep the reason to 500 characters or fewer."),
    ],
)
async def test_a_bad_reason_is_explained_in_plain_words(
    env: Env, method: str, path: str, extra: dict[str, object], reason: str, message: str
) -> None:
    appt = await env.patient_book()
    url = (
        f"/internal/admin/doctors/{OTIENO}{path}"
        if path == "/running-late"
        else f"/internal/admin/appointments/{appt}{path}"
    )
    resp = await env.req(method, url, body={**extra, "reason": reason})
    assert resp.status_code == 422, resp.text
    body = resp.json()
    assert body["code"] == "VALIDATION_ERROR"
    assert body["errors"][0]["loc"] == ["body", "reason"]
    assert body["errors"][0]["msg"] == message
    assert body["detail"] == message
    assert "items" not in resp.text


# --- invitations are audited and carry what the email sender needs ---


async def test_creating_and_revoking_an_invite_each_leave_one_audit_row(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    address = "audited.person@clinic.co.ke"
    created = await env.req(
        "POST", "/internal/admin/invites", role="admin", body={"email": address, "role": "viewer"}
    )
    assert created.status_code == 201
    data = created.json()
    assert data["deliver"] is True and data["outcome"] == "to send"
    rows = await audit_rows(owner_conn)
    assert [r["action"] for r in rows] == ["invite_create"]
    assert str(rows[0]["id"]) == data["audit_id"] and rows[0]["notified"] is False
    assert (rows[0]["actor_email"], rows[0]["actor_role"]) == (ADMIN, "admin")
    after = json.loads(rows[0]["after"])
    assert after["invite_id"] == data["id"] and after["role"] == "viewer"
    assert after["email_hash"] == hashlib.sha256(address.encode()).hexdigest()
    assert "audited.person" not in f"{rows[0]['before']} {rows[0]['after']} {rows[0]['reason']}"
    revoked = await env.req("DELETE", f"/internal/admin/invites/{data['id']}")
    assert revoked.status_code == 200 and revoked.json()["audit_id"]
    rows = await audit_rows(owner_conn)
    assert [r["action"] for r in rows] == ["invite_create", "invite_revoke"]
    assert "audited.person" not in " ".join(f"{r['before']} {r['after']}" for r in rows)
    # A failed revoke writes nothing.
    again = await env.req("DELETE", f"/internal/admin/invites/{data['id']}")
    assert again.status_code == 404 and len(await audit_rows(owner_conn)) == 2


async def test_re_inviting_audits_the_superseded_invite_too(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    body = {"email": "twice@clinic.example", "role": "viewer"}
    await env.req("POST", "/internal/admin/invites", body=body)
    await env.req("POST", "/internal/admin/invites", body=body)
    assert [r["action"] for r in await audit_rows(owner_conn)] == [
        "invite_create",
        "invite_revoke",
        "invite_create",
    ]


async def test_the_sender_marks_an_invite_notified_and_a_demo_invite_cannot_be(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    real = await env.req(
        "POST", "/internal/admin/invites", body={"email": "real@clinic.co.ke", "role": "viewer"}
    )
    demo = await env.req(
        "POST", "/internal/admin/invites", body={"email": "demo@example.com", "role": "viewer"}
    )
    assert demo.json()["deliver"] is False and demo.json()["outcome"] == "demo, not sent"
    other = await env.req(
        "POST", f"/internal/admin/audit/{real.json()['audit_id']}/notified", role="admin"
    )
    assert other.status_code == 404  # only the inviter can say the email went
    done = await env.req("POST", f"/internal/admin/audit/{real.json()['audit_id']}/notified")
    assert done.status_code == 200
    refused = await env.req("POST", f"/internal/admin/audit/{demo.json()['audit_id']}/notified")
    assert refused.status_code == 404
    flags = {str(r["id"]): r["notified"] for r in await audit_rows(owner_conn)}
    assert flags == {real.json()["audit_id"]: True, demo.json()["audit_id"]: False}


# --- the database holds the notified and invite limits itself ---


async def test_notified_needs_the_actor_even_for_a_direct_writer(
    env: Env, owner_conn: asyncpg.Connection, app_conn: asyncpg.Connection
) -> None:
    appt = await env.patient_book()
    cancelled = await env.req(
        "PATCH", f"/internal/admin/appointments/{appt}/cancel", body={"reason": "patient phoned in"}
    )
    audit_id = uuid.UUID(cancelled.json()["audit_id"])
    update = "UPDATE staff_action_audit SET notified = true WHERE id = $1"
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        await app_conn.execute(update, audit_id)  # no actor named
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        async with app_conn.transaction():
            await app_conn.execute("SELECT set_config('app.actor', $1, true)", ADMIN)
            await app_conn.execute(update, audit_id)  # somebody else
    async with app_conn.transaction():
        await app_conn.execute("SELECT set_config('app.actor', $1, true)", OWNER)
        await app_conn.execute(update, audit_id)
    assert (await audit_rows(owner_conn))[0]["notified"] is True


async def test_an_invite_row_can_change_only_in_its_life_columns(
    env: Env, app_conn: asyncpg.Connection
) -> None:
    created = await env.req(
        "POST", "/internal/admin/invites", body={"email": "grant@clinic.example", "role": "viewer"}
    )
    invite_id = uuid.UUID(created.json()["id"])
    for statement in [
        "UPDATE staff_invites SET role = 'admin' WHERE id = $1",
        "UPDATE staff_invites SET email = 'other@clinic.co.ke' WHERE id = $1",
        "UPDATE staff_invites SET expires_at = now() + interval '1 year' WHERE id = $1",
        "UPDATE staff_invites SET token_hash = repeat('b', 64) WHERE id = $1",
        "UPDATE staff_invites SET invited_by = 'x' WHERE id = $1",
    ]:
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await app_conn.execute(statement, invite_id)
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        await app_conn.execute("DELETE FROM staff_invites WHERE id = $1", invite_id)


# --- addresses the database cannot lower the same way ---


@pytest.mark.parametrize(
    "address",
    [
        "ꭰꮒꮤ@clinic.example",
        "ᏣᎳᎩ@clinic.example",
        "İstanbul@clinic.example",
        "ΣΊΣΥΦΟΣ@clinic.example",
    ],
)
async def test_unusual_scripts_never_make_a_500(env: Env, address: str) -> None:
    resp = await env.req(
        "POST", "/internal/admin/invites", body={"email": address, "role": "viewer"}
    )
    assert resp.status_code in (201, 422), resp.text
    if resp.status_code == 201:
        accepted = await accept(env, resp.json()["token"], address)
        assert accepted.status_code == 200, accepted.text


async def test_the_veto_decision_is_taken_again_inside_the_write(
    env: Env, owner_conn: asyncpg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A veto whose early read (no successor yet) is stale still cannot re-book twice: the check is
    repeated under the cancelled row's lock."""
    from app.repositories import appointments as appt_repo

    appt = await env.patient_book(TUE_10)
    await env.client.patch(f"/appointments/{appt}/cancel", json={"reason": "cannot make it"})
    first = await env.req(
        "POST", f"/internal/admin/appointments/{appt}/veto", body={"reason": "settled with patient"}
    )
    assert first.status_code == 200
    real = appt_repo.has_successor
    calls = {"n": 0}

    async def stale_first(session: AsyncSession, appointment_id: uuid.UUID) -> bool:
        calls["n"] += 1
        return False if calls["n"] == 1 else await real(session, appointment_id)

    monkeypatch.setattr(appt_repo, "has_successor", stale_first)
    second = await env.req(
        "POST", f"/internal/admin/appointments/{appt}/veto", body={"reason": "settled with patient"}
    )
    assert second.status_code == 409 and second.json()["code"] == "NOTHING_TO_VETO"
    assert calls["n"] >= 2  # the early read was fooled; the one inside the write was not
    count = await owner_conn.fetchval(
        "SELECT count(*) FROM appointments WHERE predecessor_id = $1", uuid.UUID(appt)
    )
    assert count == 1


async def test_a_repeated_staff_booking_does_not_create_the_person_twice(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    person = {
        "full_name": "Walk In Person",
        "phone": "+254733000111",
        "email": "walkin.person@clinic.co.ke",
    }
    first = await env.req(
        "POST",
        "/internal/admin/appointments",
        body={
            "doctor_id": str(OTIENO),
            "patient": person,
            "starts_at": TUE_10,
            "reason": "desk booking",
        },
    )
    assert first.status_code == 201
    patients = await owner_conn.fetchval("SELECT count(*) FROM patients")
    again = await env.req(
        "POST",
        "/internal/admin/appointments",
        body={
            "doctor_id": str(OTIENO),
            "patient": person,
            "starts_at": TUE_10,
            "reason": "desk booking",
        },
    )
    assert again.status_code == 409  # the slot, not a second person
    other_slot = await env.req(
        "POST",
        "/internal/admin/appointments",
        body={
            "doctor_id": str(OTIENO),
            "patient": {**person, "full_name": "walk in person"},
            "starts_at": TUE_11,
            "reason": "second visit",
        },
    )
    assert other_slot.status_code == 201
    assert other_slot.json()["patient_id"] == first.json()["patient_id"]
    assert await owner_conn.fetchval("SELECT count(*) FROM patients") == patients
    # The same phone under another name is still refused, not merged.
    clash = await env.req(
        "POST",
        "/internal/admin/appointments",
        body={
            "doctor_id": str(OTIENO),
            "patient": {**person, "full_name": "Someone Else"},
            "starts_at": "2026-10-27T11:30:00+03:00",
            "reason": "desk booking",
        },
    )
    assert clash.status_code == 409 and clash.json()["code"] == "PATIENT_PHONE_EXISTS"
    await owner_conn.execute("DELETE FROM appointment_events")
    await owner_conn.execute("TRUNCATE appointments CASCADE")
    await owner_conn.execute("DELETE FROM patients WHERE phone = '+254733000111'")


async def test_access_timestamps_come_from_the_injected_clock(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    env.clock.set(datetime(2031, 3, 4, 5, 6, tzinfo=UTC))
    granted = await env.req(
        "POST",
        "/internal/admin/access",
        body={"email": "clock.test@clinic.co.ke", "role": "viewer"},
    )
    assert granted.status_code == 201
    row = await owner_conn.fetchrow(
        "SELECT granted_at FROM staff_access WHERE email = 'clock.test@clinic.co.ke'"
    )
    assert row["granted_at"] == datetime(2031, 3, 4, 5, 6, tzinfo=UTC)
    env.clock.set(datetime(2031, 3, 5, 5, 6, tzinfo=UTC))
    await env.req("PATCH", "/internal/admin/access/clock.test@clinic.co.ke", body={"role": "admin"})
    changed = await owner_conn.fetchval(
        "SELECT granted_at FROM staff_access WHERE email = 'clock.test@clinic.co.ke'"
    )
    assert changed == datetime(2031, 3, 5, 5, 6, tzinfo=UTC)
    env.clock.set(datetime(2031, 3, 6, 5, 6, tzinfo=UTC))
    await env.req("DELETE", "/internal/admin/access/clock.test@clinic.co.ke")
    revoked = await owner_conn.fetchval(
        "SELECT revoked_at FROM staff_access WHERE email = 'clock.test@clinic.co.ke'"
    )
    assert revoked == datetime(2031, 3, 6, 5, 6, tzinfo=UTC)


# --- revoked access stays revoked unless the owner says otherwise ---


@pytest.mark.parametrize("role", ["admin", "viewer"])
@pytest.mark.parametrize("was", ["admin", "viewer"])
async def test_an_admin_cannot_invite_an_address_whose_access_was_revoked(
    env: Env, owner_conn: asyncpg.Connection, was: str, role: str
) -> None:
    address = "revoked.person@clinic.co.ke"
    await owner_conn.execute(
        "INSERT INTO staff_access (email, role, granted_by) VALUES ($1, $2, $3)",
        address,
        was,
        OWNER,
    )
    assert (await env.req("DELETE", f"/internal/admin/access/{address}")).status_code == 200
    again = await env.req(
        "POST", "/internal/admin/invites", role="admin", body={"email": address, "role": role}
    )
    assert again.status_code == 403 and again.json()["code"] == "ROLE_ESCALATION"
    assert await owner_conn.fetchval("SELECT count(*) FROM staff_invites") == 0
    by_owner = await env.req(
        "POST", "/internal/admin/invites", body={"email": address, "role": role}
    )
    assert by_owner.status_code == 201
    accepted = await accept(env, by_owner.json()["token"], address)
    assert accepted.status_code == 200 and accepted.json()["role"] == role


async def test_an_admin_can_still_invite_a_new_address_as_a_viewer(env: Env) -> None:
    resp = await env.req(
        "POST",
        "/internal/admin/invites",
        role="admin",
        body={"email": "fresh@clinic.co.ke", "role": "viewer"},
    )
    assert resp.status_code == 201


# --- an owner's pending admin invitation is the owner's to revoke ---


async def test_only_the_owner_can_revoke_an_admin_invitation(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    sent = await env.req(
        "POST",
        "/internal/admin/invites",
        body={"email": "future.admin@clinic.co.ke", "role": "admin"},
    )
    invite_id = sent.json()["id"]
    refused = await env.req("DELETE", f"/internal/admin/invites/{invite_id}", role="admin")
    assert refused.status_code == 403 and refused.json()["code"] == "ROLE_ESCALATION"
    assert (
        await owner_conn.fetchval(
            "SELECT revoked_at FROM staff_invites WHERE id = $1", uuid.UUID(invite_id)
        )
        is None
    )
    assert (await env.req("DELETE", f"/internal/admin/invites/{invite_id}")).status_code == 200
    # An admin still revokes invitations to be a viewer.
    viewer = await env.req(
        "POST",
        "/internal/admin/invites",
        role="admin",
        body={"email": "future.viewer@clinic.co.ke", "role": "viewer"},
    )
    assert (
        await env.req("DELETE", f"/internal/admin/invites/{viewer.json()['id']}", role="admin")
    ).status_code == 200


# --- unverified identities cannot spend a person's attempts ---


async def test_an_unverified_identity_cannot_use_up_someone_elses_accept_attempts(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    await owner_conn.execute("TRUNCATE invite_accept_cap")
    victim = "victim@clinic.co.ke"
    for _ in range(25):
        r = await env.req(
            "POST",
            "/internal/admin/invites/accept",
            role="none",
            email=victim,
            verified=False,
            body={"token": secrets.token_urlsafe(32)},
        )
        assert r.status_code == 404
    assert await owner_conn.fetchval("SELECT count(*) FROM invite_accept_cap") == 0
    sent = await env.req(
        "POST", "/internal/admin/invites", body={"email": victim, "role": "viewer"}
    )
    ok = await accept(env, sent.json()["token"], victim)
    assert ok.status_code == 200


# --- the switch also turns the staff exemption off on the existing routes ---


async def make_env(flag: bool) -> tuple[Env, httpx.AsyncClient]:
    from app.api.deps import get_clock
    from app.core.clock import FakeClock
    from app.main import create_app
    from tests.conftest import FIXED_NOW, make_settings
    from tests.integration.staff_support import KEY

    clock = FakeClock(FIXED_NOW)
    app = create_app(
        make_settings(INTERNAL_SIGNING_KEY=KEY, ADMIN_EMAILS=OWNER, STAFF_CRUD_ENABLED=flag)
    )
    app.dependency_overrides[get_clock] = lambda: clock
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
    )
    return Env(client, clock), client


@pytest.mark.parametrize("flag", [True, False])
async def test_the_switch_governs_the_staff_lead_time_exemption(
    env: Env, owner_conn: asyncpg.Connection, flag: bool
) -> None:
    appt = await env.patient_book(TUE_10)
    appt2 = await env.patient_book("2026-10-27T11:00:00+03:00")
    other, client = await make_env(flag)
    try:
        other.clock.set(datetime(2026, 10, 27, 6, 20, tzinfo=UTC))  # 09:20, 40 minutes before 10:00
        cancel = await other.req(
            "PATCH",
            f"/internal/admin/appointments/{appt}/cancel",
            body={"reason": "doctor called in sick"},
        )
        move_new = await other.req(
            "PATCH",
            f"/internal/admin/appointments/{appt2}/reschedule",
            body={"starts_at": "2026-10-27T09:30:00+03:00", "reason": "walk-in at the desk"},
        )
        if flag:
            assert cancel.status_code == 200 and move_new.status_code == 200
        else:
            assert (cancel.status_code, cancel.json()["code"]) == (409, "CHANGE_TOO_LATE")
            assert (move_new.status_code, move_new.json()["code"]) == (422, "BOOKING_TOO_SOON")
            # nothing changed, nothing audited
            assert (
                await owner_conn.fetchval(
                    "SELECT status FROM appointments WHERE id = $1", uuid.UUID(appt)
                )
                == "booked"
            )
            assert await audit_rows(owner_conn) == []
    finally:
        await client.aclose()
