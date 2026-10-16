from __future__ import annotations

import httpx
import pytest

from tests.conftest import seeded_doctor_id, seeded_patient_id

pytestmark = pytest.mark.asyncio

OTIENO = str(seeded_doctor_id("otieno"))
KAMAU = str(seeded_doctor_id("kamau"))
AMINA = str(seeded_patient_id("amina"))


async def test_upcoming_sorted_with_doctor(
    client: httpx.AsyncClient, reset_appointments: None
) -> None:
    await client.post(
        "/appointments",
        json={"doctor_id": KAMAU, "patient_id": AMINA, "starts_at": "2026-10-26T10:00:00+03:00"},
    )
    await client.post(
        "/appointments",
        json={"doctor_id": OTIENO, "patient_id": AMINA, "starts_at": "2026-10-26T09:00:00+03:00"},
    )
    resp = await client.get(f"/patients/{AMINA}/appointments")
    assert resp.status_code == 200
    body = resp.json()
    assert body["next_cursor"] is None
    starts = [i["starts_at"] for i in body["items"]]
    assert starts == sorted(starts)  # ORDER BY starts_at
    assert all("doctor" in i and i["doctor"]["full_name"] for i in body["items"])
    assert len(body["items"]) == 2


async def test_cancelled_not_listed(client: httpx.AsyncClient, reset_appointments: None) -> None:
    created = await client.post(
        "/appointments",
        json={"doctor_id": OTIENO, "patient_id": AMINA, "starts_at": "2026-10-26T09:00:00+03:00"},
    )
    appt_id = created.json()["id"]
    await client.patch(f"/appointments/{appt_id}/cancel", json={"reason": "no longer needed"})
    resp = await client.get(f"/patients/{AMINA}/appointments")
    assert all(i["id"] != appt_id for i in resp.json()["items"])


async def test_patient_not_found_404(client: httpx.AsyncClient) -> None:
    resp = await client.get("/patients/00000000-0000-0000-0000-000000000000/appointments")
    assert resp.status_code == 404
    assert resp.json()["code"] == "PATIENT_NOT_FOUND"


async def test_bad_limit_422(client: httpx.AsyncClient) -> None:
    resp = await client.get(f"/patients/{AMINA}/appointments?limit=0")
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDATION_ERROR"
