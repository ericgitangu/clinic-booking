from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import asyncpg
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


# --- taken: the booked half of the day's grid ----------------------------------------------------


def _starts(body: dict[str, object], key: str) -> list[str]:
    items = body[key]
    assert isinstance(items, list)
    return [i["starts_at"] if isinstance(i, dict) else i for i in items]


def _instants(values: list[str]) -> set[datetime]:
    return {datetime.fromisoformat(v) for v in values}


@pytest.mark.parametrize("doctor", ["otieno", "kamau"])
@pytest.mark.parametrize("day", ["2026-10-26", "2026-10-28"])
async def test_taken_is_exactly_the_booked_starts_of_that_doctors_day(
    client: httpx.AsyncClient, reset_appointments: None, doctor: str, day: str
) -> None:
    did = seeded_doctor_id(doctor)
    full = (await client.get(f"/doctors/{did}/availability?date={day}")).json()
    assert full["taken"] == [], "nothing is booked yet"
    offered = _starts(full, "slots")
    chosen = [offered[1], offered[4], offered[7]]
    patients = [seeded_patient_id(k) for k in ("amina", "brian", "wanjiru")]
    for starts_at, patient in zip(chosen, patients, strict=True):
        resp = await client.post(
            "/appointments",
            json={"doctor_id": str(did), "patient_id": str(patient), "starts_at": starts_at},
        )
        assert resp.status_code == 201, resp.text
    after = (await client.get(f"/doctors/{did}/availability?date={day}")).json()
    assert _instants(_starts(after, "taken")) == _instants(chosen)
    assert not _instants(_starts(after, "slots")) & _instants(chosen)
    assert len(_starts(after, "slots")) == len(offered) - 3
    assert _starts(after, "taken") == sorted(_starts(after, "taken"))
    assert all(t.endswith("+03:00") for t in _starts(after, "taken")), "clinic offset, like slots"


async def test_another_doctors_or_days_bookings_are_not_listed(
    client: httpx.AsyncClient, reset_appointments: None
) -> None:
    otieno, kamau = seeded_doctor_id("otieno"), seeded_doctor_id("kamau")
    slot = (await client.get(f"/doctors/{otieno}/availability?date=2026-10-26")).json()["slots"][0]
    await client.post(
        "/appointments",
        json={
            "doctor_id": str(otieno),
            "patient_id": str(seeded_patient_id("amina")),
            "starts_at": slot["starts_at"],
        },
    )
    assert (await client.get(f"/doctors/{kamau}/availability?date=2026-10-26")).json()[
        "taken"
    ] == []
    other_day = await client.get(f"/doctors/{otieno}/availability?date=2026-10-27")
    assert other_day.json()["taken"] == []


async def test_book_cancel_and_reschedule_move_a_time_between_slots_and_taken(
    client: httpx.AsyncClient, reset_appointments: None
) -> None:
    did = seeded_doctor_id("otieno")
    url = f"/doctors/{did}/availability?date=2026-10-26"
    free = _starts((await client.get(url)).json(), "slots")
    first, second = free[2], free[5]

    booked = await client.post(
        "/appointments",
        json={
            "doctor_id": str(did),
            "patient_id": str(seeded_patient_id("amina")),
            "starts_at": first,
        },
    )
    appt = booked.json()["id"]
    now = (await client.get(url)).json()
    assert _instants(_starts(now, "taken")) == _instants([first])
    assert _instants([first]).isdisjoint(_instants(_starts(now, "slots")))

    await client.patch(f"/appointments/{appt}/reschedule", json={"starts_at": second})
    moved = (await client.get(url)).json()
    assert _instants(_starts(moved, "taken")) == _instants([second]), "the old time was freed"
    assert _instants([first]) <= _instants(_starts(moved, "slots"))
    assert _instants([second]).isdisjoint(_instants(_starts(moved, "slots")))

    await client.patch(f"/appointments/{appt}/cancel", json={"reason": "no longer needed"})
    back = (await client.get(url)).json()
    assert back["taken"] == []
    assert _instants(_starts(back, "slots")) == _instants(free)


