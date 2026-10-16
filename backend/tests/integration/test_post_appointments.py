from __future__ import annotations

import httpx
import pytest

from tests.conftest import seeded_doctor_id, seeded_patient_id

pytestmark = pytest.mark.asyncio

OTIENO = str(seeded_doctor_id("otieno"))
KAMAU = str(seeded_doctor_id("kamau"))
AMINA = str(seeded_patient_id("amina"))
BRIAN = str(seeded_patient_id("brian"))

# 09:00 EAT on Mon 2026-10-26: inside both Otieno's and Kamau's Monday windows, future,
# aligned, inside the horizon.
BOOK_AT = "2026-10-26T09:00:00+03:00"


def _body(
    doctor: str = OTIENO, patient: str = AMINA, starts_at: object = BOOK_AT
) -> dict[str, object]:
    return {"doctor_id": doctor, "patient_id": patient, "starts_at": starts_at}


async def test_book_201_then_slot_taken(
    client: httpx.AsyncClient, reset_appointments: None
) -> None:
    first = await client.post("/appointments", json=_body())
    assert first.status_code == 201, first.text
    assert first.headers["location"] == f"/appointments/{first.json()['id']}"
    assert first.json()["status"] == "booked"
    # Same doctor+slot, different patient -> SLOT_TAKEN.
    dup = await client.post("/appointments", json=_body(patient=BRIAN))
    assert dup.status_code == 409
    assert dup.json()["code"] == "SLOT_TAKEN"


async def test_patient_double_booked(client: httpx.AsyncClient, reset_appointments: None) -> None:
    first = await client.post("/appointments", json=_body())
    assert first.status_code == 201
    # Same patient+instant, different doctor (both work Mondays at 09:00) -> double-booked.
    dup = await client.post("/appointments", json=_body(doctor=KAMAU))
    assert dup.status_code == 409
    assert dup.json()["code"] == "PATIENT_DOUBLE_BOOKED"


async def test_timezone_required(client: httpx.AsyncClient) -> None:
    resp = await client.post("/appointments", json=_body(starts_at="2026-10-26T09:00:00"))
    assert resp.status_code == 422
    assert resp.json()["code"] == "TIMEZONE_REQUIRED"


async def test_non_string_datetime_validation_error(client: httpx.AsyncClient) -> None:
    resp = await client.post("/appointments", json=_body(starts_at=123))
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDATION_ERROR"


async def test_unknown_doctor(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/appointments", json=_body(doctor="00000000-0000-0000-0000-000000000000")
    )
    assert resp.status_code == 422
    assert resp.json()["code"] == "UNKNOWN_DOCTOR"


async def test_unknown_patient(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/appointments", json=_body(patient="00000000-0000-0000-0000-000000000000")
    )
    assert resp.status_code == 422
    assert resp.json()["code"] == "UNKNOWN_PATIENT"


async def test_slot_in_past(client: httpx.AsyncClient) -> None:
    resp = await client.post("/appointments", json=_body(starts_at="2026-10-19T03:00:00+03:00"))
    assert resp.status_code == 422
    assert resp.json()["code"] == "SLOT_IN_PAST"


async def test_booking_too_soon(client: httpx.AsyncClient) -> None:
    # now = 07:00 EAT; 07:30 EAT is < 60 min lead ahead.
    resp = await client.post("/appointments", json=_body(starts_at="2026-10-19T07:30:00+03:00"))
    assert resp.status_code == 422
    assert resp.json()["code"] == "BOOKING_TOO_SOON"


async def test_date_out_of_range(client: httpx.AsyncClient) -> None:
    resp = await client.post("/appointments", json=_body(starts_at="2027-06-01T09:00:00+03:00"))
    assert resp.status_code == 422
    assert resp.json()["code"] == "DATE_OUT_OF_RANGE"


async def test_slot_misaligned_seconds(client: httpx.AsyncClient) -> None:
    resp = await client.post("/appointments", json=_body(starts_at="2026-10-26T09:00:15+03:00"))
    assert resp.status_code == 422
    assert resp.json()["code"] == "SLOT_MISALIGNED"


async def test_outside_working_hours(client: httpx.AsyncClient) -> None:
    # 12:00 EAT is Otieno's lunch break.
    resp = await client.post("/appointments", json=_body(starts_at="2026-10-26T12:00:00+03:00"))
    assert resp.status_code == 422
    assert resp.json()["code"] == "OUTSIDE_WORKING_HOURS"
