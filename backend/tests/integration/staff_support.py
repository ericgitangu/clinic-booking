"""Shared setup for the staff-CRUD, attendance and ops-board tests: a signed-request client with a
movable clock, a staff table, and one patient with a phone and an email."""

from __future__ import annotations

import json
import secrets
import uuid
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime
from typing import Any

import asyncpg
import httpx
import pytest_asyncio

from app.api.deps import get_clock
from app.core.assertion import AUDIENCE, body_hash, sign
from app.core.clock import FakeClock
from app.main import create_app
from tests.conftest import FIXED_NOW, make_settings, seeded_doctor_id

KEY = secrets.token_hex(24)  # a throwaway key per run
OWNER = "owner@clinic.example"
ADMIN = "admin@clinic.example"
ADMIN2 = "admin2@clinic.example"
VIEWER = "viewer@clinic.example"
STRANGER = "stranger@clinic.example"
EMAIL_OF = {"owner": OWNER, "admin": ADMIN, "viewer": VIEWER}

OTIENO = seeded_doctor_id("otieno")
PATIENT = uuid.UUID("00000000-0000-4000-8000-0000000000c1")
PATIENT_NAME = "Zainab Wekesa"
PATIENT_PHONE = "+254712345678"
PATIENT_EMAIL = "zainab.wekesa@example.com"

TUE_10 = "2026-10-27T10:00:00+03:00"
TUE_11 = "2026-10-27T11:00:00+03:00"
MON_09 = "2026-10-26T09:00:00+03:00"
MON_0920_NOW = datetime(2026, 10, 26, 5, 20, tzinfo=UTC)  # 08:20 EAT, 40 minutes before 09:00

Call = Callable[..., Any]


class Env:
    def __init__(self, client: httpx.AsyncClient, clock: FakeClock) -> None:
        self.client = client
        self.clock = clock

    def sign_request(
        self,
        method: str,
        path: str,
        *,
        role: str = "owner",
        email: str | None = None,
        body: dict[str, Any] | None = None,
        verified: bool | None = True,
        jti: str | None = None,
        iat_offset: int = 0,
    ) -> tuple[dict[str, str], bytes]:
        """Headers and body for one request. Every call makes a new random ``jti`` unless one is
        given, so two calls are two assertions; the same ``jti`` and fake time give byte-identical
        ones (a replay). ``iat_offset`` shifts the issue time (up to 5 s ahead is allowed)."""
        raw = json.dumps(body).encode() if body is not None else b""
        now = self.clock.now()
        claims: dict[str, object] = {
            "aud": AUDIENCE,
            "sub": f"sub-{email or role}",
            "email": email or EMAIL_OF.get(role, STRANGER),
            "role": role,
            "iat": int(now.timestamp()) + iat_offset,
            "exp": int(now.timestamp()) + iat_offset + 60,
            "m": method,
            "p": path,
            "bh": body_hash(raw),
            "jti": jti or uuid.uuid4().hex,
        }
        if verified is not None:  # None leaves the claim out, as an old web app would
            claims["ev"] = verified
        headers = {
            "X-Internal-Assertion": sign(claims, KEY.encode()),
            "content-type": "application/json",
        }
        return headers, raw

    async def req(
        self,
        method: str,
        path: str,
        *,
        role: str = "owner",
        email: str | None = None,
        body: dict[str, Any] | None = None,
        verified: bool | None = True,
    ) -> httpx.Response:
        headers, raw = self.sign_request(
            method, path, role=role, email=email, body=body, verified=verified
        )
        return await self.client.request(method, path, headers=headers, content=raw or None)

    async def patient_book(self, starts_at: str = TUE_10) -> str:
        resp = await self.client.post(
            "/appointments",
            json={"doctor_id": str(OTIENO), "patient_id": str(PATIENT), "starts_at": starts_at},
        )
        assert resp.status_code == 201, resp.text
        return str(resp.json()["id"])


@pytest_asyncio.fixture
async def env(owner_conn: asyncpg.Connection) -> AsyncIterator[Env]:
    await owner_conn.execute(
        "TRUNCATE appointment_events, appointments, staff_access, staff_access_audit, "
        "staff_invites, staff_passes, invite_accept_cap RESTART IDENTITY CASCADE"
    )
    await owner_conn.execute(
        "DELETE FROM patients WHERE id = $1 OR phone = '+254700000001'", PATIENT
    )
    await owner_conn.execute(
        "INSERT INTO patients (id, full_name, phone, email) VALUES ($1, $2, $3, $4)",
        PATIENT,
        PATIENT_NAME,
        PATIENT_PHONE,
        PATIENT_EMAIL,
    )
    await owner_conn.execute(
        "INSERT INTO staff_access (email, role, granted_by) VALUES "
        "($1, 'admin', $3), ($2, 'viewer', $3)",
        ADMIN,
        VIEWER,
        OWNER,
    )
    clock = FakeClock(FIXED_NOW)
    app = create_app(make_settings(INTERNAL_SIGNING_KEY=KEY, ADMIN_EMAILS=OWNER))
    app.dependency_overrides[get_clock] = lambda: clock
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield Env(c, clock)
    await owner_conn.execute(
        "TRUNCATE appointment_events, appointments, staff_access, staff_access_audit, "
        "staff_invites, staff_passes, invite_accept_cap RESTART IDENTITY CASCADE"
    )
    await owner_conn.execute(
        "DELETE FROM patients WHERE id = $1 OR phone = '+254700000001'", PATIENT
    )


async def audit_rows(conn: asyncpg.Connection) -> list[asyncpg.Record]:
    rows: list[asyncpg.Record] = await conn.fetch(
        "SELECT * FROM staff_action_audit ORDER BY occurred_at, id"
    )
    return rows