async def test_the_etag_changes_with_every_book_reschedule_and_cancel_and_not_otherwise(
    client: httpx.AsyncClient, reset_appointments: None
) -> None:
    did = seeded_doctor_id("otieno")
    url = f"/doctors/{did}/availability?date=2026-10-26"
    tags = [(await client.get(url)).headers["etag"]]
    free = _starts((await client.get(url)).json(), "slots")
    appt = (
        await client.post(
            "/appointments",
            json={
                "doctor_id": str(did),
                "patient_id": str(seeded_patient_id("amina")),
                "starts_at": free[2],
            },
        )
    ).json()["id"]
    tags.append((await client.get(url)).headers["etag"])
    await client.patch(f"/appointments/{appt}/reschedule", json={"starts_at": free[5]})
    tags.append((await client.get(url)).headers["etag"])
    await client.patch(f"/appointments/{appt}/cancel", json={"reason": "no longer needed"})
    tags.append((await client.get(url)).headers["etag"])
    assert tags[0] == tags[3], "cancelled: the same grid as at the start"
    assert len({tags[0], tags[1], tags[2]}) == 3, "each change is a different tag"
    # An unchanged poll is a 304.
    again = await client.get(url, headers={"If-None-Match": tags[3]})
    assert again.status_code == 304


async def test_the_etag_covers_taken_not_just_the_free_slots(
    client: httpx.AsyncClient, reset_appointments: None, owner_conn: asyncpg.Connection
) -> None:
    # A past Monday: every grid time is before the fixed clock, so the free list is empty and a
    # booking there changes only `taken`. The tag must still change.
    did = seeded_doctor_id("otieno")
    url = f"/doctors/{did}/availability?date=2026-10-12"
    before = await client.get(url)
    assert before.json()["slots"] == [] and before.json()["taken"] == []
    await owner_conn.execute(
        "INSERT INTO appointments (doctor_id, patient_id, starts_at, ends_at) "
        "VALUES ($1, $2, '2026-10-12T06:00:00Z', '2026-10-12T06:30:00Z')",
        did,
        seeded_patient_id("amina"),
    )
    after = await client.get(url)
    assert after.json()["slots"] == []
    assert _instants(_starts(after.json(), "taken")) == {datetime(2026, 10, 12, 6, 0, tzinfo=UTC)}
    assert after.headers["etag"] != before.headers["etag"]
    assert (
        await client.get(url, headers={"If-None-Match": before.headers["etag"]})
    ).status_code == 200
    assert (
        await client.get(url, headers={"If-None-Match": after.headers["etag"]})
    ).status_code == 304


async def test_the_response_has_no_personal_or_appointment_fields(
    client: httpx.AsyncClient, reset_appointments: None
) -> None:
    did = seeded_doctor_id("otieno")
    url = f"/doctors/{did}/availability?date=2026-10-26"
    slot = (await client.get(url)).json()["slots"][0]["starts_at"]
    await client.post(
        "/appointments",
        json={
            "doctor_id": str(did),
            "patient_id": str(seeded_patient_id("amina")),
            "starts_at": slot,
        },
    )
    body = (await client.get(url)).json()
    assert set(body) == {
        "doctor_id",
        "date",
        "timezone",
        "slot_minutes",
        "cursor",
        "slots",
        "taken",
    }
    assert all(isinstance(t, str) for t in body["taken"]), "start times only"
    raw = json.dumps(body).lower()
    for word in ("appointment", "patient", "amina", "reason", "phone", "email", "count"):
        assert word not in raw, word
    spec = (await client.get("/openapi.json")).json()["components"]["schemas"]["Availability"]
    taken = spec["properties"]["taken"]
    assert taken["items"] == {"type": "string", "format": "date-time"}
    assert "taken" in spec["required"]
