"""Patient accounts: linking a sign-in to one patient, and the /internal/me routes."""

from __future__ import annotations

import asyncio
import secrets
import uuid
from collections.abc import AsyncIterator
from datetime import datetime

import asyncpg
import httpx
import pytest
import pytest_asyncio

from app.api.deps import get_clock
from app.core.assertion import AUDIENCE, body_hash, sign
from app.core.clock import FakeClock
from app.main import create_app
from tests.conftest import FIXED_NOW, first_available, make_settings, seeded_doctor_id

pytestmark = pytest.mark.asyncio

KEY = secrets.token_hex(24)  # fresh per run: a throwaway key, never a literal
ALICE = ("sub-alice", "alice@example.test")
BOB = ("sub-bob", "bob@example.test")


@pytest_asyncio.fixture
async def accounts(owner_conn: asyncpg.Connection) -> AsyncIterator[None]:
    await owner_conn.execute("TRUNCATE patient_accounts")
    await owner_conn.execute("TRUNCATE appointment_events, appointments RESTART IDENTITY CASCADE")
    yield
    await owner_conn.execute("TRUNCATE patient_accounts")


@pytest_asyncio.fixture
async def api() -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(make_settings(INTERNAL_SIGNING_KEY=KEY))
    app.dependency_overrides[get_clock] = lambda: FakeClock(FIXED_NOW)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c


def _headers(
    method: str,
    path: str,
    who: tuple[str, str],
    body: bytes = b"",
    at: datetime = FIXED_NOW,
    verified: bool | None = True,
) -> dict[str, str]:
    sub, email = who
    claims: dict[str, object] = {
        "aud": AUDIENCE,
        "sub": sub,
        "email": email,
        "role": "none",
        "iat": int(at.timestamp()),
        "exp": int(at.timestamp()) + 60,
        "m": method,
        "p": path,
        "bh": body_hash(body),
        "jti": uuid.uuid4().hex,
    }
    if verified is not None:
        claims["ev"] = verified
    return {"X-Internal-Assertion": sign(claims, KEY.encode()), "content-type": "application/json"}


async def call(
    api: httpx.AsyncClient, method: str, path: str, who: tuple[str, str], json: str | None = None
) -> httpx.Response:
    body = json.encode() if json else b""
    return await api.request(
        method, path, headers=_headers(method, path, who, body), content=body or None
    )


async def link(
    api: httpx.AsyncClient, who: tuple[str, str], name: str = "Test Person"
) -> httpx.Response:
    return await call(api, "POST", "/internal/accounts/link", who, f'{{"full_name":"{name}"}}')


async def book_as(api: httpx.AsyncClient, who: tuple[str, str]) -> dict[str, object]:
    doctor = seeded_doctor_id("otieno")
    _, slot = await first_available(api, doctor)
    resp = await call(
        api,
        "POST",
        "/internal/me/appointments",
        who,
        f'{{"doctor_id":"{doctor}","starts_at":"{slot["starts_at"]}"}}',
    )
    assert resp.status_code == 201, resp.text
    out: dict[str, object] = resp.json()
    return out


async def book_slot(
    api: httpx.AsyncClient, who: tuple[str, str], doctor: uuid.UUID, starts_at: str
) -> httpx.Response:
    return await call(
        api,
        "POST",
        "/internal/me/appointments",
        who,
        f'{{"doctor_id":"{doctor}","starts_at":"{starts_at}"}}',
    )


async def test_link_creates_a_patient_once_and_returns_the_same_one_after(
    api: httpx.AsyncClient, accounts: None, owner_conn: asyncpg.Connection
) -> None:
    first = await link(api, ALICE, "Alice Wanjiru")
    assert first.status_code == 201, first.text
    assert first.json()["created"] is True
    again = await link(api, ALICE, "A Different Name")
    assert again.status_code == 200
    assert again.json() == {"patient_id": first.json()["patient_id"], "created": False}
    row = await owner_conn.fetchrow(
        "SELECT full_name, email FROM patients WHERE id = $1", uuid.UUID(first.json()["patient_id"])
    )
    assert row is not None and row["full_name"] == "Alice Wanjiru" and row["email"] == ALICE[1]
    assert await owner_conn.fetchval("SELECT count(*) FROM patient_accounts") == 1


