from __future__ import annotations

from datetime import UTC, datetime, timedelta

import httpx
import pytest

from tests.conftest import first_available, seeded_doctor_id, seeded_patient_id

pytestmark = pytest.mark.asyncio


async def test_availability_returns_slots(client: httpx.AsyncClient) -> None:
    did = seeded_doctor_id("otieno")
    date_str, slot0 = await first_available(client, did)
    resp = await client.get(f"/doctors/{did}/availability?date={date_str}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["slot_minutes"] == 30
    assert body["timezone"] == "Africa/Nairobi"
    assert len(body["slots"]) >= 1
    assert resp.headers["cache-control"] == "no-store"


async def test_availability_past_date_empty(client: httpx.AsyncClient) -> None:
    did = seeded_doctor_id("otieno")
    resp = await client.get(f"/doctors/{did}/availability?date=2026-10-12")  # before FakeClock
    assert resp.status_code == 200
    assert resp.json()["slots"] == []


async def test_availability_unknown_doctor_404(client: httpx.AsyncClient) -> None:
    resp = await client.get(
        "/doctors/00000000-0000-0000-0000-000000000000/availability?date=2026-10-26"
    )
    assert resp.status_code == 404
    assert resp.json()["code"] == "DOCTOR_NOT_FOUND"


async def test_availability_bad_date_422(client: httpx.AsyncClient) -> None:
    did = seeded_doctor_id("otieno")
    resp = await client.get(f"/doctors/{did}/availability?date=not-a-date")
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDATION_ERROR"


async def test_availability_out_of_horizon_422(client: httpx.AsyncClient) -> None:
    did = seeded_doctor_id("otieno")
    far = (datetime(2026, 10, 19, tzinfo=UTC) + timedelta(days=200)).date().isoformat()
    resp = await client.get(f"/doctors/{did}/availability?date={far}")
    assert resp.status_code == 422
    assert resp.json()["code"] == "DATE_OUT_OF_RANGE"


async def test_availability_uses_local_day_bounds(
    client: httpx.AsyncClient, reset_appointments: None
) -> None:
    did = seeded_doctor_id("otieno")
    patient = seeded_patient_id("amina")
    created = await client.post(
        "/appointments",
        json={
            "doctor_id": str(did),
            "patient_id": str(patient),
            "starts_at": "2026-10-26T09:00:00+03:00",  # 09:00 EAT, Mon
        },
    )
    assert created.status_code == 201

    mon = await client.get(f"/doctors/{did}/availability?date=2026-10-26")
    mon_starts = {s["starts_at"] for s in mon.json()["slots"]}
    assert not any("T09:00:00+03:00" in s for s in mon_starts)  # booked, excluded on its day

    tue = await client.get(f"/doctors/{did}/availability?date=2026-10-27")
    tue_starts = {s["starts_at"] for s in tue.json()["slots"]}
    assert any("T09:00:00+03:00" in s for s in tue_starts)  # next day unaffected


@pytest.mark.parametrize("doctor", ["otieno", "kamau"])
@pytest.mark.parametrize("day", ["2026-10-26", "2026-10-28"])
async def test_every_offered_slot_books_with_the_advertised_end(
    client: httpx.AsyncClient, reset_appointments: None, doctor: str, day: str
) -> None:
    # The feed and the booking rules must agree: whatever availability offers, POST accepts, and
    # the appointment spans exactly the advertised interval.
    did = seeded_doctor_id(doctor)
    offered = (await client.get(f"/doctors/{did}/availability?date={day}")).json()["slots"]
    assert len(offered) >= 8, "the doctor works that day"
    patients = [seeded_patient_id(k) for k in ("amina", "brian", "wanjiru")]
    for i, slot in enumerate(offered):
        resp = await client.post(
            "/appointments",
            json={
                "doctor_id": str(did),
                "patient_id": str(patients[i % len(patients)]),
                "starts_at": slot["starts_at"],
            },
        )
        assert resp.status_code == 201, (slot, resp.text)
        booked = resp.json()
        assert booked["starts_at"] == slot["starts_at"]
        assert booked["ends_at"] == slot["ends_at"]
    after = (await client.get(f"/doctors/{did}/availability?date={day}")).json()["slots"]
    assert after == [], "once every offered slot is booked, nothing is offered"


async def test_availability_has_no_slot_length_parameter(client: httpx.AsyncClient) -> None:
    # Doctors work in 30-minute slots and the bookable grid is fixed by the booking rules, so the
    # feed offers no way to ask for another length: not in the contract, and ignored on the wire.
    spec = (await client.get("/openapi.json")).json()
    params = spec["paths"]["/doctors/{doctor_id}/availability"]["get"]["parameters"]
    assert [p["name"] for p in params] == ["doctor_id", "date"]

    did = seeded_doctor_id("otieno")
    plain = (await client.get(f"/doctors/{did}/availability?date=2026-10-26")).json()
    asked = await client.get(f"/doctors/{did}/availability?date=2026-10-26&slot_minutes=60")
    assert asked.status_code == 200
    assert asked.json() == plain
    assert asked.json()["slot_minutes"] == 30
    for slot in asked.json()["slots"]:
        starts = datetime.fromisoformat(slot["starts_at"])
        assert datetime.fromisoformat(slot["ends_at"]) - starts == timedelta(minutes=30)
