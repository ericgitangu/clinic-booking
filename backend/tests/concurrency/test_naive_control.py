"""Naive control (§3.4): in a DB with the doctor-slot index dropped, a check-then-insert
booking service double-books under the same harness. This proves the index is what saves us.
"""

from __future__ import annotations

import asyncio
import os
import pathlib
import subprocess
import uuid
from datetime import UTC, datetime

import asyncpg
import pytest

from tests.conftest import owner_dsn, owner_sqlalchemy_url

pytestmark = [pytest.mark.asyncio, pytest.mark.control]

BACKEND_DIR = pathlib.Path(__file__).resolve().parents[2]
CONTROL_DB = "clinic_control"
N = 10
# 09:00 EAT == 06:00Z; epoch divisible by 1800, satisfies ck_appt_alignment/duration.
SLOT = datetime(2026, 10, 26, 6, 0, tzinfo=UTC)


async def _admin_exec(sql: str) -> None:
    conn = await asyncpg.connect(owner_dsn())
    try:
        await conn.execute(sql)
    finally:
        await conn.close()


async def _setup_control_db() -> tuple[uuid.UUID, list[uuid.UUID]]:
    await _admin_exec(f'DROP DATABASE IF EXISTS "{CONTROL_DB}" WITH (FORCE)')
    await _admin_exec(f'CREATE DATABASE "{CONTROL_DB}"')

    env = {**os.environ, "DATABASE_URL": owner_sqlalchemy_url(CONTROL_DB)}
    result = subprocess.run(
        ["uv", "run", "alembic", "upgrade", "head"],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr

    conn = await asyncpg.connect(owner_dsn(CONTROL_DB))
    try:
        # Drop the guarantee under test; keep the patient-slot index (distinct patients here).
        await conn.execute("DROP INDEX uq_appt_doctor_slot_booked")
        clinic_id = uuid.uuid4()
        doctor_id = uuid.uuid4()
        await conn.execute(
            "INSERT INTO clinics (id, name, timezone) "
            "VALUES ($1, 'Control Clinic', 'Africa/Nairobi')",
            clinic_id,
        )
        await conn.execute(
            "INSERT INTO doctors (id, clinic_id, full_name, specialty) "
            "VALUES ($1, $2, 'Control Doctor', 'General')",
            doctor_id,
            clinic_id,
        )
        patient_ids = [uuid.uuid4() for _ in range(N)]
        for i, pid in enumerate(patient_ids):
            await conn.execute(
                "INSERT INTO patients (id, full_name) VALUES ($1, $2)",
                pid,
                f"Control Patient {i:02d}",
            )
    finally:
        await conn.close()
    return doctor_id, patient_ids


async def _naive_book(doctor_id: uuid.UUID, patient_id: uuid.UUID) -> None:
    """Check-then-insert with a sleep in between: the classic double-booking bug."""
    conn = await asyncpg.connect(owner_dsn(CONTROL_DB))
    try:
        async with conn.transaction():
            booked = await conn.fetchval(
                "SELECT count(*) FROM appointments "
                "WHERE doctor_id = $1 AND starts_at = $2 AND status = 'booked'",
                doctor_id,
                SLOT,
            )
            if booked == 0:
                await conn.execute("SELECT pg_sleep(0.1)")
                await conn.execute(
                    "INSERT INTO appointments "
                    "(doctor_id, patient_id, starts_at, ends_at, status) "
                    "VALUES ($1, $2, $3::timestamptz, "
                    "$3::timestamptz + interval '30 minutes', 'booked')",
                    doctor_id,
                    patient_id,
                    SLOT,
                )
    finally:
        await conn.close()


async def test_naive_service_double_books_without_index() -> None:
    doctor_id, patient_ids = await _setup_control_db()
    try:
        barrier = asyncio.Barrier(N)

        async def one(pid: uuid.UUID) -> None:
            await barrier.wait()
            await _naive_book(doctor_id, pid)

        await asyncio.gather(*[one(pid) for pid in patient_ids])

        conn = await asyncpg.connect(owner_dsn(CONTROL_DB))
        try:
            booked = await conn.fetchval(
                "SELECT count(*) FROM appointments "
                "WHERE doctor_id = $1 AND starts_at = $2 AND status = 'booked'",
                doctor_id,
                SLOT,
            )
        finally:
            await conn.close()
        assert booked > 1, f"expected the naive service to double-book, got {booked}"
    finally:
        await _admin_exec(f'DROP DATABASE IF EXISTS "{CONTROL_DB}" WITH (FORCE)')