async def test_link_never_adopts_an_existing_patient_with_the_same_email(
    api: httpx.AsyncClient, accounts: None, owner_conn: asyncpg.Connection
) -> None:
    existing = uuid.uuid4()
    await owner_conn.execute(
        "INSERT INTO patients (id, full_name, email) VALUES ($1, 'Someone Earlier', $2)",
        existing,
        ALICE[1],
    )
    resp = await link(api, ALICE)
    assert resp.status_code == 201
    assert resp.json()["patient_id"] != str(existing)


async def test_two_first_sign_ins_racing_make_one_patient(
    api: httpx.AsyncClient, accounts: None, owner_conn: asyncpg.Connection
) -> None:
    results = await asyncio.gather(*(link(api, BOB) for _ in range(8)))
    assert {r.status_code for r in results} <= {200, 201}
    assert sum(1 for r in results if r.status_code == 201) == 1
    assert len({r.json()["patient_id"] for r in results}) == 1
    assert sum(1 for r in results if r.json()["created"]) == 1
    assert await owner_conn.fetchval("SELECT count(*) FROM patient_accounts") == 1


async def test_no_assertion_and_a_bad_assertion_are_refused(
    api: httpx.AsyncClient, accounts: None
) -> None:
    for headers in ({}, {"X-Internal-Assertion": "v1.e30.AAAA"}):
        resp = await api.get("/internal/me/appointments", headers=headers)
        assert resp.status_code == 401
        assert resp.json()["code"] == "UNAUTHENTICATED"


async def test_an_assertion_for_another_path_or_body_is_refused(
    api: httpx.AsyncClient, accounts: None
) -> None:
    headers = _headers("GET", "/internal/me/appointments", ALICE)
    other = await api.get("/internal/me/appointments?limit=1", headers=headers)
    assert other.status_code == 401
    body = b'{"full_name":"Original"}'
    swapped = await api.post(
        "/internal/accounts/link",
        headers=_headers("POST", "/internal/accounts/link", ALICE, body),
        content=b'{"full_name":"Swapped"}',
    )
    assert swapped.status_code == 401


async def test_me_routes_say_not_found_before_the_account_is_linked(
    api: httpx.AsyncClient, accounts: None
) -> None:
    resp = await call(api, "GET", "/internal/me/appointments", ALICE)
    assert resp.status_code == 404 and resp.json()["code"] == "PATIENT_NOT_FOUND"


async def test_a_patient_books_lists_and_reads_only_their_own(
    api: httpx.AsyncClient, accounts: None
) -> None:
    assert (await link(api, ALICE)).status_code == 201
    assert (await link(api, BOB)).status_code == 201
    appt = await book_as(api, ALICE)

    mine = await call(api, "GET", "/internal/me/appointments", ALICE)
    assert [a["id"] for a in mine.json()["items"]] == [appt["id"]]
    theirs = await call(api, "GET", "/internal/me/appointments", BOB)
    assert theirs.json()["items"] == []

    one = await call(api, "GET", f"/internal/me/appointments/{appt['id']}", ALICE)
    assert one.status_code == 200
    other = await call(api, "GET", f"/internal/me/appointments/{appt['id']}", BOB)
    assert other.status_code == 404 and other.json()["code"] == "APPOINTMENT_NOT_FOUND"


async def test_someone_elses_appointment_cannot_be_cancelled_or_rescheduled_and_looks_missing(
    api: httpx.AsyncClient, accounts: None
) -> None:
    await link(api, ALICE)
    await link(api, BOB)
    appt = await book_as(api, ALICE)
    cancel = await call(
        api, "PATCH", f"/internal/me/appointments/{appt['id']}/cancel", BOB, '{"reason":"not mine"}'
    )
    assert cancel.status_code == 404 and cancel.json()["code"] == "APPOINTMENT_NOT_FOUND"
    move = await call(
        api,
        "PATCH",
        f"/internal/me/appointments/{appt['id']}/reschedule",
        BOB,
        f'{{"starts_at":"{appt["starts_at"]}"}}',
    )
    assert move.status_code == 404
    still = await call(api, "GET", f"/internal/me/appointments/{appt['id']}", ALICE)
    assert still.json()["status"] == "booked"
    # an id that never existed answers exactly the same
    ghost = await call(
        api,
        "PATCH",
        f"/internal/me/appointments/{uuid.uuid4()}/cancel",
        BOB,
        '{"reason":"nothing"}',
    )
    assert ghost.status_code == 404 and ghost.json()["code"] == "APPOINTMENT_NOT_FOUND"


