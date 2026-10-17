"""the clinic's zone is data. Offsets in responses follow clinics.timezone."""

from __future__ import annotations

from collections.abc import AsyncIterator

import asyncpg
import httpx
import pytest
import pytest_asyncio

from tests.conftest import seeded_doctor_id, seeded_patient_id

pytestmark = pytest.mark.asyncio

OTIENO = seeded_doctor_id("otieno")
AMINA = seeded_patient_id("amina")


@pytest_asyncio.fixture
async def zone(owner_conn: asyncpg.Connection) -> AsyncIterator[str]:
    """Point the one seeded clinic at another zone for the test, then put it back."""
    original = await owner_conn.fetchval("SELECT timezone FROM clinics ORDER BY created_at LIMIT 1")
    try:
        yield "unset"
    finally:
        await owner_conn.execute("UPDATE clinics SET timezone = $1", original)


@pytest.mark.parametrize(
    ("name", "offset"),
    [
        ("America/New_York", "-04:00"),  # EDT until 2026-11-01
        ("Europe/Berlin", "+01:00"),  # CET since 2026-10-25
        ("Africa/Nairobi", "+03:00"),
        ("UTC", "Z"),  # pydantic writes a zero offset as Z
    ],
)
async def test_offsets_follow_the_clinic_row(
    client: httpx.AsyncClient,
    owner_conn: asyncpg.Connection,
    reset_appointments: None,
    zone: str,
    name: str,
    offset: str,
) -> None:
    await owner_conn.execute("UPDATE clinics SET timezone = $1", name)

    avail = await client.get(f"/doctors/{OTIENO}/availability?date=2026-10-26")
    assert avail.status_code == 200
    body = avail.json()
    assert body["timezone"] == name
    assert body["slots"], "the doctor's Monday hours exist in any zone"
    assert body["slots"][0]["starts_at"].endswith(offset)
    assert body["slots"][0]["ends_at"].endswith(offset)

    booked = await client.post(
        "/appointments",
        json={
            "doctor_id": str(OTIENO),
            "patient_id": str(AMINA),
            "starts_at": body["slots"][0]["starts_at"],
        },
    )
    assert booked.status_code == 201, booked.text
    for field in ("starts_at", "ends_at", "created_at", "updated_at"):
        value = booked.json()[field]
        # created_at is "now" in the database, which can sit in a different DST period only when
        # the zone has one; the fixed-instant fields must carry exactly the clinic's offset.
        if field in ("starts_at", "ends_at"):
            assert value.endswith(offset), (field, value)

    fetched = await client.get(f"/appointments/{booked.json()['id']}")
    assert fetched.json()["starts_at"].endswith(offset)

    doctor = await client.get(f"/doctors/{OTIENO}")
    assert doctor.json()["clinic"]["timezone"] == name


async def test_wall_clock_hours_follow_the_clinic_zone(
    client: httpx.AsyncClient, owner_conn: asyncpg.Connection, zone: str
) -> None:
    # Working hours are clinic-local wall times: 08:00 on Monday is 08:00 wherever the clinic is.
    await owner_conn.execute("UPDATE clinics SET timezone = 'America/New_York'")
    body = (await client.get(f"/doctors/{OTIENO}/availability?date=2026-10-26")).json()
    assert body["slots"][0]["starts_at"].startswith("2026-10-26T08:00:00")
