"""The clinic's zone is data: every appointment and availability response is rendered in the
offset of its own doctor's clinic, and that offset always agrees with the ``timezone`` field."""

from __future__ import annotations

import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

import httpx
import pytest

from app.api.deps import get_clock
from app.core.clock import FakeClock
from app.main import create_app
from tests.conftest import FIXED_NOW, make_settings, seeded_doctor_id, seeded_patient_id
from tests.integration.test_access import KEY, OWNER, _headers

pytestmark = pytest.mark.asyncio

NAIROBI_DOCTOR = seeded_doctor_id("otieno")
AMINA = seeded_patient_id("amina")
DAY = "2026-10-26"  # a Monday; New York is on EDT until 2026-11-01, Berlin on CET since 10-25


ZONES = [
    ("America/New_York", "-04:00"),
    ("Europe/Berlin", "+01:00"),
    ("Asia/Kolkata", "+05:30"),
]


@pytest.mark.parametrize(("zone", "offset"), ZONES)
async def test_each_doctor_is_rendered_in_their_own_clinics_zone(
    client: httpx.AsyncClient,
    reset_appointments: None,
    other_clinic: uuid.UUID,
    zone: str,
    offset: str,
) -> None:

    # Availability: the second clinic's doctor in its own zone, the seeded doctor in Nairobi's,
    # whichever clinic was created first.
    mine = (await client.get(f"/doctors/{other_clinic}/availability?date={DAY}")).json()
    assert mine["timezone"] == zone
    assert mine["slots"][0]["starts_at"].startswith(f"{DAY}T08:00:00{offset}")
    assert mine["slots"][0]["ends_at"].startswith(f"{DAY}T08:30:00{offset}")
    theirs = (await client.get(f"/doctors/{NAIROBI_DOCTOR}/availability?date={DAY}")).json()
    assert theirs["timezone"] == "Africa/Nairobi"
    assert theirs["slots"][0]["starts_at"].endswith("+03:00")

    # Every appointment endpoint renders with the doctor's own zone and names it.
    booked = await client.post(
        "/appointments",
        json={
            "doctor_id": str(other_clinic),
            "patient_id": str(AMINA),
            "starts_at": mine["slots"][0]["starts_at"],
        },
    )
    assert booked.status_code == 201, booked.text
    appt = booked.json()
    assert appt["timezone"] == zone
    assert appt["starts_at"].endswith(offset) and appt["ends_at"].endswith(offset)

    fetched = (await client.get(f"/appointments/{appt['id']}")).json()
    assert fetched["timezone"] == zone and fetched["starts_at"].endswith(offset)

    moved = await client.patch(
        f"/appointments/{appt['id']}/reschedule",
        json={"starts_at": mine["slots"][1]["starts_at"]},
    )
    assert moved.json()["timezone"] == zone and moved.json()["starts_at"].endswith(offset)

    # One patient with bookings in both clinics: each item in its own zone, same listing.
    nairobi_slot = theirs["slots"][0]["starts_at"]
    other = await client.post(
        "/appointments",
        json={
            "doctor_id": str(NAIROBI_DOCTOR),
            "patient_id": str(AMINA),
            "starts_at": nairobi_slot,
        },
    )
    assert other.status_code == 201, other.text
    listing = (await client.get(f"/patients/{AMINA}/appointments")).json()["items"]
    by_doctor = {i["doctor_id"]: i for i in listing}
    assert by_doctor[str(other_clinic)]["timezone"] == zone
    assert by_doctor[str(other_clinic)]["starts_at"].endswith(offset)
    assert by_doctor[str(NAIROBI_DOCTOR)]["timezone"] == "Africa/Nairobi"
    assert by_doctor[str(NAIROBI_DOCTOR)]["starts_at"].endswith("+03:00")

    cancelled = await client.patch(
        f"/appointments/{appt['id']}/cancel", json={"reason": "zone check complete"}
    )
    assert cancelled.json()["timezone"] == zone
    assert cancelled.json()["cancelled_at"] is not None


