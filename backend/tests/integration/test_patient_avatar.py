"""The Google profile picture: stored at link, followed on every sign-in, shown to owners and
admins only, and only ever a URL on Google's own host."""

from __future__ import annotations

import io
import logging
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
from app.core.logging import JsonFormatter
from app.main import create_app
from tests.conftest import FIXED_NOW, make_settings, seeded_doctor_id

pytestmark = pytest.mark.asyncio

KEY = secrets.token_hex(24)  # throwaway, fresh per run
OWNER = "owner@clinic.example"
ADMIN = "admin@clinic.example"
VIEWER = "viewer@clinic.example"
PIC = "https://lh3.googleusercontent.com/a/ACg8ocPic1=s96-c"
PIC2 = "https://lh3.googleusercontent.com/a/ACg8ocPic2=s96-c"
OTIENO = seeded_doctor_id("otieno")


@pytest_asyncio.fixture
async def api(owner_conn: asyncpg.Connection) -> AsyncIterator[httpx.AsyncClient]:
    await owner_conn.execute("TRUNCATE appointment_events, appointments RESTART IDENTITY CASCADE")
    await owner_conn.execute("TRUNCATE patient_accounts")
    await owner_conn.execute("TRUNCATE staff_access, staff_access_audit RESTART IDENTITY")
    await owner_conn.execute(
        "INSERT INTO staff_access (email, role, granted_by) VALUES "
        "($1, 'admin', $3), ($2, 'viewer', $3)",
        ADMIN,
        VIEWER,
        OWNER,
    )
    app = create_app(make_settings(INTERNAL_SIGNING_KEY=KEY, ADMIN_EMAILS=OWNER))
    app.dependency_overrides[get_clock] = lambda: FakeClock(FIXED_NOW)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c
    await owner_conn.execute("TRUNCATE appointment_events, appointments RESTART IDENTITY CASCADE")
    await owner_conn.execute("TRUNCATE patient_accounts")
    await owner_conn.execute("TRUNCATE staff_access, staff_access_audit RESTART IDENTITY")


def _headers(
    method: str, path: str, *, sub: str, email: str, role: str, body: bytes = b"", ev: bool = True
) -> dict[str, str]:
    at: datetime = FIXED_NOW
    claims: dict[str, object] = {
        "aud": AUDIENCE, "sub": sub, "email": email, "role": role,
        "iat": int(at.timestamp()), "exp": int(at.timestamp()) + 60,
        "m": method, "p": path, "bh": body_hash(body), "ev": ev,
    }  # fmt: skip
    return {"X-Internal-Assertion": sign(claims, KEY.encode()), "content-type": "application/json"}


async def link(
    api: httpx.AsyncClient, sub: str, image: str | None | bool = False, name: str = "Avatar Person"
) -> httpx.Response:
    import json

    payload: dict[str, object] = {"full_name": name}
    if image is not False:
        payload["image"] = image
    body = json.dumps(payload).encode()
    path = "/internal/accounts/link"
    return await api.post(
        path,
        content=body,
        headers=_headers(
            "POST", path, sub=sub, email=f"{sub}@example.test", role="none", body=body
        ),
    )


async def stored(conn: asyncpg.Connection, sub: str) -> str | None:
    value = await conn.fetchval("SELECT image_url FROM patient_accounts WHERE google_sub = $1", sub)
    return str(value) if value is not None else None


async def staff_get(api: httpx.AsyncClient, path: str, who: tuple[str, str]) -> httpx.Response:
    email, role = who
    return await api.get(path, headers=_headers("GET", path, sub="s", email=email, role=role))


async def _book(conn: asyncpg.Connection, patient: uuid.UUID) -> uuid.UUID:
    appt = uuid.uuid4()
    await conn.execute(
        "INSERT INTO appointments (id, doctor_id, patient_id, starts_at, ends_at) "
        "VALUES ($1, $2, $3, '2026-10-26 06:00+00', '2026-10-26 06:30+00')",
        appt,
        OTIENO,
        patient,
    )
    await conn.execute(
        "INSERT INTO appointment_events (appointment_id, doctor_id, event_type, to_starts_at, "
        "local_date, occurred_at) VALUES ($1, $2, 'booked', '2026-10-26 06:00+00', "
        "'2026-10-26', '2026-10-18 06:00+00')",
        appt,
        OTIENO,
    )
    return appt


async def test_link_stores_a_google_picture_and_the_admin_roles_see_it(
    api: httpx.AsyncClient, owner_conn: asyncpg.Connection
) -> None:
    resp = await link(api, "sub-a", PIC)
    assert resp.status_code == 201
    assert await stored(owner_conn, "sub-a") == PIC
    patient = uuid.UUID(resp.json()["patient_id"])
    appt = await _book(owner_conn, patient)

    for who in ((OWNER, "owner"), (ADMIN, "admin")):
        listing = await staff_get(api, "/internal/admin/appointments", who)
        assert [i["avatar_url"] for i in listing.json()["items"]] == [PIC], who
        detail = await staff_get(api, f"/internal/admin/appointments/{appt}/lineage", who)
        body = detail.json()
        assert body["avatar_url"] == PIC and body["patient_name"] == "Avatar Person"
        assert body["patient_id"] == str(patient)

    viewer = await staff_get(api, "/internal/admin/appointments", (VIEWER, "viewer"))
    assert viewer.status_code == 200
    assert [i["avatar_url"] for i in viewer.json()["items"]] == [None]
    lineage = await staff_get(
        api, f"/internal/admin/appointments/{appt}/lineage", (VIEWER, "viewer")
    )
    assert lineage.json()["avatar_url"] is None  # a picture can identify someone


