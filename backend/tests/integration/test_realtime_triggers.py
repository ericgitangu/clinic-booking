"""Every write path pushes: public, patient-account and admin routes; and a slow service never
holds a response longer than the relay timeout."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Sequence

import httpx
import pytest
from fastapi import FastAPI

from app.domain.realtime import OutboundMessage
from tests.conftest import seeded_doctor_id, seeded_patient_id
from tests.integration import test_access, test_me
from tests.integration.realtime_support import RecordingPublisher, make_realtime_app

pytestmark = pytest.mark.asyncio

OTIENO = seeded_doctor_id("otieno")
SLOT_A = "2026-10-26T09:00:00+03:00"
SLOT_B = "2026-10-26T10:00:00+03:00"


def _client(app: FastAPI) -> httpx.AsyncClient:
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    return httpx.AsyncClient(transport=transport, base_url="http://testserver")


def _names(publisher: RecordingPublisher) -> list[str]:
    return [m.name for m in publisher.messages if m.channel != "admin:events"]


class Hanging(RecordingPublisher):
    """A push service that accepts the connection and never answers."""

    async def publish(self, messages: Sequence[OutboundMessage]) -> None:
        await asyncio.sleep(3600)


async def test_a_hanging_service_cannot_hold_a_booking_past_the_relay_timeout(
    realtime_clean: None,
) -> None:
    app = make_realtime_app(Hanging(), REALTIME_RELAY_TIMEOUT_SECONDS=2.0)
    async with _client(app) as c:
        started = time.monotonic()
        async with asyncio.timeout(10):  # without the relay's own timeout this would run to here
            resp = await c.post(
                "/appointments",
                json={
                    "doctor_id": str(OTIENO),
                    "patient_id": str(seeded_patient_id("amina")),
                    "starts_at": SLOT_A,
                },
            )
        elapsed = time.monotonic() - started
    assert resp.status_code == 201
    assert elapsed < 2.5, f"the booking took {elapsed:.2f}s with the push service hanging"


async def test_the_patient_account_routes_push_book_reschedule_and_cancel(
    realtime_clean: None,
) -> None:
    publisher = RecordingPublisher()
    app = make_realtime_app(publisher, INTERNAL_SIGNING_KEY=test_me.KEY)
    who = test_me.ALICE
    async with _client(app) as c:
        assert (await test_me.link(c, who)).status_code in (200, 201)
        booked = await test_me.book_slot(c, who, OTIENO, SLOT_A)
        assert booked.status_code == 201, booked.text
        assert _names(publisher) == ["slot_taken"], "POST /internal/me/appointments"
        appt = booked.json()["id"]
        moved = await test_me.call(
            c,
            "PATCH",
            f"/internal/me/appointments/{appt}/reschedule",
            who,
            f'{{"starts_at":"{SLOT_B}"}}',
        )
        assert moved.status_code == 200, moved.text
        assert _names(publisher) == ["slot_taken", "slot_freed", "slot_taken"], "reschedule"
        gone = await test_me.call(
            c,
            "PATCH",
            f"/internal/me/appointments/{appt}/cancel",
            who,
            '{"reason":"no longer needed"}',
        )
        assert gone.status_code == 200, gone.text
    assert _names(publisher) == ["slot_taken", "slot_freed", "slot_taken", "slot_freed"], "cancel"


async def test_the_admin_cancel_and_reschedule_routes_push(realtime_clean: None) -> None:
    publisher = RecordingPublisher()
    app = make_realtime_app(
        publisher, INTERNAL_SIGNING_KEY=test_access.KEY, ADMIN_EMAILS=test_access.OWNER
    )
    async with _client(app) as c:
        booked = await c.post(
            "/appointments",
            json={
                "doctor_id": str(OTIENO),
                "patient_id": str(seeded_patient_id("amina")),
                "starts_at": SLOT_A,
            },
        )
        appt = booked.json()["id"]
        assert _names(publisher) == ["slot_taken"]

        async def admin(method: str, path: str, body: str) -> httpx.Response:
            raw = body.encode()
            headers = test_access._headers(  # noqa: SLF001  # the shared signing helper
                method, path, email=test_access.OWNER, role="owner", body=raw
            )
            return await c.request(method, path, headers=headers, content=raw)

        moved = await admin(
            "PATCH",
            f"/internal/admin/appointments/{appt}/reschedule",
            f'{{"starts_at":"{SLOT_B}"}}',
        )
        assert moved.status_code == 200, moved.text
        assert _names(publisher) == ["slot_taken", "slot_freed", "slot_taken"], "admin reschedule"
        gone = await admin(
            "PATCH", f"/internal/admin/appointments/{appt}/cancel", '{"reason":"clinic closed"}'
        )
        assert gone.status_code == 200, gone.text
    assert _names(publisher) == ["slot_taken", "slot_freed", "slot_taken", "slot_freed"], (
        "admin cancel"
    )
