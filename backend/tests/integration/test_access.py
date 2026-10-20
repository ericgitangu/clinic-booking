"""Staff roles: the allow/deny matrix, managing access, and revocation on the next request."""

from __future__ import annotations

import secrets
import uuid
from collections.abc import AsyncIterator, Callable
from datetime import datetime
from typing import Any

import asyncpg
import httpx
import pytest
import pytest_asyncio

from app.api.deps import get_clock
from app.core.assertion import AUDIENCE, body_hash, sign
from app.core.clock import FakeClock
from app.main import create_app
from tests.conftest import FIXED_NOW, make_settings, seeded_doctor_id, seeded_patient_id

pytestmark = pytest.mark.asyncio

KEY = secrets.token_hex(24)  # fresh per run: a throwaway key, never a literal
OWNER = "owner@clinic.example"
ADMIN = "admin@clinic.example"
VIEWER = "viewer@clinic.example"
STRANGER = "stranger@clinic.example"
APPT = uuid.UUID("00000000-0000-4000-8000-0000000000b1")

ROLE_EMAIL = {"owner": OWNER, "admin": ADMIN, "viewer": VIEWER, "none": STRANGER}

Call = Callable[..., Any]


@pytest_asyncio.fixture
async def staff(owner_conn: asyncpg.Connection) -> AsyncIterator[None]:
    await owner_conn.execute("TRUNCATE staff_access, staff_access_audit RESTART IDENTITY")
    await owner_conn.execute(
        "INSERT INTO staff_access (email, role, granted_by) VALUES "
        "($1, 'admin', $3), ($2, 'viewer', $3)",
        ADMIN,
        VIEWER,
        OWNER,
    )
    yield
    await owner_conn.execute("TRUNCATE staff_access, staff_access_audit RESTART IDENTITY")


@pytest_asyncio.fixture
async def api() -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(make_settings(INTERNAL_SIGNING_KEY=KEY, ADMIN_EMAILS=OWNER))
    app.dependency_overrides[get_clock] = lambda: FakeClock(FIXED_NOW)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c


def _headers(
    method: str, path: str, *, email: str, role: str, body: bytes = b"", at: datetime = FIXED_NOW
) -> dict[str, str]:
    claims: dict[str, object] = {
        "aud": AUDIENCE,
        "sub": f"sub-{email}",
        "email": email,
        "role": role,
        "iat": int(at.timestamp()),
        "exp": int(at.timestamp()) + 60,
        "m": method,
        "p": path,
        "bh": body_hash(body),
        "jti": uuid.uuid4().hex,  # a fresh nonce: the API refuses a repeated assertion
        "ev": True,
    }
    return {"X-Internal-Assertion": sign(claims, KEY.encode()), "content-type": "application/json"}


@pytest.fixture
def call(api: httpx.AsyncClient) -> Call:
    async def make(
        method: str,
        path: str,
        *,
        as_role: str = "owner",
        email: str | None = None,
        json_body: str | None = None,
    ) -> httpx.Response:
        body = json_body.encode() if json_body else b""
        headers = _headers(
            method, path, email=email or ROLE_EMAIL.get(as_role, STRANGER), role=as_role, body=body
        )
        return await api.request(method, path, headers=headers, content=body or None)

    return make


READ_PATHS = [
    "/internal/admin/metrics?from=2026-10-12&to=2026-10-19",
    "/internal/admin/appointments",
    f"/internal/admin/appointments/{APPT}/lineage",
]

# role -> may it use the endpoint at all (a 404 for the unknown appointment still means allowed)
READ_MATRIX = {"owner": True, "admin": True, "viewer": True, "none": False}


@pytest.mark.parametrize("path", READ_PATHS)
@pytest.mark.parametrize("role", list(READ_MATRIX))
async def test_read_endpoints_by_role(call: Call, staff: None, path: str, role: str) -> None:
    resp = await call("GET", path, as_role=role)
    if READ_MATRIX[role]:
        assert resp.status_code in (200, 404), resp.text
        assert resp.status_code != 403
    else:
        assert resp.status_code == 403
        assert resp.json()["code"] == "FORBIDDEN"


