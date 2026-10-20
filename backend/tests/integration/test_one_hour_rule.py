"""The one-hour rule on every change, at 59, 60 and 61 minutes, with a controlled clock.

An appointment (or a new time) less than 60 minutes away is refused; exactly 60 is allowed.
A booking and a reschedule's new start answer 422 BOOKING_TOO_SOON; cancel and a reschedule's
current start answer 409 CHANGE_TOO_LATE; staff are exempt from both (and from nothing else);
availability never offers a slot inside the window; and a repeat of a change that already
happened still returns its result.
"""

from __future__ import annotations

import secrets
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi import FastAPI

from app.api.deps import get_clock
from app.core.assertion import AUDIENCE, body_hash, sign
from app.core.clock import FakeClock
from app.main import create_app
from tests.conftest import make_settings, seeded_doctor_id, seeded_patient_id

pytestmark = pytest.mark.asyncio

OTIENO = str(seeded_doctor_id("otieno"))
AMINA = str(seeded_patient_id("amina"))
# Monday 26 Oct 2026 09:00 EAT, and Wednesday 28 Oct 09:00 EAT, both inside Dr Otieno's hours.
NEAR = datetime(2026, 10, 26, 6, 0, tzinfo=UTC)
FAR = datetime(2026, 10, 28, 6, 0, tzinfo=UTC)
LONG_AGO = NEAR - timedelta(days=5)
MINUTES = [59, 60, 61]


def _at(minutes_before: int, start: datetime = NEAR) -> datetime:
    return start - timedelta(minutes=minutes_before)


def _clock(app: FastAPI, now: datetime) -> None:
    app.dependency_overrides[get_clock] = lambda: FakeClock(now)


async def _book(
    client: httpx.AsyncClient, app: FastAPI, starts: datetime, key: str | None = None
) -> httpx.Response:
    _clock(app, LONG_AGO)
    return await client.post(
        "/appointments",
        json={"doctor_id": OTIENO, "patient_id": AMINA, "starts_at": starts.isoformat()},
        headers={"Idempotency-Key": key} if key else {},
    )


@pytest.mark.parametrize("minutes", MINUTES)
async def test_book_boundary(
    client: httpx.AsyncClient, app_with_clock: FastAPI, reset_appointments: None, minutes: int
) -> None:
    _clock(app_with_clock, _at(minutes))
    resp = await client.post(
        "/appointments",
        json={"doctor_id": OTIENO, "patient_id": AMINA, "starts_at": NEAR.isoformat()},
    )
    if minutes < 60:
        assert (resp.status_code, resp.json()["code"]) == (422, "BOOKING_TOO_SOON")
    else:
        assert resp.status_code == 201, resp.text


@pytest.mark.parametrize("minutes", MINUTES)
async def test_cancel_boundary(
    client: httpx.AsyncClient, app_with_clock: FastAPI, reset_appointments: None, minutes: int
) -> None:
    appt = (await _book(client, app_with_clock, NEAR)).json()["id"]
    _clock(app_with_clock, _at(minutes))
    resp = await client.patch(f"/appointments/{appt}/cancel", json={"reason": "cannot make it"})
    if minutes < 60:
        assert (resp.status_code, resp.json()["code"]) == (409, "CHANGE_TOO_LATE")
        assert resp.headers["content-type"].startswith("application/problem+json")
        still = await client.get(f"/appointments/{appt}")
        assert still.json()["status"] == "booked"  # nothing changed
    else:
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "cancelled"


@pytest.mark.parametrize("minutes", MINUTES)
async def test_reschedule_boundary_on_the_current_start(
    client: httpx.AsyncClient, app_with_clock: FastAPI, reset_appointments: None, minutes: int
) -> None:
    appt = (await _book(client, app_with_clock, NEAR)).json()["id"]
    _clock(app_with_clock, _at(minutes))
    resp = await client.patch(
        f"/appointments/{appt}/reschedule", json={"starts_at": FAR.isoformat()}
    )
    if minutes < 60:
        assert (resp.status_code, resp.json()["code"]) == (409, "CHANGE_TOO_LATE")
        assert (
            (await client.get(f"/appointments/{appt}")).json()["starts_at"].startswith("2026-10-26")
        )
    else:
        assert resp.status_code == 200, resp.text
        assert resp.json()["starts_at"].startswith("2026-10-28")


