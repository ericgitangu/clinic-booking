from __future__ import annotations

from datetime import UTC, datetime

import httpx
import pytest

from app.api.deps import get_clock
from app.core.clock import FakeClock
from tests.conftest import seeded_doctor_id, seeded_patient_id

pytestmark = pytest.mark.asyncio

OTIENO = str(seeded_doctor_id("otieno"))
AMINA = str(seeded_patient_id("amina"))
BOOK_AT = "2026-10-26T09:00:00+03:00"


async def _book(client: httpx.AsyncClient) -> str:
    resp = await client.post(
        "/appointments", json={"doctor_id": OTIENO, "patient_id": AMINA, "starts_at": BOOK_AT}
    )
    assert resp.status_code == 201, resp.text
    return str(resp.json()["id"])


async def test_cancel_ok_frees_slot(client: httpx.AsyncClient, reset_appointments: None) -> None:
    appt_id = await _book(client)
    resp = await client.patch(
        f"/appointments/{appt_id}/cancel", json={"reason": "patient requested"}
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "cancelled"
    # The slot is bookable again.
    avail = await client.get(f"/doctors/{OTIENO}/availability?date=2026-10-26")
    starts = {s["starts_at"] for s in avail.json()["slots"]}
    assert any("T09:00:00+03:00" in s for s in starts)  # 09:00 EAT slot bookable again


async def test_cancel_twice_409(client: httpx.AsyncClient, reset_appointments: None) -> None:
    appt_id = await _book(client)
    await client.patch(f"/appointments/{appt_id}/cancel", json={"reason": "first cancel"})
    again = await client.patch(f"/appointments/{appt_id}/cancel", json={"reason": "second try"})
    assert again.status_code == 409
    assert again.json()["code"] == "APPOINTMENT_ALREADY_CANCELLED"


async def test_cancel_not_found_404(client: httpx.AsyncClient) -> None:
    resp = await client.patch(
        "/appointments/00000000-0000-0000-0000-000000000000/cancel",
        json={"reason": "whatever"},
    )
    assert resp.status_code == 404
    assert resp.json()["code"] == "APPOINTMENT_NOT_FOUND"


async def test_cancel_reason_too_short_422(
    client: httpx.AsyncClient, reset_appointments: None
) -> None:
    appt_id = await _book(client)
    resp = await client.patch(f"/appointments/{appt_id}/cancel", json={"reason": "x"})
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDATION_ERROR"


async def test_cancel_already_started_409(
    client: httpx.AsyncClient, app_with_clock: object, reset_appointments: None
) -> None:
    appt_id = await _book(client)
    # Advance the clock past the appointment.
    app_with_clock.dependency_overrides[get_clock] = lambda: FakeClock(  # type: ignore[attr-defined]
        datetime(2026, 10, 27, 0, 0, tzinfo=UTC)
    )
    resp = await client.patch(f"/appointments/{appt_id}/cancel", json={"reason": "too late now"})
    assert resp.status_code == 409
    assert resp.json()["code"] == "APPOINTMENT_ALREADY_STARTED"