ACCESS_CALLS = [
    ("GET", "/internal/admin/access", None),
    ("POST", "/internal/admin/access", '{"email":"new@clinic.example","role":"viewer"}'),
    ("PATCH", f"/internal/admin/access/{VIEWER}", '{"role":"admin"}'),
    ("DELETE", f"/internal/admin/access/{VIEWER}", None),
]


@pytest.mark.parametrize(("method", "path", "body"), ACCESS_CALLS)
@pytest.mark.parametrize("role", ["viewer", "none", "patient"])
async def test_only_owner_and_admin_can_manage_access(
    call: Call, staff: None, method: str, path: str, body: str | None, role: str
) -> None:
    resp = await call(method, path, as_role=role, json_body=body)
    assert resp.status_code == 403
    assert resp.json()["code"] == "FORBIDDEN"


async def test_an_admin_cannot_grant_directly(call: Call, staff: None) -> None:
    # Granting skips the email binding, so it stays with the owner; admins invite instead.
    resp = await call(
        "POST",
        "/internal/admin/access",
        as_role="admin",
        json_body='{"email":"new@clinic.example","role":"viewer"}',
    )
    assert resp.status_code == 403
    assert resp.json()["code"] == "FORBIDDEN"


async def test_a_non_owner_grant_changes_nothing(
    call: Call, staff: None, owner_conn: asyncpg.Connection
) -> None:
    body = '{"email":"sneaky@clinic.example","role":"admin"}'
    resp = await call("POST", "/internal/admin/access", as_role="admin", json_body=body)
    assert resp.status_code == 403
    count = await owner_conn.fetchval("SELECT count(*) FROM staff_access")
    audits = await owner_conn.fetchval("SELECT count(*) FROM staff_access_audit")
    assert (count, audits) == (2, 0)


async def test_a_role_claimed_but_not_held_is_403(call: Call, staff: None) -> None:
    # The viewer signs as owner: the signature is valid, the database disagrees.
    resp = await call("GET", "/internal/admin/access", as_role="owner", email=VIEWER)
    assert resp.status_code == 403
    # The same claim from the owner's own email is honoured.
    ok = await call("GET", "/internal/admin/access", as_role="owner", email=OWNER)
    assert ok.status_code == 200


async def test_owner_lists_everyone_with_the_owner_first(call: Call, staff: None) -> None:
    resp = await call("GET", "/internal/admin/access")
    assert resp.status_code == 200
    items = resp.json()["items"]
    assert items[0] == {
        "email": OWNER,
        "role": "owner",
        "granted_by": "configuration",
        "granted_at": None,
        "revoked_at": None,
        "source": "env",
    }
    assert [(i["email"], i["role"]) for i in items[1:]] == [(ADMIN, "admin"), (VIEWER, "viewer")]


async def test_grant_creates_access_and_an_audit_row(
    call: Call, staff: None, owner_conn: asyncpg.Connection
) -> None:
    body = '{"email":"  New@Clinic.Example ","role":"viewer"}'
    resp = await call("POST", "/internal/admin/access", json_body=body)
    assert resp.status_code == 201, resp.text
    assert resp.json()["email"] == "new@clinic.example"
    assert resp.json()["granted_by"] == OWNER
    # The new person can use the dashboard on their very next request.
    me = await call(
        "GET", "/internal/admin/appointments", as_role="viewer", email="new@clinic.example"
    )
    assert me.status_code == 200
    audit = await owner_conn.fetch(
        "SELECT actor_email, action, target_email, old_role::text, new_role::text "
        "FROM staff_access_audit"
    )
    assert [tuple(r) for r in audit] == [(OWNER, "grant", "new@clinic.example", None, "viewer")]


@pytest.mark.parametrize(
    "body",
    [
        '{"email":"x@clinic.example","role":"owner"}',
        '{"email":"x@clinic.example","role":"root"}',
        '{"email":"not-an-email","role":"viewer"}',
        '{"email":"x@clinic.example"}',
        '{"email":"x@clinic.example","role":"viewer","extra":1}',
    ],
)
async def test_grant_validates_input(call: Call, staff: None, body: str) -> None:
    resp = await call("POST", "/internal/admin/access", json_body=body)
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDATION_ERROR"