@pytest.mark.parametrize("minutes", MINUTES)
async def test_reschedule_boundary_on_the_new_start(
    client: httpx.AsyncClient, app_with_clock: FastAPI, reset_appointments: None, minutes: int
) -> None:
    appt = (await _book(client, app_with_clock, FAR)).json()["id"]
    _clock(app_with_clock, _at(minutes))  # the NEW start (NEAR) is `minutes` away
    resp = await client.patch(
        f"/appointments/{appt}/reschedule", json={"starts_at": NEAR.isoformat()}
    )
    if minutes < 60:
        assert (resp.status_code, resp.json()["code"]) == (422, "BOOKING_TOO_SOON")
    else:
        assert resp.status_code == 200, resp.text


@pytest.mark.parametrize("minutes", MINUTES)
async def test_availability_never_offers_a_slot_inside_the_window(
    client: httpx.AsyncClient, app_with_clock: FastAPI, reset_appointments: None, minutes: int
) -> None:
    _clock(app_with_clock, _at(minutes))
    resp = await client.get(f"/doctors/{OTIENO}/availability?date=2026-10-26")
    assert resp.status_code == 200
    starts = [datetime.fromisoformat(s["starts_at"]) for s in resp.json()["slots"]]
    now = _at(minutes)
    assert starts, "the day has slots"
    assert all(s - now >= timedelta(minutes=60) for s in starts), starts
    assert (NEAR in starts) is (minutes >= 60)  # exactly 60 minutes away is offered


async def test_staff_are_exempt_from_the_rule_the_patient_is_held_to(
    reset_appointments: None,
) -> None:
    key = secrets.token_hex(24)
    owner = "owner@clinic.example"
    app = create_app(make_settings(INTERNAL_SIGNING_KEY=key, ADMIN_EMAILS=owner))
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)

    def headers(path: str, body: bytes, now: datetime) -> dict[str, str]:
        claims: dict[str, object] = {
            "aud": AUDIENCE,
            "sub": "s",
            "email": owner,
            "role": "owner",
            "iat": int(now.timestamp()),
            "exp": int(now.timestamp()) + 60,
            "m": "PATCH",
            "p": path,
            "bh": body_hash(body),
            "jti": uuid.uuid4().hex,  # a fresh nonce: the API refuses a repeated assertion
            "ev": True,
        }
        return {
            "X-Internal-Assertion": sign(claims, key.encode()),
            "Content-Type": "application/json",
        }

    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        _clock(app, LONG_AGO)
        appt = (
            await c.post(
                "/appointments",
                json={"doctor_id": OTIENO, "patient_id": AMINA, "starts_at": NEAR.isoformat()},
            )
        ).json()["id"]
        path = f"/internal/admin/appointments/{appt}/cancel"
        body = b'{"reason":"staff cancel"}'
        now = _at(59)
        _clock(app, now)
        patient = await c.patch(f"/appointments/{appt}/cancel", json={"reason": "patient cancel"})
        assert patient.status_code == 409
        assert patient.json()["code"] == "CHANGE_TOO_LATE"
        staff = await c.patch(path, content=body, headers=headers(path, body, now))
        assert staff.status_code == 200, staff.text


