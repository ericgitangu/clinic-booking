from __future__ import annotations

import httpx
import pytest

from tests.conftest import seeded_doctor_id, seeded_patient_id

pytestmark = pytest.mark.asyncio

OTIENO = str(seeded_doctor_id("otieno"))
AMINA = str(seeded_patient_id("amina"))
WANJIRU = str(seeded_patient_id("wanjiru"))
AT_0900 = "2026-10-26T09:00:00+03:00"
AT_1000 = "2026-10-26T10:00:00+03:00"


async def _book(client: httpx.AsyncClient, patient: str, starts_at: str) -> str:
    resp = await client.post(
        "/appointments", json={"doctor_id": OTIENO, "patient_id": patient, "starts_at": starts_at}
    )
    assert resp.status_code == 201, resp.text
    return str(resp.json()["id"])


async def test_reschedule_ok(client: httpx.AsyncClient, reset_appointments: None) -> None:
    appt_id = await _book(client, AMINA, AT_0900)
    resp = await client.patch(f"/appointments/{appt_id}/reschedule", json={"starts_at": AT_1000})
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == appt_id  # same id
    assert "T10:00:00+03:00" in body["starts_at"]  # output in clinic offset


async def test_reschedule_same_start_noop(
    client: httpx.AsyncClient, reset_appointments: None
) -> None:
    appt_id = await _book(client, AMINA, AT_0900)
    resp = await client.patch(f"/appointments/{appt_id}/reschedule", json={"starts_at": AT_0900})
    assert resp.status_code == 200
    assert resp.json()["id"] == appt_id


async def test_reschedule_into_taken_slot_409(
    client: httpx.AsyncClient, reset_appointments: None
) -> None:
    amina_appt = await _book(client, AMINA, AT_0900)
    await _book(client, WANJIRU, AT_1000)  # occupies 10:00
    resp = await client.patch(f"/appointments/{amina_appt}/reschedule", json={"starts_at": AT_1000})
    assert resp.status_code == 409
    assert resp.json()["code"] == "SLOT_TAKEN"


async def test_reschedule_cancelled_409(
    client: httpx.AsyncClient, reset_appointments: None
) -> None:
    appt_id = await _book(client, AMINA, AT_0900)
    await client.patch(f"/appointments/{appt_id}/cancel", json={"reason": "cancel first"})
    resp = await client.patch(f"/appointments/{appt_id}/reschedule", json={"starts_at": AT_1000})
    assert resp.status_code == 409
    assert resp.json()["code"] == "APPOINTMENT_ALREADY_CANCELLED"


async def test_reschedule_not_found_404(client: httpx.AsyncClient) -> None:
    resp = await client.patch(
        "/appointments/00000000-0000-0000-0000-000000000000/reschedule",
        json={"starts_at": AT_1000},
    )
    assert resp.status_code == 404
    assert resp.json()["code"] == "APPOINTMENT_NOT_FOUND"


async def test_reschedule_outside_hours_422(
    client: httpx.AsyncClient, reset_appointments: None
) -> None:
    appt_id = await _book(client, AMINA, AT_0900)
    resp = await client.patch(
        f"/appointments/{appt_id}/reschedule", json={"starts_at": "2026-10-26T12:00:00+03:00"}
    )
    assert resp.status_code == 422
    assert resp.json()["code"] == "OUTSIDE_WORKING_HOURS"