async def test_granting_twice_is_a_conflict(call: Call, staff: None) -> None:
    body = f'{{"email":"{VIEWER}","role":"admin"}}'
    resp = await call("POST", "/internal/admin/access", json_body=body)
    assert resp.status_code == 409
    assert resp.json()["code"] == "ACCESS_EXISTS"


async def test_change_role_takes_effect_and_is_audited(
    call: Call, staff: None, owner_conn: asyncpg.Connection
) -> None:
    resp = await call("PATCH", f"/internal/admin/access/{VIEWER}", json_body='{"role":"admin"}')
    assert resp.status_code == 200
    assert resp.json()["role"] == "admin"
    # As a viewer the person is now refused (the role they claim is no longer the one they hold).
    stale = await call("GET", "/internal/admin/appointments", as_role="viewer", email=VIEWER)
    assert stale.status_code == 403
    fresh = await call("GET", "/internal/admin/appointments", as_role="admin", email=VIEWER)
    assert fresh.status_code == 200
    row = await owner_conn.fetchrow(
        "SELECT action, old_role::text, new_role::text FROM staff_access_audit"
    )
    assert tuple(row) == ("change", "viewer", "admin")


async def test_change_role_of_unknown_email_is_404(call: Call, staff: None) -> None:
    resp = await call(
        "PATCH", "/internal/admin/access/ghost@clinic.example", json_body='{"role":"admin"}'
    )
    assert resp.status_code == 404
    assert resp.json()["code"] == "ACCESS_NOT_FOUND"


async def test_revoked_user_is_denied_on_the_next_request(
    call: Call, staff: None, owner_conn: asyncpg.Connection
) -> None:
    before = await call("GET", "/internal/admin/appointments", as_role="admin", email=ADMIN)
    assert before.status_code == 200
    resp = await call("DELETE", f"/internal/admin/access/{ADMIN}")
    assert resp.status_code == 200
    assert resp.json()["revoked_at"] is not None
    after = await call("GET", "/internal/admin/appointments", as_role="admin", email=ADMIN)
    assert after.status_code == 403
    # The row is kept (nothing is ever deleted) and the revoke is audited.
    assert await owner_conn.fetchval("SELECT count(*) FROM staff_access") == 2
    row = await owner_conn.fetchrow(
        "SELECT action, old_role::text, new_role::text FROM staff_access_audit"
    )
    assert tuple(row) == ("revoke", "admin", None)


async def test_revoking_twice_is_404_and_a_revoked_email_can_be_granted_again(
    call: Call, staff: None
) -> None:
    await call("DELETE", f"/internal/admin/access/{VIEWER}")
    again = await call("DELETE", f"/internal/admin/access/{VIEWER}")
    assert again.status_code == 404
    regrant = await call(
        "POST", "/internal/admin/access", json_body=f'{{"email":"{VIEWER}","role":"admin"}}'
    )
    assert regrant.status_code == 201
    assert regrant.json()["revoked_at"] is None
    ok = await call("GET", "/internal/admin/appointments", as_role="admin", email=VIEWER)
    assert ok.status_code == 200


async def test_the_owner_cannot_be_revoked_changed_or_granted(call: Call, staff: None) -> None:
    for method, body in (
        ("DELETE", None),
        ("PATCH", '{"role":"viewer"}'),
    ):
        resp = await call(method, f"/internal/admin/access/{OWNER}", json_body=body)
        assert resp.status_code == 409
        assert resp.json()["code"] == "OWNER_PROTECTED"
    grant = await call(
        "POST", "/internal/admin/access", json_body=f'{{"email":"{OWNER}","role":"admin"}}'
    )
    assert grant.status_code == 409
    assert grant.json()["code"] == "OWNER_PROTECTED"
    still = await call("GET", "/internal/admin/access")
    assert still.status_code == 200