async def test_a_replayed_booking_still_returns_the_original_inside_the_window(
    client: httpx.AsyncClient, app_with_clock: FastAPI, reset_appointments: None
) -> None:
    first = await _book(client, app_with_clock, NEAR, key="one-hour-replay-1")
    assert first.status_code == 201
    _clock(app_with_clock, _at(30))  # the slot is now 30 minutes away: a NEW booking is refused
    again = await client.post(
        "/appointments",
        json={"doctor_id": OTIENO, "patient_id": AMINA, "starts_at": NEAR.isoformat()},
        headers={"Idempotency-Key": "one-hour-replay-1"},
    )
    assert again.status_code == 201
    assert again.headers["Idempotent-Replayed"] == "true"
    assert again.json()["id"] == first.json()["id"]


async def test_a_repeated_reschedule_that_already_happened_returns_the_appointment(
    client: httpx.AsyncClient, app_with_clock: FastAPI, reset_appointments: None
) -> None:
    appt = (await _book(client, app_with_clock, FAR)).json()["id"]
    _clock(app_with_clock, LONG_AGO)
    moved = await client.patch(
        f"/appointments/{appt}/reschedule", json={"starts_at": NEAR.isoformat()}
    )
    assert moved.status_code == 200
    _clock(app_with_clock, _at(30))  # the retry arrives when the new time is 30 minutes away
    retry = await client.patch(
        f"/appointments/{appt}/reschedule", json={"starts_at": NEAR.isoformat()}
    )
    assert retry.status_code == 200
    assert retry.json()["id"] == appt and retry.json()["starts_at"] == moved.json()["starts_at"]


async def test_a_repeated_cancel_keeps_its_own_answer_inside_the_window(
    client: httpx.AsyncClient, app_with_clock: FastAPI, reset_appointments: None
) -> None:
    appt = (await _book(client, app_with_clock, NEAR)).json()["id"]
    _clock(app_with_clock, _at(120))
    assert (
        await client.patch(f"/appointments/{appt}/cancel", json={"reason": "plans changed"})
    ).status_code == 200
    _clock(app_with_clock, _at(30))
    again = await client.patch(f"/appointments/{appt}/cancel", json={"reason": "plans changed"})
    assert (again.status_code, again.json()["code"]) == (409, "APPOINTMENT_ALREADY_CANCELLED")


# --- precedence, staff and the signed-in patient's own routes ----------------------------------

_KEY = secrets.token_hex(24)
_OWNER = "owner@clinic.example"


def _headers(
    app_now: datetime, method: str, path: str, *, sub: str, email: str, role: str, body: bytes = b""
) -> dict[str, str]:
    claims: dict[str, object] = {
        "aud": AUDIENCE, "sub": sub, "email": email, "role": role,
        "iat": int(app_now.timestamp()), "exp": int(app_now.timestamp()) + 60,
        "m": method, "p": path, "bh": body_hash(body), "ev": True,
        "jti": uuid.uuid4().hex,
    }  # fmt: skip
    return {"X-Internal-Assertion": sign(claims, _KEY.encode()), "content-type": "application/json"}


async def test_both_starts_under_an_hour_answers_409_the_current_start_is_checked_first(
    client: httpx.AsyncClient, app_with_clock: FastAPI, reset_appointments: None
) -> None:
    appt = (await _book(client, app_with_clock, NEAR)).json()["id"]
    _clock(app_with_clock, _at(15))  # the visit starts in 15 minutes
    # The target is on the half-hour grid, in working hours, a different time, and 45 minutes away:
    # under an hour too. Were the new time checked first, this would be 422 BOOKING_TOO_SOON.
    target = NEAR + timedelta(minutes=30)
    resp = await client.patch(
        f"/appointments/{appt}/reschedule", json={"starts_at": target.isoformat()}
    )
    assert (resp.status_code, resp.json()["code"]) == (409, "CHANGE_TOO_LATE")
    # Control: the same target from a visit that is far away is the too-soon-slot error.
    far = (await _book(client, app_with_clock, FAR)).json()["id"]
    _clock(app_with_clock, _at(15))
    other = await client.patch(
        f"/appointments/{far}/reschedule", json={"starts_at": target.isoformat()}
    )
    assert (other.status_code, other.json()["code"]) == (422, "BOOKING_TOO_SOON")