@pytest.mark.parametrize("zone", ["Europe/Berlin"])
async def test_a_replayed_booking_keeps_the_doctors_zone(
    client: httpx.AsyncClient, reset_appointments: None, other_clinic: uuid.UUID, zone: str
) -> None:
    slot = (await client.get(f"/doctors/{other_clinic}/availability?date={DAY}")).json()["slots"][0]
    body = {
        "doctor_id": str(other_clinic),
        "patient_id": str(AMINA),
        "starts_at": slot["starts_at"],
    }
    first = await client.post("/appointments", json=body, headers={"Idempotency-Key": "tz-replay"})
    again = await client.post("/appointments", json=body, headers={"Idempotency-Key": "tz-replay"})
    assert again.status_code == 201 and again.json() == first.json()
    assert again.json()["timezone"] == zone
    assert again.json()["starts_at"].endswith("+01:00")


async def test_the_seeded_clinic_renders_in_nairobi(
    client: httpx.AsyncClient, reset_appointments: None
) -> None:
    slot = (await client.get(f"/doctors/{NAIROBI_DOCTOR}/availability?date={DAY}")).json()["slots"][
        0
    ]
    booked = await client.post(
        "/appointments",
        json={
            "doctor_id": str(NAIROBI_DOCTOR),
            "patient_id": str(AMINA),
            "starts_at": slot["starts_at"],
        },
    )
    assert booked.json()["timezone"] == "Africa/Nairobi"
    assert booked.json()["starts_at"].endswith("+03:00")


# --- admin lineage: events are rendered in the zone of the appointment's doctor's clinic --------


async def _lineage(public: httpx.AsyncClient, appointment_id: str) -> list[dict[str, str]]:
    settings = make_settings(INTERNAL_SIGNING_KEY=KEY, ADMIN_EMAILS=OWNER)
    app = create_app(settings)
    app.dependency_overrides[get_clock] = lambda: FakeClock(FIXED_NOW)
    path = f"/internal/admin/appointments/{appointment_id}/lineage"
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as admin:
        resp = await admin.get(path, headers=_headers("GET", path, email=OWNER, role="owner"))
    assert resp.status_code == 200, resp.text
    events: list[dict[str, str]] = resp.json()["events"]
    return events


@pytest.mark.parametrize(("zone", "offset"), ZONES)
async def test_lineage_events_render_in_the_doctors_clinic_zone(
    client: httpx.AsyncClient,
    reset_appointments: None,
    other_clinic: uuid.UUID,
    zone: str,
    offset: str,
) -> None:
    slots = (await client.get(f"/doctors/{other_clinic}/availability?date={DAY}")).json()["slots"]
    booked = await client.post(
        "/appointments",
        json={
            "doctor_id": str(other_clinic),
            "patient_id": str(AMINA),
            "starts_at": slots[0]["starts_at"],
        },
    )
    appt = booked.json()["id"]
    await client.patch(
        f"/appointments/{appt}/reschedule", json={"starts_at": slots[1]["starts_at"]}
    )
    await client.patch(f"/appointments/{appt}/cancel", json={"reason": "lineage zone check"})

    events = await _lineage(client, appt)
    assert [e["event_type"] for e in events] == ["booked", "rescheduled", "cancelled"]
    for e in events:
        # occurred_at is the real "now" of the database, so its offset is the zone's offset at
        # that instant (which can differ from the October-26 offset around a DST change).
        happened = datetime.fromisoformat(e["occurred_at"])
        assert happened.utcoffset() == happened.astimezone(ZoneInfo(zone)).utcoffset(), e
    # The instants of the slots, in the clinic's wall time and offset.
    assert events[0]["to_starts_at"].startswith(f"{DAY}T08:00:00{offset}")
    assert events[1]["from_starts_at"].startswith(f"{DAY}T08:00:00{offset}")
    assert events[1]["to_starts_at"].startswith(f"{DAY}T08:30:00{offset}")
    assert events[2]["from_starts_at"].startswith(f"{DAY}T08:30:00{offset}")
    assert events[0]["from_starts_at"] is None and events[2]["to_starts_at"] is None


async def test_lineage_of_a_nairobi_appointment_stays_at_plus_three(
    client: httpx.AsyncClient, reset_appointments: None
) -> None:
    slots = (await client.get(f"/doctors/{NAIROBI_DOCTOR}/availability?date={DAY}")).json()["slots"]
    booked = await client.post(
        "/appointments",
        json={
            "doctor_id": str(NAIROBI_DOCTOR),
            "patient_id": str(AMINA),
            "starts_at": slots[0]["starts_at"],
        },
    )
    events = await _lineage(client, booked.json()["id"])
    assert events[0]["to_starts_at"].startswith(f"{DAY}T08:00:00+03:00")
    assert events[0]["occurred_at"].endswith("+03:00")