async def test_the_owner_email_is_matched_case_insensitively(call: Call, staff: None) -> None:
    resp = await call("DELETE", f"/internal/admin/access/{OWNER.upper()}")
    assert resp.status_code == 409


async def test_session_endpoint_resolves_each_role(call: Call, staff: None) -> None:
    seen: dict[str, str | None] = {}
    for label, email in ROLE_EMAIL.items():
        resp = await call("GET", "/internal/admin/session", as_role="none", email=email)
        assert resp.status_code == 200
        seen[label] = resp.json()["role"]
    assert seen == {"owner": "owner", "admin": "admin", "viewer": "viewer", "none": None}


async def test_session_endpoint_needs_a_valid_assertion(api: httpx.AsyncClient) -> None:
    resp = await api.get("/internal/admin/session")
    assert resp.status_code == 401


async def test_session_reflects_a_revoke_immediately(call: Call, staff: None) -> None:
    await call("DELETE", f"/internal/admin/access/{VIEWER}")
    resp = await call("GET", "/internal/admin/session", as_role="none", email=VIEWER)
    assert resp.json()["role"] is None


# --- acting for a patient ---------------------------------------------------------------------

OTIENO = seeded_doctor_id("otieno")
AMINA = seeded_patient_id("amina")
BOOK_AT = "2026-10-26T09:00:00+03:00"
BY_ROLE = [("owner", True), ("admin", True), ("viewer", False), ("none", False)]


async def _book(api: httpx.AsyncClient) -> str:
    resp = await api.post(
        "/appointments",
        json={"doctor_id": str(OTIENO), "patient_id": str(AMINA), "starts_at": BOOK_AT},
    )
    assert resp.status_code == 201, resp.text
    return str(resp.json()["id"])


@pytest.mark.parametrize(("role", "allowed"), BY_ROLE)
async def test_cancel_for_a_patient_by_role(
    api: httpx.AsyncClient,
    call: Call,
    staff: None,
    reset_appointments: None,
    role: str,
    allowed: bool,
) -> None:
    appt = await _book(api)
    path = f"/internal/admin/appointments/{appt}/cancel"
    resp = await call("PATCH", path, as_role=role, json_body='{"reason":"patient called"}')
    after = await api.get(f"/appointments/{appt}")
    if allowed:
        assert resp.status_code == 200, resp.text
        assert after.json()["status"] == "cancelled"
    else:
        assert resp.status_code == 403
        assert after.json()["status"] == "booked"


@pytest.mark.parametrize(("role", "allowed"), BY_ROLE)
async def test_reschedule_for_a_patient_by_role(
    api: httpx.AsyncClient,
    call: Call,
    staff: None,
    reset_appointments: None,
    role: str,
    allowed: bool,
) -> None:
    appt = await _book(api)
    path = f"/internal/admin/appointments/{appt}/reschedule"
    body = '{"starts_at":"2026-10-26T10:00:00+03:00","reason":"clinic asked to move it"}'
    resp = await call("PATCH", path, as_role=role, json_body=body)
    after = (await api.get(f"/appointments/{appt}")).json()
    if allowed:
        assert resp.status_code == 200, resp.text
        assert after["starts_at"].startswith("2026-10-26T10:00:00")
    else:
        assert resp.status_code == 403
        assert after["starts_at"].startswith("2026-10-26T09:00:00")


async def test_cancel_for_a_patient_keeps_the_booking_rules(
    api: httpx.AsyncClient, call: Call, staff: None, reset_appointments: None
) -> None:
    appt = await _book(api)
    path = f"/internal/admin/appointments/{appt}/cancel"
    first = await call("PATCH", path, as_role="admin", json_body='{"reason":"first cancel"}')
    again = await call("PATCH", path, as_role="admin", json_body='{"reason":"second try"}')
    assert first.status_code == 200
    assert again.status_code == 409
    assert again.json()["code"] == "APPOINTMENT_ALREADY_CANCELLED"
    missing = await call(
        "PATCH",
        f"/internal/admin/appointments/{uuid.uuid4()}/cancel",
        as_role="admin",
        json_body='{"reason":"nothing there"}',
    )
    assert missing.status_code == 404
