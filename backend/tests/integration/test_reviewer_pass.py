"""Reviewer passes on a real Postgres: a link any verified Google account can accept for a staff
role, up to a number of people and a number of days. Each guard has a test that fails when the
guard is removed."""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import uuid
from datetime import timedelta
from typing import Any

import asyncpg
import httpx
import pytest

from tests.conftest import app_dsn
from tests.integration.staff_support import ADMIN, OWNER, VIEWER, Env, audit_rows
from tests.integration.test_staff_crud import body_without_request_id

pytestmark = pytest.mark.asyncio

NEW = "reviewer.one@example.org"
OTHER = "reviewer.two@example.org"


async def make_pass(env: Env, **body: Any) -> dict[str, Any]:
    resp = await env.req("POST", "/internal/admin/passes", body=body)
    assert resp.status_code == 201, resp.text
    data: dict[str, Any] = resp.json()
    return data


async def accept(env: Env, token: str, email: str, *, verified: bool = True) -> httpx.Response:
    return await env.req(
        "POST",
        "/internal/admin/passes/accept",
        role="none",
        email=email,
        verified=verified,
        body={"token": token},
    )


async def listing(env: Env) -> list[dict[str, Any]]:
    resp = await env.req("GET", "/internal/admin/passes")
    assert resp.status_code == 200, resp.text
    items: list[dict[str, Any]] = resp.json()["items"]
    return items


# --- create ----------------------------------------------------------------------------------


async def test_create_defaults_and_what_is_stored(env: Env, owner_conn: asyncpg.Connection) -> None:
    made = await make_pass(env)
    assert made["role"] == "admin" and made["max_uses"] == 5 and made["used"] == 0
    assert made["status"] == "active" and made["uses"] == [] and made["created_by"] == OWNER
    token = made["token"]
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", token)
    row = await owner_conn.fetchrow(
        "SELECT * FROM staff_passes WHERE id = $1", uuid.UUID(made["id"])
    )
    assert row["token_hash"] == hashlib.sha256(token.encode()).hexdigest()
    assert token not in " ".join(str(v) for v in row.values())
    assert row["expires_at"] - row["created_at"] == timedelta(days=14)
    audit = await audit_rows(owner_conn)
    assert [(a["action"], a["actor_email"]) for a in audit] == [("pass_create", OWNER)]
    assert token not in json.dumps(dict(audit[0]), default=str)
    assert str(audit[0]["id"]) == made["audit_id"]


