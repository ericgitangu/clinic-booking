"""Going back past 0010 must refuse while it would destroy audit or attendance rows."""

from __future__ import annotations

import asyncio
import os
import pathlib
import subprocess
import uuid

import asyncpg
import pytest

from tests.conftest import owner_dsn, owner_sqlalchemy_url

BACKEND_DIR = pathlib.Path(__file__).resolve().parents[2]
TMP_DB = "clinic_downgrade_refusal"


def alembic(*args: str) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "DATABASE_URL": owner_sqlalchemy_url(TMP_DB)}
    return subprocess.run(
        ["uv", "run", "alembic", *args],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


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


async def _scalar(sql: str) -> object:
    conn = await asyncpg.connect(owner_dsn(TMP_DB))
    try:
        return await conn.fetchval(sql)
    finally:
        await conn.close()


async def _exec(sql: str, *args: object) -> None:
    conn = await asyncpg.connect(owner_dsn(TMP_DB))
    try:
        await conn.execute(sql, *args)
    finally:
        await conn.close()


@pytest.fixture
def database() -> object:
    asyncio.run(_recreate())
    assert alembic("upgrade", "head").returncode == 0
    yield None
    asyncio.run(_drop())


def test_an_audit_row_from_0010_blocks_the_downgrade(database: object) -> None:
    asyncio.run(
        _exec(
            "INSERT INTO staff_action_audit (actor_email, actor_role, action, reason) "
            "VALUES ('a@clinic.example', 'admin', 'arrived', 'marked at the desk')"
        )
    )
    before = asyncio.run(_scalar("SELECT version_num FROM alembic_version"))
    result = alembic("downgrade", "0009")
    assert result.returncode != 0
    assert "refusing to downgrade 0010" in result.stderr + result.stdout
    assert asyncio.run(_scalar("SELECT count(*) FROM staff_action_audit")) == 1
    # Unchanged, whatever the head is (a later migration may sit above 0010).
    assert asyncio.run(_scalar("SELECT version_num FROM alembic_version")) == before


def test_an_attendance_row_blocks_the_downgrade(database: object) -> None:
    clinic, doctor, patient, appt = (uuid.uuid4() for _ in range(4))
    statements = [
        (
            "INSERT INTO clinics (id, name, timezone) VALUES ($1, 'Test Clinic', 'Africa/Nairobi')",
            (clinic,),
        ),
        (
            "INSERT INTO doctors (id, clinic_id, full_name, specialty) "
            "VALUES ($1, $2, 'Dr Test', 'GP')",
            (doctor, clinic),
        ),
        ("INSERT INTO patients (id, full_name) VALUES ($1, 'Test Patient')", (patient,)),
        (
            "INSERT INTO appointments (id, doctor_id, patient_id, starts_at, ends_at) "
            "VALUES ($1, $2, $3, '2030-01-07 06:00+00', '2030-01-07 06:30+00')",
            (appt, doctor, patient),
        ),
        (
            "INSERT INTO appointment_attendance (appointment_id, kind, marked_by) "
            "VALUES ($1, 'arrived', 'x@clinic.example')",
            (appt,),
        ),
    ]
    for sql, args in statements:
        asyncio.run(_exec(sql, *args))
    before = asyncio.run(_scalar("SELECT version_num FROM alembic_version"))
    result = alembic("downgrade", "0009")
    assert result.returncode != 0
    assert "refusing to downgrade 0010" in result.stderr + result.stdout
    assert asyncio.run(_scalar("SELECT count(*) FROM appointment_attendance")) == 1
    assert asyncio.run(_scalar("SELECT version_num FROM alembic_version")) == before


def test_an_empty_database_downgrades_cleanly(database: object) -> None:
    assert alembic("downgrade", "0009").returncode == 0
    assert alembic("upgrade", "head").returncode == 0


def test_an_audit_row_blocks_the_0009_downgrade(database: object) -> None:
    asyncio.run(
        _exec(
            "INSERT INTO staff_action_audit (actor_email, actor_role, action, reason) "
            "VALUES ('a@clinic.example', 'admin', 'invite_create', 'Invited as viewer')"
        )
    )
    assert alembic("downgrade", "0009").returncode == 0  # nothing above 0009 holds data here
    before = asyncio.run(_scalar("SELECT version_num FROM alembic_version"))
    result = alembic("downgrade", "0008")
    assert result.returncode != 0
    assert "refusing to downgrade 0009" in result.stderr + result.stdout
    assert asyncio.run(_scalar("SELECT count(*) FROM staff_action_audit")) == 1
    assert asyncio.run(_scalar("SELECT version_num FROM alembic_version")) == before == "0009"


def test_an_invitation_row_blocks_the_0009_downgrade(database: object) -> None:
    asyncio.run(
        _exec(
            "INSERT INTO staff_invites "
            "(email, role, token_hash, invited_by, created_at, expires_at) "
            "VALUES ('x@clinic.example', 'viewer', repeat('a', 64), 'o@clinic.example', "
            "now(), now() + interval '72 hours')"
        )
    )
    assert alembic("downgrade", "0009").returncode == 0
    result = alembic("downgrade", "0008")
    assert result.returncode != 0
    assert asyncio.run(_scalar("SELECT count(*) FROM staff_invites")) == 1


def test_an_empty_database_downgrades_to_the_base(database: object) -> None:
    assert alembic("downgrade", "base").returncode == 0
    assert alembic("upgrade", "head").returncode == 0
