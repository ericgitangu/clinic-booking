"""Upgrading a database that already has events: the relay must not replay that history."""

from __future__ import annotations

import asyncio
import os
import pathlib
import subprocess
import uuid
from datetime import UTC, datetime

import asyncpg
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.clock import FakeClock
from app.services.publish_budget import PublishBudget
from app.services.relay import relay_once
from tests.conftest import app_sqlalchemy_url, owner_dsn, owner_sqlalchemy_url
from tests.integration.realtime_support import RecordingPublisher

BACKEND_DIR = pathlib.Path(__file__).resolve().parents[2]
TMP_DB = "clinic_relay_seed"
HISTORY = 250
FAR = datetime(2099, 1, 1, tzinfo=UTC)  # every event is "fresh" for this clock


def _dsn(dbname: str) -> str:
    return owner_dsn(dbname)


def _alembic(*args: str) -> None:
    env = {**os.environ, "DATABASE_URL": owner_sqlalchemy_url(TMP_DB)}
    result = subprocess.run(
        ["uv", "run", "alembic", *args],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, f"alembic {args} failed:\n{result.stdout}\n{result.stderr}"


async def _recreate() -> None:
    conn = await asyncpg.connect(owner_dsn())
    try:
        await conn.execute(f'DROP DATABASE IF EXISTS "{TMP_DB}" WITH (FORCE)')
        await conn.execute(f'CREATE DATABASE "{TMP_DB}"')
    finally:
        await conn.close()


async def _drop() -> None:
    conn = await asyncpg.connect(owner_dsn())
    try:
        await conn.execute(f'DROP DATABASE IF EXISTS "{TMP_DB}" WITH (FORCE)')
    finally:
        await conn.close()


async def _history_at_0005() -> uuid.UUID:
    """Real clinic, doctor, patient, appointment and 250 booked events, written before 0006."""
    conn = await asyncpg.connect(_dsn(TMP_DB))
    try:
        clinic, doctor, patient = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        await conn.execute(
            "INSERT INTO clinics (id, name, timezone) VALUES ($1, 'Seed clinic', 'Africa/Nairobi')",
            clinic,
        )
        await conn.execute(
            "INSERT INTO doctors (id, clinic_id, full_name, specialty) "
            "VALUES ($1, $2, 'Dr Seed', 'General practice')",
            doctor,
            clinic,
        )
        await conn.execute(
            "INSERT INTO patients (id, full_name) VALUES ($1, 'Seed Patient')", patient
        )
        appt = await conn.fetchval(
            "INSERT INTO appointments (doctor_id, patient_id, starts_at, ends_at) "
            "VALUES ($1, $2, $3::timestamptz, $3::timestamptz + interval '30 minutes') "
            "RETURNING id",
            doctor,
            patient,
            datetime(2026, 10, 28, 6, 0, tzinfo=UTC),
        )
        await conn.execute(
            "INSERT INTO appointment_events "
            "(appointment_id, doctor_id, event_type, to_starts_at, local_date) "
            "SELECT $1, $2, 'booked', $3, '2026-10-28' FROM generate_series(1, $4::int)",
            appt,
            doctor,
            datetime(2026, 10, 28, 6, 0, tzinfo=UTC),
            HISTORY,
        )
        return doctor
    finally:
        await conn.close()


async def _first_trigger_after_upgrade(doctor: uuid.UUID) -> tuple[int, int]:
    """One new event after the upgrade, one relay run: (messages published, batches)."""
    conn = await asyncpg.connect(_dsn(TMP_DB))
    try:
        appt = await conn.fetchval("SELECT id FROM appointments")
        await conn.execute(
            "INSERT INTO appointment_events "
            "(appointment_id, doctor_id, event_type, from_starts_at, local_date) "
            "VALUES ($1, $2, 'cancelled', $3, '2026-10-28')",
            appt,
            doctor,
            datetime(2026, 10, 28, 6, 0, tzinfo=UTC),
        )
    finally:
        await conn.close()
    engine = create_async_engine(app_sqlalchemy_url(TMP_DB))
    try:
        sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
        publisher = RecordingPublisher()
        budget = PublishBudget(sessionmaker, 25_000)
        first = await relay_once(
            sessionmaker,
            publisher,
            budget,
            FakeClock(FAR),
            max_age=FAR - datetime(2000, 1, 1, tzinfo=UTC),
        )
        names = [m.name for m in publisher.messages]
        assert names == ["slot_freed", "cancelled"], names
        return first.published, len(publisher.batches)
    finally:
        await engine.dispose()


def test_the_first_relay_run_after_an_upgrade_publishes_only_the_new_event() -> None:
    asyncio.run(_recreate())
    try:
        _alembic("upgrade", "0005")
        doctor = asyncio.run(_history_at_0005())
        _alembic("upgrade", "0006")
        published, batches = asyncio.run(_first_trigger_after_upgrade(doctor))
        # One cancel event: a slot message and an admin message, in a single batch, on the first
        # trigger: none of the 250 older events came first.
        assert (published, batches) == (2, 1)
    finally:
        asyncio.run(_drop())