async def test_the_owner_of_an_appointment_can_cancel_it_once(
    api: httpx.AsyncClient, accounts: None
) -> None:
    await link(api, ALICE)
    appt = await book_as(api, ALICE)
    done = await call(
        api,
        "PATCH",
        f"/internal/me/appointments/{appt['id']}/cancel",
        ALICE,
        '{"reason":"plans changed"}',
    )
    assert done.status_code == 200 and done.json()["status"] == "cancelled"
    twice = await call(
        api,
        "PATCH",
        f"/internal/me/appointments/{appt['id']}/cancel",
        ALICE,
        '{"reason":"again please"}',
    )
    assert twice.status_code == 409 and twice.json()["code"] == "APPOINTMENT_ALREADY_CANCELLED"


async def test_a_patient_can_reschedule_their_own_and_a_taken_slot_is_a_conflict(
    api: httpx.AsyncClient, accounts: None
) -> None:
    await link(api, ALICE)
    await link(api, BOB)
    doctor = seeded_doctor_id("otieno")
    day, first = await first_available(api, doctor)
    slots = (await api.get(f"/doctors/{doctor}/availability?date={day}")).json()["slots"]
    a = (await book_slot(api, ALICE, doctor, slots[0]["starts_at"])).json()
    b = (await book_slot(api, BOB, doctor, slots[1]["starts_at"])).json()
    clash = await call(
        api,
        "PATCH",
        f"/internal/me/appointments/{a['id']}/reschedule",
        ALICE,
        f'{{"starts_at":"{b["starts_at"]}"}}',
    )
    assert clash.status_code == 409 and clash.json()["code"] == "SLOT_TAKEN"
    moved = await call(
        api,
        "PATCH",
        f"/internal/me/appointments/{a['id']}/reschedule",
        ALICE,
        f'{{"starts_at":"{slots[2]["starts_at"]}"}}',
    )
    assert moved.status_code == 200
    assert moved.json()["patient_id"] == a["patient_id"]
    assert first  # the helper's own slot, only used to find a day with free times


async def test_the_runtime_role_cannot_change_or_remove_a_link(
    api: httpx.AsyncClient, accounts: None, app_conn: asyncpg.Connection
) -> None:
    await link(api, ALICE)
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        await app_conn.execute("UPDATE patient_accounts SET email = 'x@example.test'")
    with pytest.raises(asyncpg.InsufficientPrivilegeError):
        await app_conn.execute("DELETE FROM patient_accounts")


@pytest.mark.parametrize("verified", [False, None])
async def test_an_unverified_email_cannot_link_book_or_list(
    api: httpx.AsyncClient, accounts: None, owner_conn: asyncpg.Connection, verified: bool | None
) -> None:
    """``ev`` false, or absent altogether, is refused on every patient route and creates nothing."""
    body = b'{"full_name":"Not Verified"}'
    refused = await api.post(
        "/internal/accounts/link",
        headers=_headers("POST", "/internal/accounts/link", ALICE, body, verified=verified),
        content=body,
    )
    assert refused.status_code == 403 and refused.json()["code"] == "FORBIDDEN"
    listed = await api.get(
        "/internal/me/appointments",
        headers=_headers("GET", "/internal/me/appointments", ALICE, verified=verified),
    )
    assert listed.status_code == 403
    assert await owner_conn.fetchval("SELECT count(*) FROM patient_accounts") == 0


async def test_a_verified_link_is_not_undone_by_a_later_unverified_assertion(
    api: httpx.AsyncClient, accounts: None
) -> None:
    assert (await link(api, ALICE)).status_code == 201
    body = b'{"full_name":"Whoever"}'
    refused = await api.post(
        "/internal/accounts/link",
        headers=_headers("POST", "/internal/accounts/link", ALICE, body, verified=False),
        content=body,
    )
    assert refused.status_code == 403
    assert (await link(api, ALICE)).status_code == 200
