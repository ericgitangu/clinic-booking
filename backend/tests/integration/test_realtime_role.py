"""The gateway's login (clinic_realtime) reads exactly what migration 0014 grants, nothing else.

Every denial is a real SQLSTATE 42501 from a real login, not a code check.
"""

from __future__ import annotations

import pathlib
import textwrap
from collections.abc import AsyncIterator

import asyncpg
import pytest
import pytest_asyncio

from tests.conftest import TEST_DB_HOST, TEST_DB_NAME, TEST_DB_PORT

pytestmark = pytest.mark.asyncio

REPO = pathlib.Path(__file__).resolve().parents[3]


@pytest_asyncio.fixture
async def rt_conn() -> AsyncIterator[asyncpg.Connection]:
    conn = await asyncpg.connect(
        user="clinic_realtime",
        password="clinic_realtime_local",
        host=TEST_DB_HOST,
        port=TEST_DB_PORT,
        database=TEST_DB_NAME,
    )
    try:
        yield conn
    finally:
        await conn.close()


async def test_granted_columns_are_readable(rt_conn: asyncpg.Connection) -> None:
    await rt_conn.fetch(
        "SELECT id, txid, appointment_id, doctor_id, event_type, from_starts_at, to_starts_at,"
        " local_date, from_local_date, occurred_at FROM appointment_events LIMIT 1"
    )
    await rt_conn.fetch(
        "SELECT id, patient_id, status, cancellation_reason FROM appointments LIMIT 1"
    )
    await rt_conn.fetch("SELECT id, full_name, synthetic FROM patients LIMIT 1")
    await rt_conn.fetch("SELECT email, role, revoked_at FROM staff_access LIMIT 1")
    horizon = await rt_conn.fetchval("SELECT pg_snapshot_xmin(pg_current_snapshot())::text")
    assert horizon is not None


DENIED = {
    "patient accounts": "SELECT * FROM patient_accounts",
    "appointment start time": "SELECT starts_at FROM appointments",
    "patient email": "SELECT email FROM patients",
    "patient phone": "SELECT phone FROM patients",
    "staff grantor": "SELECT granted_by FROM staff_access",
    "staff audit": "SELECT * FROM staff_access_audit",
    "relay cursor": "SELECT * FROM event_relay_cursor",
    "email counters": "SELECT * FROM email_counter",
    "alembic head": "SELECT * FROM alembic_version",
    "insert event": "INSERT INTO appointment_events (doctor_id) VALUES (gen_random_uuid())",
    "update event": "UPDATE appointment_events SET event_type = 'booked'",
    "update patient": "UPDATE patients SET full_name = 'x'",
    "update staff": "UPDATE staff_access SET revoked_at = now()",
    "delete event": "DELETE FROM appointment_events",
    "truncate event": "TRUNCATE appointment_events",
    "create table": "CREATE TABLE rt_probe (i int)",
    "create role": "CREATE ROLE rt_probe_role",
}


@pytest.mark.parametrize("name", list(DENIED))
async def test_everything_else_is_refused_with_42501(
    rt_conn: asyncpg.Connection, name: str
) -> None:
    with pytest.raises(asyncpg.InsufficientPrivilegeError) as exc:
        await rt_conn.execute(DENIED[name])
    assert exc.value.sqlstate == "42501"


async def test_role_attributes_and_session_timeout(owner_conn: asyncpg.Connection) -> None:
    row = await owner_conn.fetchrow(
        "SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolconfig FROM pg_roles"
        " WHERE rolname = 'clinic_realtime'"
    )
    assert row is not None
    assert not any(row[k] for k in ("rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication"))
    assert "idle_in_transaction_session_timeout=30s" in (row["rolconfig"] or [])


async def test_no_sequence_or_function_write_path(owner_conn: asyncpg.Connection) -> None:
    n = await owner_conn.fetchval(
        "SELECT count(*) FROM information_schema.role_table_grants"
        " WHERE grantee = 'clinic_realtime' AND privilege_type <> 'SELECT'"
    )
    assert n == 0
    assert not await owner_conn.fetchval(
        "SELECT has_sequence_privilege('clinic_realtime', 'appointment_events_id_seq', 'USAGE')"
    )


@pytest.mark.filterwarnings("ignore::pytest.PytestWarning")
def test_runbook_grants_equal_the_migration() -> None:
    """The runbook's re-apply script must say what the migration says."""
    migration = (REPO / "backend/migrations/versions/0014_realtime_reader_role.py").read_text()
    block = migration.split('GRANTS = """\n', 1)[1].split('"""', 1)[0]
    sql = (REPO / "scripts/ops/realtime_grants.sql").read_text()
    body = "\n".join(line for line in sql.splitlines() if not line.startswith("--"))
    assert textwrap.dedent(block).strip() == body.strip()
