"""0012 marks the older smoke and release-check rows synthetic, once, and touches nothing else."""

from __future__ import annotations

import asyncio
import importlib.util
import os
import pathlib
import subprocess
import uuid

import asyncpg

from tests.conftest import owner_dsn, owner_sqlalchemy_url

BACKEND_DIR = pathlib.Path(__file__).resolve().parents[2]
TMP_DB = "clinic_demo_backfill"


def _alembic(*args: str) -> None:
    env = {**os.environ, "DATABASE_URL": owner_sqlalchemy_url(TMP_DB)}
    result = subprocess.run(
        ["uv", "run", "alembic", *args], cwd=BACKEND_DIR, env=env, capture_output=True, text=True
    )
    assert result.returncode == 0, f"alembic {args} failed:\n{result.stdout}\n{result.stderr}"


async def _admin(sql: str) -> None:
    conn = await asyncpg.connect(owner_dsn())
    try:
        await conn.execute(sql)
    finally:
        await conn.close()


def _backfill_sql() -> str:
    path = BACKEND_DIR / "migrations" / "versions" / "0012_demo_patients_and_backfill.py"
    spec = importlib.util.spec_from_file_location("m0012", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sql: str = module.BACKFILL_SYNTHETIC
    return sql


def _probe_sql() -> str:
    path = BACKEND_DIR / "migrations" / "versions" / "0012_demo_patients_and_backfill.py"
    spec = importlib.util.spec_from_file_location("m0012b", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sql: str = module.BACKFILL_AUDIT_PROBES
    return sql


PROBE_A = uuid.UUID("0850abfb-2261-4774-a4f0-edef28683612")
PROBE_B = uuid.UUID("9e5e4aa0-cdda-4a4b-ab70-ed07c8d420f3")


async def _check() -> None:
    conn = await asyncpg.connect(owner_dsn(TMP_DB))
    try:
        linked = uuid.uuid4()
        rows = {
            "verify-claims 20261018T100000 1": False,
            "verify-claims 20261018T100000 2": False,
            "Release Gate Check (test, cancelled)": False,
            "Real Person": False,
            "verify-claimsX no space": False,  # does not match 'verify-claims %'
            "Someone verify-claims 3": False,  # pattern is a prefix, not a substring
        }
        for name in rows:
            await conn.execute(
                "INSERT INTO patients (id, full_name) VALUES ($1, $2)", uuid.uuid4(), name
            )
        await conn.execute(
            "INSERT INTO patients (id, full_name) VALUES ($1, 'verify-claims 99 9')", linked
        )
        # The audit's patient (exact id and name), and two that must stay untouched: one of the ids
        # under another name, and the same name under another id.
        await conn.execute(
            "INSERT INTO patients (id, full_name) VALUES ($1, 'Brief Audit Probe')", PROBE_A
        )
        await conn.execute(
            "INSERT INTO patients (id, full_name) VALUES ($1, 'Brief Audit Probe (renamed)')",
            PROBE_B,
        )
        await conn.execute(
            "INSERT INTO patients (id, full_name) VALUES ($1, 'Brief Audit Probe')", uuid.uuid4()
        )
        await conn.execute(
            "INSERT INTO patient_accounts (google_sub, patient_id, email) "
            "VALUES ('sub-x', $1, 'x@example.test')",
            linked,
        )
        before = await conn.fetch("SELECT id, full_name, synthetic FROM patients ORDER BY id")
        assert not any(r["synthetic"] for r in before)
    finally:
        await conn.close()

    _alembic("upgrade", "0012")

    conn = await asyncpg.connect(owner_dsn(TMP_DB))
    try:
        got = {r["full_name"]: r["synthetic"] for r in await conn.fetch("SELECT * FROM patients")}
        assert got["verify-claims 20261018T100000 1"] is True
        assert got["verify-claims 20261018T100000 2"] is True
        assert got["Release Gate Check (test, cancelled)"] is True
        assert got["Real Person"] is False
        assert got["verify-claimsX no space"] is False
        assert got["Someone verify-claims 3"] is False
        assert got["verify-claims 99 9"] is False  # linked to a sign-in account: never touched
        assert not any(r["demo"] for r in await conn.fetch("SELECT demo FROM patients"))
        probes = {
            r["id"]: r["synthetic"]
            for r in await conn.fetch("SELECT id, full_name, synthetic FROM patients")
            if r["full_name"].startswith("Brief Audit Probe")
        }
        assert probes[PROBE_A] is True  # exact id and exact name
        assert probes[PROBE_B] is False  # renamed: not the audit's patient any more
        assert sorted(probes.values()) == [False, False, True]  # the same name under another id
        # Running the same statements again changes nothing.
        assert await conn.execute(_backfill_sql()) == "UPDATE 0"
        assert await conn.execute(_probe_sql()) == "UPDATE 0"
        # The second audit id flips too when it carries the exact name, and stops flipping when it
        # does not (a statement keyed on id alone would mark whatever sits under that id).
        await conn.execute(
            "UPDATE patients SET full_name = 'Brief Audit Probe', synthetic = false WHERE id = $1",
            PROBE_B,
        )
        assert await conn.execute(_probe_sql()) == "UPDATE 1"
        await conn.execute(
            "UPDATE patients SET full_name = 'Someone Else', synthetic = false WHERE id = $1",
            PROBE_B,
        )
        assert await conn.execute(_probe_sql()) == "UPDATE 0"
        # An account-linked patient under an audit id is left alone.
        await conn.execute(
            "UPDATE patients SET full_name = 'Brief Audit Probe', synthetic = false WHERE id = $1",
            PROBE_B,
        )
        await conn.execute(
            "INSERT INTO patient_accounts (google_sub, patient_id, email) "
            "VALUES ('sub-probe', $1, 'p@example.test')",
            PROBE_B,
        )
        assert await conn.execute(_probe_sql()) == "UPDATE 0"
    finally:
        await conn.close()


def test_the_backfill_marks_only_the_old_smoke_rows_and_is_idempotent() -> None:
    asyncio.run(_admin(f'DROP DATABASE IF EXISTS "{TMP_DB}" WITH (FORCE)'))
    asyncio.run(_admin(f'CREATE DATABASE "{TMP_DB}"'))
    try:
        _alembic("upgrade", "0008")
        asyncio.run(_check())
    finally:
        asyncio.run(_admin(f'DROP DATABASE IF EXISTS "{TMP_DB}" WITH (FORCE)'))
