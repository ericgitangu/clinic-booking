"""0016 marks the smoke patients 0012 missed and the 2026-10-17 gate check, and nothing else."""

from __future__ import annotations

import asyncio
import importlib.util
import os
import pathlib
import subprocess
import uuid
from datetime import UTC, datetime

import asyncpg

from tests.conftest import owner_dsn, owner_sqlalchemy_url

BACKEND_DIR = pathlib.Path(__file__).resolve().parents[2]
TMP_DB = "clinic_leaked_smoke"
ON_DAY = datetime(2026, 10, 17, 9, 0, tzinfo=UTC)  # 12:00 in Africa/Nairobi
OTHER_DAY = datetime(2026, 10, 18, 9, 0, tzinfo=UTC)

# The read-only counts the release owner runs on production before and after (same predicates).
COUNT_SQL = """
    SELECT count(*) FROM patients p
    WHERE NOT p.synthetic
      AND (p.full_name LIKE 'verify-claims %' OR p.full_name = 'Gate Reviewer')
"""


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


def _statements() -> tuple[str, str]:
    path = BACKEND_DIR / "migrations" / "versions" / "0016_mark_leaked_smoke_patients.py"
    spec = importlib.util.spec_from_file_location("m0016", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.MARK_SMOKE_PATIENTS, module.MARK_GATE_REVIEWER


async def _insert(
    conn: asyncpg.Connection, name: str, email: str | None = None, at: datetime = ON_DAY
) -> uuid.UUID:
    pid = uuid.uuid4()
    await conn.execute(
        "INSERT INTO patients (id, full_name, email, created_at) VALUES ($1, $2, $3, $4)",
        pid,
        name,
        email,
        at,
    )
    return pid


async def _check() -> None:
    conn = await asyncpg.connect(owner_dsn(TMP_DB))
    try:
        expect = {
            await _insert(conn, "verify-claims 20261020T041539 1", at=OTHER_DAY): True,
            await _insert(conn, "verify-claims 20261020T041715 2", at=OTHER_DAY): True,
            await _insert(conn, "Gate Reviewer", "gate1760700000@example.com"): True,
            # Must stay untouched:
            await _insert(conn, "Gate Reviewer", "gate1760700000@example.com", OTHER_DAY): False,
            await _insert(conn, "Gate Reviewer", "real.person@example.com"): False,
            await _insert(conn, "Gate Reviewer Two", "gate1760700001@example.com"): False,
            await _insert(conn, "Gate Reviewer", None): False,
            await _insert(conn, "Someone verify-claims 3"): False,
            await _insert(conn, "verify-claimsX no space"): False,
            await _insert(conn, "Real Person"): False,
        }
        linked = await _insert(conn, "verify-claims 99 9")
        linked_gate = await _insert(conn, "Gate Reviewer", "gate1760700002@example.com")
        for n, pid in enumerate((linked, linked_gate)):
            await conn.execute(
                "INSERT INTO patient_accounts (google_sub, patient_id, email) VALUES ($1, $2, $3)",
                f"sub-{n}",
                pid,
                f"x{n}@example.test",
            )
        expect[linked] = False
        expect[linked_gate] = False
        assert await conn.fetchval(COUNT_SQL) == 8  # before: every matching, unmarked row
        before_total = await conn.fetchval("SELECT count(*) FROM patients")
    finally:
        await conn.close()

    _alembic("upgrade", "0016")

    conn = await asyncpg.connect(owner_dsn(TMP_DB))
    try:
        got = {
            r["id"]: r["synthetic"] for r in await conn.fetch("SELECT id, synthetic FROM patients")
        }
        for pid, flagged in expect.items():
            assert got[pid] is flagged, pid
        # After: the three targets are gone from the count; the account-linked pair and the three
        # near-misses (other day, other address, no address) remain, unmarked.
        assert await conn.fetchval(COUNT_SQL) == 5
        assert await conn.fetchval("SELECT count(*) FROM patients") == before_total  # no deletes
        smoke_sql, gate_sql = _statements()
        assert await conn.execute(smoke_sql) == "UPDATE 0"  # a second run changes nothing
        assert await conn.execute(gate_sql) == "UPDATE 0"
    finally:
        await conn.close()


def test_the_backfill_marks_only_the_leaked_smoke_rows_and_is_idempotent() -> None:
    asyncio.run(_admin(f'DROP DATABASE IF EXISTS "{TMP_DB}" WITH (FORCE)'))
    asyncio.run(_admin(f'CREATE DATABASE "{TMP_DB}"'))
    try:
        _alembic("upgrade", "0015")
        asyncio.run(_check())
    finally:
        asyncio.run(_admin(f'DROP DATABASE IF EXISTS "{TMP_DB}" WITH (FORCE)'))