async def test_create_takes_the_role_the_people_and_the_days(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    made = await make_pass(env, role="viewer", max_uses=10, days=30)
    assert (made["role"], made["max_uses"]) == ("viewer", 10)
    row = await owner_conn.fetchrow("SELECT created_at, expires_at FROM staff_passes")
    assert row["expires_at"] - row["created_at"] == timedelta(days=30)


@pytest.mark.parametrize(
    "body",
    [
        {"max_uses": 0},
        {"max_uses": 11},
        {"days": 0},
        {"days": 31},
        {"role": "owner"},
        {"role": "superuser"},
        {"max_uses": "five"},
        {"extra": 1},
    ],
)
async def test_create_refuses_values_out_of_bounds(env: Env, body: dict[str, Any]) -> None:
    resp = await env.req("POST", "/internal/admin/passes", body=body)
    assert resp.status_code == 422, resp.text
    assert await listing(env) == []


@pytest.mark.parametrize("role", ["admin", "viewer", "none"])
async def test_only_the_owner_creates_lists_and_revokes(env: Env, role: str) -> None:
    made = await make_pass(env)
    email = {"admin": ADMIN, "viewer": VIEWER, "none": "nobody@example.org"}[role]
    calls = [
        ("POST", "/internal/admin/passes", {"role": "admin"}),
        ("GET", "/internal/admin/passes", None),
        ("DELETE", f"/internal/admin/passes/{made['id']}", None),
    ]
    for method, path, body in calls:
        resp = await env.req(method, path, role=role, email=email, body=body)
        assert resp.status_code == 403, (method, resp.text)
    assert [p["status"] for p in await listing(env)] == ["active"]


async def test_five_passes_a_day_and_a_revoke_does_not_refund(env: Env) -> None:
    for _ in range(5):
        made = await make_pass(env)
        await env.req("DELETE", f"/internal/admin/passes/{made['id']}")
    over = await env.req("POST", "/internal/admin/passes", body={})
    assert over.status_code == 429 and over.json()["code"] == "RATE_LIMITED"
    assert int(over.headers["retry-after"]) > 0
    env.clock.set(env.clock.now() + timedelta(hours=24, minutes=1))
    assert (await env.req("POST", "/internal/admin/passes", body={})).status_code == 201


# --- accept ----------------------------------------------------------------------------------


async def test_accept_grants_the_role_and_writes_the_trail(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    made = await make_pass(env, role="admin")
    resp = await accept(env, made["token"], "Reviewer.One@Example.org")
    assert resp.status_code == 200, resp.text
    assert resp.headers["cache-control"] == "no-store"
    assert (resp.json()["email"], resp.json()["role"], resp.json()["granted_by"]) == (
        NEW,
        "admin",
        OWNER,
    )
    assert (resp.json()["joined"], resp.json()["use"], resp.json()["of"]) == (True, 1, 5)
    assert resp.json()["pass_id"] == made["id"]
    me = await env.req("GET", "/internal/admin/session", role="admin", email=NEW)
    assert me.json()["role"] == "admin"
    grant = await owner_conn.fetchrow(
        "SELECT actor_email, action, target_email, new_role::text FROM staff_access_audit "
        "WHERE target_email = $1",
        NEW,
    )
    assert tuple(grant) == (OWNER, "grant", NEW, "admin")
    uses = await owner_conn.fetch("SELECT email::text, pass_id FROM staff_pass_uses")
    assert [(u["email"], str(u["pass_id"])) for u in uses] == [(NEW, made["id"])]
    audit = await audit_rows(owner_conn)
    assert [a["action"] for a in audit] == ["pass_create", "pass_accept"]
    accepted = audit[1]
    assert (accepted["actor_email"], accepted["actor_role"]) == (NEW, "admin")
    after = json.loads(accepted["after"])
    assert after == {
        "pass_id": made["id"],
        "email_hash": hashlib.sha256(NEW.encode()).hexdigest(),
        "role": "admin",
        "use": 1,
        "of": 5,
    }
    assert NEW not in json.dumps(after) and made["token"] not in json.dumps(after)


async def test_a_viewer_pass_grants_viewer(env: Env) -> None:
    made = await make_pass(env, role="viewer")
    assert (await accept(env, made["token"], NEW)).json()["role"] == "viewer"
    me = await env.req("GET", "/internal/admin/session", role="viewer", email=NEW)
    assert me.json()["role"] == "viewer"


async def test_each_new_person_takes_the_next_seat(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    made = await make_pass(env, max_uses=3)
    assert (await accept(env, made["token"], NEW)).status_code == 200
    assert (await accept(env, made["token"], OTHER)).status_code == 200
    seats = [json.loads(a["after"]).get("use") for a in await audit_rows(owner_conn)]
    assert seats == [None, 1, 2]
    (item,) = await listing(env)
    assert (item["used"], item["status"]) == (2, "active")
    assert [u["email"] for u in item["uses"]] == [NEW, OTHER]


async def test_the_same_person_twice_uses_one_seat(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    made = await make_pass(env, max_uses=2)
    first = await accept(env, made["token"], NEW)
    rows_after_first = len(await audit_rows(owner_conn))
    again = await accept(env, made["token"], NEW)
    assert first.status_code == again.status_code == 200
    # The same entry; only the account of what the call did differs.
    assert first.json()["joined"] is True and again.json()["joined"] is False
    assert (first.json()["use"], again.json()["use"], again.json()["of"]) == (1, 1, 2)
    assert {k: v for k, v in again.json().items() if k != "joined"} == {
        k: v for k, v in first.json().items() if k != "joined"
    }
    assert len(await audit_rows(owner_conn)) == rows_after_first
    assert await owner_conn.fetchval("SELECT count(*) FROM staff_pass_uses") == 1
    assert await owner_conn.fetchval("SELECT count(*) FROM staff_access_audit") == 1
    # The seat that was not spent is still there.
    assert (await accept(env, made["token"], OTHER)).status_code == 200


async def test_existing_staff_get_their_entry_and_keep_their_role(env: Env) -> None:
    made = await make_pass(env, role="admin")
    resp = await accept(env, made["token"], VIEWER)
    assert resp.status_code == 200 and resp.json()["role"] == "viewer"
    (item,) = await listing(env)
    assert item["used"] == 0


async def test_existing_staff_on_a_dead_pass_get_the_404(env: Env) -> None:
    made = await make_pass(env)
    await env.req("DELETE", f"/internal/admin/passes/{made['id']}")
    resp = await accept(env, made["token"], VIEWER)
    assert resp.status_code == 404 and resp.json()["code"] == "PASS_INVALID"


async def test_existing_staff_on_a_used_up_pass_get_the_404(env: Env) -> None:
    made = await make_pass(env, max_uses=1)
    assert (await accept(env, made["token"], NEW)).status_code == 200
    # NEW now holds the last seat, and is already staff: the used-up pass still answers 404.
    resp = await accept(env, made["token"], NEW)
    assert resp.status_code == 404 and resp.json()["code"] == "PASS_INVALID"


async def test_a_pass_with_no_seats_left_is_refused(env: Env) -> None:
    made = await make_pass(env, max_uses=1)
    assert (await accept(env, made["token"], NEW)).status_code == 200
    resp = await accept(env, made["token"], OTHER)
    assert resp.status_code == 404 and resp.json()["code"] == "PASS_INVALID"
    assert (await listing(env))[0]["status"] == "used_up"
    me = await env.req("GET", "/internal/admin/session", role="none", email=OTHER)
    assert me.json()["role"] is None


async def test_a_pass_expires(env: Env, owner_conn: asyncpg.Connection) -> None:
    made = await make_pass(env, days=1)
    env.clock.set(env.clock.now() + timedelta(days=1, seconds=1))
    resp = await accept(env, made["token"], NEW)
    assert resp.status_code == 404 and resp.json()["code"] == "PASS_INVALID"
    assert (await listing(env))[0]["status"] == "expired"
    assert await owner_conn.fetchval("SELECT count(*) FROM staff_pass_uses") == 0


async def test_a_revoked_pass_is_refused_and_keeps_the_people_who_joined(env: Env) -> None:
    made = await make_pass(env)
    assert (await accept(env, made["token"], NEW)).status_code == 200
    revoked = await env.req("DELETE", f"/internal/admin/passes/{made['id']}")
    assert revoked.status_code == 200 and revoked.json()["status"] == "revoked"
    resp = await accept(env, made["token"], OTHER)
    assert resp.status_code == 404 and resp.json()["code"] == "PASS_INVALID"
    # The person who joined first is still staff: a pass revoke is not a person revoke.
    me = await env.req("GET", "/internal/admin/session", role="admin", email=NEW)
    assert me.json()["role"] == "admin"


async def test_a_pass_never_undoes_a_revoke(env: Env, owner_conn: asyncpg.Connection) -> None:
    made = await make_pass(env)
    assert (await accept(env, made["token"], NEW)).status_code == 200
    assert (await env.req("DELETE", f"/internal/admin/access/{NEW}")).status_code == 200
    resp = await accept(env, made["token"], NEW)
    assert resp.status_code == 404 and resp.json()["code"] == "PASS_INVALID"
    me = await env.req("GET", "/internal/admin/session", role="none", email=NEW)
    assert me.json()["role"] is None
    assert await owner_conn.fetchval(
        "SELECT revoked_at IS NOT NULL FROM staff_access WHERE email = $1", NEW
    )
    assert await owner_conn.fetchval("SELECT count(*) FROM staff_pass_uses") == 1


async def test_an_owner_address_cannot_use_a_pass(env: Env) -> None:
    made = await make_pass(env)
    resp = await accept(env, made["token"], OWNER)
    assert resp.status_code == 404 and resp.json()["code"] == "PASS_INVALID"
    assert (await listing(env))[0]["used"] == 0


async def test_an_unverified_email_is_refused_and_not_counted(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    made = await make_pass(env)
    resp = await accept(env, made["token"], NEW, verified=False)
    assert resp.status_code == 404 and resp.json()["code"] == "PASS_INVALID"
    assert await owner_conn.fetchval("SELECT count(*) FROM invite_accept_cap") == 0
    assert (await accept(env, made["token"], NEW)).status_code == 200
    assert await owner_conn.fetchval("SELECT n FROM invite_accept_cap") == 1


async def test_a_pass_is_void_once_its_creator_is_no_longer_the_owner(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    made = await make_pass(env)
    await owner_conn.execute("UPDATE staff_passes SET created_by = $1", ADMIN)
    resp = await accept(env, made["token"], NEW)
    assert resp.status_code == 404 and resp.json()["code"] == "PASS_INVALID"
    await owner_conn.execute("UPDATE staff_passes SET created_by = $1", "gone@example.org")
    assert (await accept(env, made["token"], NEW)).status_code == 404


async def test_twenty_attempts_a_day_per_address(env: Env) -> None:
    for _ in range(20):
        assert (await accept(env, secrets.token_urlsafe(32), NEW)).status_code == 404
    over = await accept(env, secrets.token_urlsafe(32), NEW)
    assert over.status_code == 429 and over.json()["code"] == "RATE_LIMITED"
    assert int(over.headers["retry-after"]) > 0
    # Another address has its own budget, and the right token still works for it.
    made = await make_pass(env)
    assert (await accept(env, made["token"], OTHER)).status_code == 200
    # The limiter is shared with invitations: the day's attempts are one budget.
    assert (await accept(env, made["token"], NEW)).status_code == 429


async def test_every_failure_is_the_same_404(env: Env) -> None:
    good = await make_pass(env)
    used_up = await make_pass(env, max_uses=1)
    assert (await accept(env, used_up["token"], "first@example.org")).status_code == 200
    revoked = await make_pass(env)
    await env.req("DELETE", f"/internal/admin/passes/{revoked['id']}")
    expired = await make_pass(env, days=1)
    env.clock.set(env.clock.now() + timedelta(days=1, minutes=1))
    gone = await make_pass(env)
    await env.req("DELETE", f"/internal/admin/access/{ADMIN}")  # unrelated; leaves passes alone
    cases = [
        ("used up", await accept(env, used_up["token"], "second@example.org")),
        ("revoked", await accept(env, revoked["token"], "c@example.org")),
        ("expired", await accept(env, expired["token"], "d@example.org")),
        ("unknown", await accept(env, secrets.token_urlsafe(32), "e@example.org")),
        ("owner", await accept(env, gone["token"], OWNER)),
        ("unverified", await accept(env, good["token"], "f@example.org", verified=False)),
    ]
    for name, resp in cases:
        assert resp.status_code == 404, name
        assert resp.json()["code"] == "PASS_INVALID", name
    bodies = {json.dumps(body_without_request_id(r), sort_keys=True) for _, r in cases}
    assert len(bodies) == 1, bodies


# --- list and revoke -------------------------------------------------------------------------


async def test_the_list_has_uses_and_never_the_secret(env: Env) -> None:
    active = await make_pass(env, max_uses=4)
    revoked = await make_pass(env)
    await env.req("DELETE", f"/internal/admin/passes/{revoked['id']}")
    expired = await make_pass(env, days=1)
    await accept(env, active["token"], NEW)
    resp = await env.req("GET", "/internal/admin/passes")
    assert resp.headers["cache-control"] == "no-store"
    by_id = {p["id"]: p for p in resp.json()["items"]}
    assert [u["email"] for u in by_id[active["id"]]["uses"]] == [NEW]
    assert by_id[active["id"]]["uses"][0]["used_at"]
    assert set(by_id[active["id"]]) == {
        "id",
        "role",
        "max_uses",
        "used",
        "created_by",
        "created_at",
        "expires_at",
        "revoked_at",
        "status",
        "uses",
    }
    for made in (active, revoked, expired):
        assert made["token"] not in resp.text
        assert hashlib.sha256(made["token"].encode()).hexdigest() not in resp.text
    env.clock.set(env.clock.now() + timedelta(days=1, minutes=1))
    statuses = {p["id"]: p["status"] for p in await listing(env)}
    assert (statuses[revoked["id"]], statuses[expired["id"]]) == ("revoked", "expired")


async def test_the_list_marks_active_and_used_up(env: Env) -> None:
    active = await make_pass(env, max_uses=4)
    full = await make_pass(env, max_uses=1)
    await accept(env, active["token"], NEW)
    await accept(env, full["token"], OTHER)
    statuses = {p["id"]: (p["status"], p["used"]) for p in await listing(env)}
    assert statuses == {active["id"]: ("active", 1), full["id"]: ("used_up", 1)}


async def test_revoke_writes_the_trail_and_a_second_revoke_is_404(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    made = await make_pass(env)
    resp = await env.req("DELETE", f"/internal/admin/passes/{made['id']}")
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "revoked" and resp.json()["revoked_at"] is not None
    row = await owner_conn.fetchrow("SELECT revoked_at, revoked_by FROM staff_passes")
    assert row["revoked_at"] is not None and row["revoked_by"] == OWNER
    assert [a["action"] for a in await audit_rows(owner_conn)] == ["pass_create", "pass_revoke"]
    again = await env.req("DELETE", f"/internal/admin/passes/{made['id']}")
    unknown = await env.req("DELETE", f"/internal/admin/passes/{uuid.uuid4()}")
    for r in (again, unknown):
        assert r.status_code == 404 and r.json()["code"] == "PASS_INVALID"
    # Same body but for the path it names.
    first, second = (body_without_request_id(r) for r in (again, unknown))
    first.pop("instance"), second.pop("instance")
    assert first == second


# --- the database ----------------------------------------------------------------------------


async def test_the_runtime_role_cannot_delete_or_rewrite_a_pass(env: Env) -> None:
    await make_pass(env)
    conn = await asyncpg.connect(app_dsn())
    try:
        for sql in (
            "DELETE FROM staff_passes",
            "DELETE FROM staff_pass_uses",
            "UPDATE staff_passes SET max_uses = 10",
            "UPDATE staff_passes SET role = 'admin'",
            "UPDATE staff_pass_uses SET email = 'x@example.org'",
        ):
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await conn.execute(sql)
    finally:
        await conn.close()


async def test_the_audit_check_keeps_every_earlier_action(owner_conn: asyncpg.Connection) -> None:
    definition = await owner_conn.fetchval(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
        "WHERE conname = 'staff_action_audit_action_check'"
    )
    names = set(re.findall(r"'([a-z_]+)'", definition))
    earlier = {
        "book", "reschedule", "cancel", "veto", "unlock", "invite_create", "invite_revoke",
        "invite_accept", "arrived", "no_show", "reminder_now", "running_late", "doctor_email",
    }  # fmt: skip
    assert earlier | {"pass_create", "pass_revoke", "pass_accept"} == names
