"""Synthetic patients: the release smoke's own rows never reach the admin views.

The migration adds ``patients.synthetic``; only the signed smoke endpoint sets it. Every admin
aggregate, the list, the lineage and the realtime admin feed leave those rows out, while patient
availability still treats a synthetic booking as holding its slot.
"""

from __future__ import annotations

import importlib.util
import pathlib
import secrets
import uuid
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime, timedelta
from types import ModuleType
from typing import Any

import asyncpg
import httpx
import pytest
import pytest_asyncio

from app.api.deps import SMOKE_SUB, get_clock
from app.core.assertion import AUDIENCE, body_hash, sign
from app.core.clock import FakeClock
from app.main import create_app
from tests.conftest import FIXED_NOW, make_settings, seeded_doctor_id, seeded_patient_id
from tests.integration.realtime_support import RecordingPublisher, make_realtime_app

pytestmark = pytest.mark.asyncio

KEY = secrets.token_hex(24)  # throwaway keys, fresh per run
SMOKE_KEY = secrets.token_hex(24)
OWNER = "owner@clinic.example"
OTIENO = seeded_doctor_id("otieno")
AMINA = seeded_patient_id("amina")
REAL = uuid.UUID("00000000-0000-4000-8000-0000000005a1")
SYN = uuid.UUID("00000000-0000-4000-8000-0000000005a2")
A_REAL = uuid.UUID("00000000-0000-4000-8000-0000000005b1")
A_SYN_BOOKED = uuid.UUID("00000000-0000-4000-8000-0000000005b2")
A_SYN_CANCELLED = uuid.UUID("00000000-0000-4000-8000-0000000005b3")

SCRIPT = pathlib.Path(__file__).resolve().parents[3] / "scripts" / "verify_claims.py"