async def test_a_patient_without_a_google_account_or_picture_shows_initials(
    api: httpx.AsyncClient, owner_conn: asyncpg.Connection
) -> None:
    demo = uuid.uuid4()
    await owner_conn.execute(
        "INSERT INTO patients (id, full_name, demo) VALUES ($1, 'Demo Patient', true)", demo
    )
    await _book(owner_conn, demo)
    resp = await link(api, "sub-nopic")  # signed in, Google gave no picture
    await _book_second(owner_conn, uuid.UUID(resp.json()["patient_id"]))
    listing = await staff_get(api, "/internal/admin/appointments", (OWNER, "owner"))
    assert {i["patient_name"]: i["avatar_url"] for i in listing.json()["items"]} == {
        "Demo Patient": None,
        "Avatar Person": None,
    }


async def _book_second(conn: asyncpg.Connection, patient: uuid.UUID) -> None:
    await conn.execute(
        "INSERT INTO appointments (doctor_id, patient_id, starts_at, ends_at) "
        "VALUES ($1, $2, '2026-10-27 06:00+00', '2026-10-27 06:30+00')",
        OTIENO,
        patient,
    )


@pytest.mark.parametrize(
    "bad",
    [
        "http://lh3.googleusercontent.com/a/x",
        "https://lh3.googleusercontent.com.evil.com/a/x",
        "https://evil.com/a/x",
        "https://lh3.googleusercontent.com@evil.com/a/x",
        "javascript:alert(1)",
    ],
)
async def test_a_non_google_url_is_stored_as_null_without_an_error(
    api: httpx.AsyncClient, owner_conn: asyncpg.Connection, bad: str
) -> None:
    resp = await link(api, "sub-bad", bad)
    assert resp.status_code == 201  # no error, nothing learned
    assert await stored(owner_conn, "sub-bad") is None
    assert bad not in resp.text


async def test_every_sign_in_updates_the_picture_and_clears_it_when_there_is_none(
    api: httpx.AsyncClient, owner_conn: asyncpg.Connection
) -> None:
    assert (await link(api, "sub-u", PIC)).status_code == 201
    assert await stored(owner_conn, "sub-u") == PIC
    assert (await link(api, "sub-u", PIC2)).status_code == 200
    assert await stored(owner_conn, "sub-u") == PIC2
    assert (await link(api, "sub-u", "https://evil.example/x")).status_code == 200
    assert await stored(owner_conn, "sub-u") is None  # a hostile value never replaces a good one
    assert (await link(api, "sub-u", PIC)).status_code == 200
    assert (await link(api, "sub-u")).status_code == 200  # no picture this time: cleared
    assert await stored(owner_conn, "sub-u") is None


async def test_the_database_refuses_a_foreign_url_even_if_the_api_were_bypassed(
    api: httpx.AsyncClient, owner_conn: asyncpg.Connection
) -> None:
    resp = await link(api, "sub-db", PIC)
    assert resp.status_code == 201
    with pytest.raises(asyncpg.CheckViolationError):
        await owner_conn.execute(
            "UPDATE patient_accounts SET image_url = 'https://evil.example/x' "
            "WHERE google_sub = 'sub-db'"
        )


async def test_the_picture_url_never_reaches_the_logs(api: httpx.AsyncClient) -> None:
    buf = io.StringIO()
    handler = logging.StreamHandler(buf)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.addHandler(handler)
    previous = root.level
    root.setLevel(logging.DEBUG)
    try:
        await link(api, "sub-log", PIC)
        await link(api, "sub-log", PIC2)
        await link(api, "sub-log2", "https://lh3.googleusercontent.com.evil.com/x")
    finally:
        root.removeHandler(handler)
        root.setLevel(previous)
    out = buf.getvalue()
    assert out, "the requests were logged"
    for url in (PIC, PIC2, "googleusercontent", "evil.com"):
        assert url not in out


async def test_the_operations_board_follows_the_same_rule(
    api: httpx.AsyncClient, owner_conn: asyncpg.Connection
) -> None:
    resp = await link(api, "sub-board", PIC)
    patient = uuid.UUID(resp.json()["patient_id"])
    await _book(owner_conn, patient)  # 2026-10-26 09:00 EAT with Dr Otieno
    path = "/internal/admin/ops/today?date=2026-10-26"
    seen = {}
    for who in ((OWNER, "owner"), (ADMIN, "admin"), (VIEWER, "viewer")):
        board = await staff_get(api, path, who)
        assert board.status_code == 200, (who, board.text)
        items = [a for d in board.json()["doctors"] for a in d["appointments"]]
        seen[who[1]] = [a["avatar_url"] for a in items]
    assert seen["owner"] == [PIC] and seen["admin"] == [PIC] and seen["viewer"] == [None]