async def test_staff_reschedule_is_exempt_from_both_codes(reset_appointments: None) -> None:
    owner = "owner@clinic.example"
    app = create_app(make_settings(INTERNAL_SIGNING_KEY=_KEY, ADMIN_EMAILS=owner))
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        _clock(app, LONG_AGO)
        near = (
            await c.post(
                "/appointments",
                json={"doctor_id": OTIENO, "patient_id": AMINA, "starts_at": NEAR.isoformat()},
            )
        ).json()["id"]
        far = (
            await c.post(
                "/appointments",
                json={"doctor_id": OTIENO, "patient_id": AMINA, "starts_at": FAR.isoformat()},
            )
        ).json()["id"]

        async def patch(
            appt: str, op: str, now: datetime, payload: dict[str, str]
        ) -> httpx.Response:
            import json

            _clock(app, now)
            path = f"/internal/admin/appointments/{appt}/{op}"
            body = json.dumps(payload).encode()
            return await c.patch(
                path,
                content=body,
                headers=_headers(now, "PATCH", path, sub="s", email=owner, role="owner", body=body),
            )

        # Staff are exempt from the lead-time rule and only from it: moving a visit that is
        # within the hour, and moving a far one to a too-soon time, both go through.
        r = await patch(
            near,
            "reschedule",
            _at(30),
            {"starts_at": (FAR + timedelta(minutes=30)).isoformat(), "reason": "doctor is free"},
        )
        assert r.status_code == 200, r.text
        r = await patch(
            far,
            "reschedule",
            _at(30),
            {
                "starts_at": (NEAR + timedelta(minutes=30)).isoformat(),
                "reason": "walk-in at the desk",
            },
        )
        assert r.status_code == 200, r.text


async def test_a_signed_in_patient_cancels_and_reschedules_under_the_same_rules(
    reset_appointments: None, owner_conn: object
) -> None:
    import json

    app = create_app(make_settings(INTERNAL_SIGNING_KEY=_KEY))
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    sub, email = "sub-one-hour", "one.hour@example.test"
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        _clock(app, LONG_AGO)

        async def call(
            method: str, path: str, payload: dict[str, str], now: datetime
        ) -> httpx.Response:
            _clock(app, now)
            body = json.dumps(payload).encode()
            return await c.request(
                method,
                path,
                content=body,
                headers=_headers(now, method, path, sub=sub, email=email, role="none", body=body),
            )

        linked = await call("POST", "/internal/accounts/link", {"full_name": "One Hour"}, LONG_AGO)
        patient = linked.json()["patient_id"]
        ids = []
        for start in (NEAR, FAR):
            _clock(app, LONG_AGO)
            booked = await c.post(
                "/appointments",
                json={"doctor_id": OTIENO, "patient_id": patient, "starts_at": start.isoformat()},
            )
            assert booked.status_code == 201, booked.text
            ids.append(booked.json()["id"])
        near, far = ids

        r = await call(
            "PATCH", f"/internal/me/appointments/{near}/cancel", {"reason": "cannot go"}, _at(59)
        )
        assert (r.status_code, r.json()["code"]) == (409, "CHANGE_TOO_LATE")
        r = await call(
            "PATCH",
            f"/internal/me/appointments/{near}/reschedule",
            {"starts_at": FAR.isoformat()},
            _at(59),
        )
        assert (r.status_code, r.json()["code"]) == (409, "CHANGE_TOO_LATE")
        r = await call(
            "PATCH",
            f"/internal/me/appointments/{far}/reschedule",
            {"starts_at": NEAR.isoformat()},
            _at(59),
        )
        assert (r.status_code, r.json()["code"]) == (422, "BOOKING_TOO_SOON")
        r = await call(
            "PATCH", f"/internal/me/appointments/{near}/cancel", {"reason": "cannot go"}, _at(60)
        )
        assert r.status_code == 200, r.text
