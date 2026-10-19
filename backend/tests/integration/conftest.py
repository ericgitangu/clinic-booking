"""Fixtures shared by the integration tests."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator

import asyncpg
import pytest_asyncio

from tests.integration.staff_support import env  # noqa: F401  # shared fixture


@pytest_asyncio.fixture
async def other_clinic(zone: str, owner_conn: asyncpg.Connection) -> AsyncIterator[uuid.UUID]:
    """A second clinic, in the ``zone`` parameter, with one doctor working Monday 08:00-12:00."""
    clinic_id, doctor_id = uuid.uuid4(), uuid.uuid4()
    await owner_conn.execute(
        "INSERT INTO clinics (id, name, timezone) VALUES ($1, $2, $3)",
        clinic_id,
        f"Second clinic ({zone})",
        zone,
    )
    await owner_conn.execute(
        "INSERT INTO doctors (id, clinic_id, full_name, specialty) VALUES ($1, $2, $3, $4)",
        doctor_id,
        clinic_id,
        "Dr Elsewhere",
        "General practice",
    )
    await owner_conn.execute(
        "INSERT INTO working_hours (doctor_id, weekday, start_time, end_time) "
        "VALUES ($1, 1, '08:00', '12:00')",
        doctor_id,
    )
    try:
        yield doctor_id
    finally:
        await owner_conn.execute("DELETE FROM appointment_events")
        await owner_conn.execute("DELETE FROM appointments WHERE doctor_id = $1", doctor_id)
        await owner_conn.execute("DELETE FROM working_hours WHERE doctor_id = $1", doctor_id)
        await owner_conn.execute("DELETE FROM doctors WHERE id = $1", doctor_id)
        await owner_conn.execute("DELETE FROM clinics WHERE id = $1", clinic_id)