def _load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("verify_claims_under_test", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _utc(day: int, hour: int) -> datetime:
    return datetime(2026, 10, day, hour, 0, tzinfo=UTC)


def _headers(
    path: str, key: str, *, role: str, sub: str = "sub-1", method: str = "GET", body: bytes = b""
) -> dict[str, str]:
    claims: dict[str, object] = {
        "aud": AUDIENCE,
        "sub": sub,
        "email": OWNER if role != "smoke" else "smoke@verify-claims.invalid",
        "role": role,
        "iat": int(FIXED_NOW.timestamp()),
        "exp": int(FIXED_NOW.timestamp()) + 60,
        "m": method,
        "p": path,
        "bh": body_hash(body),
        "ev": True,
    }
    return {"X-Internal-Assertion": sign(claims, key.encode("utf-8"))}


@pytest_asyncio.fixture
async def api() -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(
        make_settings(INTERNAL_SIGNING_KEY=KEY, SMOKE_SIGNING_KEY=SMOKE_KEY, ADMIN_EMAILS=OWNER)
    )
    app.dependency_overrides[get_clock] = lambda: FakeClock(FIXED_NOW)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c


async def _admin_get(api: httpx.AsyncClient, path: str) -> httpx.Response:
    return await api.get(path, headers=_headers(path, KEY, role="owner"))


async def _appt(
    conn: asyncpg.Connection,
    appt: uuid.UUID,
    patient: uuid.UUID,
    starts_at: datetime,
    *,
    cancelled: bool = False,
) -> None:
    await conn.execute(
        "INSERT INTO appointments (id, doctor_id, patient_id, starts_at, ends_at, status, "
        "cancellation_reason, cancelled_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        appt,
        OTIENO,
        patient,
        starts_at,
        starts_at + timedelta(minutes=30),
        "cancelled" if cancelled else "booked",
        "released" if cancelled else None,
        _utc(17, 10) if cancelled else None,
    )


async def _event(
    conn: asyncpg.Connection, appt: uuid.UUID, kind: str, at: datetime, start: datetime
) -> None:
    await conn.execute(
        "INSERT INTO appointment_events (appointment_id, doctor_id, event_type, from_starts_at, "
        "to_starts_at, local_date, occurred_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        appt,
        OTIENO,
        kind,
        start if kind == "cancelled" else None,
        start if kind == "booked" else None,
        (start + timedelta(hours=3)).date(),
        at,
    )


@pytest_asyncio.fixture
async def mixed(owner_conn: asyncpg.Connection, reset_appointments: None) -> AsyncIterator[None]:
    """One ordinary booked visit, and a synthetic patient with a live booking plus a cancelled
    one (the shape the release pipeline leaves behind: booked, then cancelled, again and again)."""
    await owner_conn.execute(
        "INSERT INTO patients (id, full_name, synthetic) VALUES ($1, 'Real Person', false), "
        "($2, 'verify-claims 20261018T120000 1', true)",
        REAL,
        SYN,
    )
    real_at, syn_at, syn_cancel_at = _utc(20, 6), _utc(21, 6), _utc(22, 6)
    await _appt(owner_conn, A_REAL, REAL, real_at)
    await _appt(owner_conn, A_SYN_BOOKED, SYN, syn_at)
    await _appt(owner_conn, A_SYN_CANCELLED, SYN, syn_cancel_at, cancelled=True)
    await _event(owner_conn, A_REAL, "booked", _utc(17, 7), real_at)
    await _event(owner_conn, A_SYN_BOOKED, "booked", _utc(17, 7), syn_at)
    await _event(owner_conn, A_SYN_CANCELLED, "booked", _utc(17, 7), syn_cancel_at)
    await _event(owner_conn, A_SYN_CANCELLED, "cancelled", _utc(17, 8), syn_cancel_at)
    yield
    await owner_conn.execute("TRUNCATE appointment_events, appointments RESTART IDENTITY CASCADE")
    await owner_conn.execute("DELETE FROM patients WHERE id = ANY($1::uuid[])", [REAL, SYN])


# --- the admin views ignore synthetic rows -------------------------------------------------


async def test_metrics_totals_series_and_utilisation_ignore_synthetic_rows(
    api: httpx.AsyncClient, mixed: None
) -> None:
    resp = await _admin_get(api, "/internal/admin/metrics?from=2026-10-17&to=2026-10-18")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # Without the filter this is booked 3, cancelled 1, upcoming 2.
    assert body["totals"] == {"booked": 1, "rescheduled": 0, "cancelled": 0, "upcoming_active": 1}
    assert [(p["booked"], p["cancelled"]) for p in body["series"]] == [(1, 0)]
    otieno = next(d for d in body["per_doctor"] if d["doctor_id"] == str(OTIENO))
    assert otieno["cancelled_actions"] == 0

    week = await _admin_get(api, "/internal/admin/metrics?from=2026-10-19&to=2026-10-26")
    otieno = next(d for d in week.json()["per_doctor"] if d["doctor_id"] == str(OTIENO))
    # Without the filter booked_visits is 2 (the synthetic live booking counts as a visit).
    assert otieno["booked_visits"] == 1
    assert otieno["utilization"] == pytest.approx(1 / otieno["capacity"])


async def test_the_appointment_list_and_lineage_ignore_synthetic_rows(
    api: httpx.AsyncClient, mixed: None
) -> None:
    for status in ("all", "booked", "cancelled"):
        resp = await _admin_get(api, f"/internal/admin/appointments?status={status}&limit=100")
        assert resp.status_code == 200, resp.text
        ids = {i["id"] for i in resp.json()["items"]}
        assert ids <= {str(A_REAL)}, (status, ids)
    everything = await _admin_get(api, "/internal/admin/appointments?status=all&limit=100")
    assert [i["id"] for i in everything.json()["items"]] == [str(A_REAL)]

    assert (
        await _admin_get(api, f"/internal/admin/appointments/{A_REAL}/lineage")
    ).status_code == 200
    for synthetic in (A_SYN_BOOKED, A_SYN_CANCELLED):
        gone = await _admin_get(api, f"/internal/admin/appointments/{synthetic}/lineage")
        assert gone.status_code == 404


async def test_a_synthetic_booking_still_holds_its_slot_for_patients(
    api: httpx.AsyncClient, mixed: None
) -> None:
    resp = await api.get(f"/doctors/{OTIENO}/availability?date=2026-10-21")
    assert resp.status_code == 200
    starts = {s["starts_at"] for s in resp.json()["slots"]}
    assert "2026-10-21T09:00:00+03:00" not in starts  # A_SYN_BOOKED holds 06:00 UTC
    free = await api.get(f"/doctors/{OTIENO}/availability?date=2026-10-23")
    assert "2026-10-23T09:00:00+03:00" in {s["starts_at"] for s in free.json()["slots"]}


# --- only the signed smoke path can create a synthetic patient -------------------------------


async def test_a_public_request_cannot_set_synthetic(
    api: httpx.AsyncClient, owner_conn: asyncpg.Connection
) -> None:
    refused = await api.post("/patients", json={"full_name": "Sneaky Caller", "synthetic": True})
    assert refused.status_code == 422
    plain = await api.post("/patients", json={"full_name": "Ordinary Caller"})
    assert plain.status_code == 201
    assert "synthetic" not in plain.json()
    row = await owner_conn.fetchrow(
        "SELECT synthetic FROM patients WHERE id = $1", uuid.UUID(plain.json()["id"])
    )
    assert row is not None and row["synthetic"] is False


async def _post_smoke(
    api: httpx.AsyncClient, headers_for: Callable[[str, bytes], dict[str, str]]
) -> httpx.Response:
    body = b'{"full_name":"verify-claims 20261018T120000 1"}'
    return await api.post(
        "/internal/smoke/patients",
        content=body,
        headers={
            "Content-Type": "application/json",
            **headers_for("/internal/smoke/patients", body),
        },
    )


async def test_the_smoke_endpoint_creates_a_synthetic_patient(
    api: httpx.AsyncClient, owner_conn: asyncpg.Connection
) -> None:
    resp = await _post_smoke(
        api,
        lambda p, b: _headers(p, SMOKE_KEY, role="smoke", sub=SMOKE_SUB, method="POST", body=b),
    )
    assert resp.status_code == 201, resp.text
    assert "synthetic" not in resp.json()
    row = await owner_conn.fetchrow(
        "SELECT synthetic FROM patients WHERE id = $1", uuid.UUID(resp.json()["id"])
    )
    assert row is not None and row["synthetic"] is True


async def test_the_smoke_endpoint_refuses_every_other_caller(api: httpx.AsyncClient) -> None:
    def sign_with(key: str, role: str, sub: str) -> Callable[[str, bytes], dict[str, str]]:
        return lambda p, b: _headers(p, key, role=role, sub=sub, method="POST", body=b)

    # The web apps' key does not open it, even with the smoke role and subject.
    assert (await _post_smoke(api, sign_with(KEY, "smoke", SMOKE_SUB))).status_code == 401
    # The right key with the wrong role or subject.
    assert (await _post_smoke(api, sign_with(SMOKE_KEY, "owner", SMOKE_SUB))).status_code == 403
    assert (
        await _post_smoke(api, sign_with(SMOKE_KEY, "smoke", "someone-else"))
    ).status_code == 403
    # No assertion at all.
    assert (await _post_smoke(api, lambda p, b: {})).status_code == 401
    # The smoke key does not open the admin or patient endpoints either.
    path = "/internal/admin/metrics?from=2026-10-17&to=2026-10-18"
    assert (await api.get(path, headers=_headers(path, SMOKE_KEY, role="owner"))).status_code == 401


async def test_with_no_smoke_key_configured_the_endpoint_is_closed() -> None:
    app = create_app(make_settings(INTERNAL_SIGNING_KEY=KEY))
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        resp = await _post_smoke(
            c,
            lambda p, b: _headers(p, SMOKE_KEY, role="smoke", sub=SMOKE_SUB, method="POST", body=b),
        )
    assert resp.status_code == 401


async def test_the_two_keys_must_differ() -> None:
    with pytest.raises(ValueError, match="must differ"):
        make_settings(INTERNAL_SIGNING_KEY=KEY, SMOKE_SIGNING_KEY=KEY)


async def test_the_smoke_endpoint_is_not_in_the_published_contract(
    api: httpx.AsyncClient,
) -> None:
    spec = (await api.get("/openapi.json")).json()
    assert not any("smoke" in path for path in spec["paths"])


async def test_verify_claims_signs_in_a_way_the_endpoint_accepts_and_marks_its_patients(
    api: httpx.AsyncClient, owner_conn: asyncpg.Connection
) -> None:
    """The script's own signer and its _new_patient path, against the real endpoint. The script is
    synchronous, so its signed request is replayed through the async client."""
    script = _load_script()
    captured: list[httpx.Request] = []

    def capture(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(201, json={"id": str(uuid.uuid4())})

    with httpx.Client(
        base_url="http://testserver", transport=httpx.MockTransport(capture)
    ) as sync_client:
        script._new_patient(sync_client, 1, SMOKE_KEY)
    (req,) = captured
    assert req.url.path == "/internal/smoke/patients"
    # Re-send the exact bytes and header the script produced, now with the clock the API uses.
    iat = int(FIXED_NOW.timestamp())
    token = script.smoke_assertion(SMOKE_KEY, path=req.url.path, body=req.content, now=iat)
    resp = await api.post(
        req.url.path,
        content=req.content,
        headers={"Content-Type": "application/json", "X-Internal-Assertion": token},
    )
    assert resp.status_code == 201, resp.text
    row = await owner_conn.fetchrow(
        "SELECT full_name, synthetic FROM patients WHERE id = $1", uuid.UUID(resp.json()["id"])
    )
    assert row is not None and row["synthetic"] is True
    assert row["full_name"].startswith("verify-claims ")


# --- the realtime admin feed skips synthetic rows ---------------------------------------------


async def test_the_admin_feed_skips_a_synthetic_booking_but_patients_still_hear_it(
    realtime_clean: None, owner_conn: asyncpg.Connection
) -> None:
    publisher = RecordingPublisher()
    app = make_realtime_app(publisher, SMOKE_SIGNING_KEY=SMOKE_KEY, INTERNAL_SIGNING_KEY=KEY)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        made = await _post_smoke(
            c,
            lambda p, b: _headers(p, SMOKE_KEY, role="smoke", sub=SMOKE_SUB, method="POST", body=b),
        )
        synthetic = made.json()["id"]
        booked = await c.post(
            "/appointments",
            json={
                "doctor_id": str(OTIENO),
                "patient_id": synthetic,
                "starts_at": "2026-10-26T09:00:00+03:00",
            },
        )
        assert booked.status_code == 201, booked.text
        cancelled = await c.patch(
            f"/appointments/{booked.json()['id']}/cancel", json={"reason": "verify-claims cleanup"}
        )
        assert cancelled.status_code == 200
        ordinary = await c.post(
            "/appointments",
            json={
                "doctor_id": str(OTIENO),
                "patient_id": str(AMINA),
                "starts_at": "2026-10-26T10:00:00+03:00",
            },
        )
        assert ordinary.status_code == 201
    names = [(m.channel.split(":")[0], m.name) for m in publisher.messages]
    # The synthetic booking and cancel free and take the slot for patients, never reach admin; the
    # ordinary booking reaches both.
    assert names == [
        ("slots", "slot_taken"),
        ("slots", "slot_freed"),
        ("slots", "slot_taken"),
        ("admin", "booked"),
    ]
    cursor = await owner_conn.fetchrow("SELECT id FROM event_relay_cursor")
    last = await owner_conn.fetchval("SELECT max(id) FROM appointment_events")
    assert cursor is not None and cursor["id"] == last  # the cursor moved past the skipped events


async def test_the_column_is_not_null_and_defaults_to_false(
    owner_conn: asyncpg.Connection,
) -> None:
    row: Any = await owner_conn.fetchrow(
        "SELECT is_nullable, column_default, data_type FROM information_schema.columns "
        "WHERE table_name = 'patients' AND column_name = 'synthetic'"
    )
    assert (row["is_nullable"], row["column_default"], row["data_type"]) == (
        "NO",
        "false",
        "boolean",
    )
