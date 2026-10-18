"""clinic_app is SELECT/INSERT/UPDATE only: no DDL, and it can write a patient row."""

from __future__ import annotations

import asyncpg
import pytest

pytestmark = pytest.mark.asyncio


async def test_app_role_cannot_create_table(app_conn: asyncpg.Connection) -> None:
    with pytest.raises(asyncpg.InsufficientPrivilegeError) as exc:
        await app_conn.execute("CREATE TABLE x(i int)")
    assert exc.value.sqlstate == "42501"


async def test_app_role_can_insert_patient(app_conn: asyncpg.Connection) -> None:
    tx = app_conn.transaction()
    await tx.start()
    try:
        row_id = await app_conn.fetchval(
            "INSERT INTO patients (full_name) VALUES ('Role Test Patient') RETURNING id"
        )
        assert row_id is not None
    finally:
        await tx.rollback()


async def test_app_role_cannot_rewrite_migration_head(owner_conn: asyncpg.Connection) -> None:
    async def can(privilege: str) -> bool:
        return bool(
            await owner_conn.fetchval(
                "SELECT has_table_privilege('clinic_app', 'public.alembic_version', $1)", privilege
            )
        )

    assert not await can("UPDATE")
    assert not await can("INSERT")
    assert not await can("DELETE")
    assert await can("SELECT")


async def _privileges(owner_conn: asyncpg.Connection, table: str) -> dict[str, bool]:
    return {
        p: bool(
            await owner_conn.fetchval(
                "SELECT has_table_privilege('clinic_app', $1, $2)", f"public.{table}", p
            )
        )
        for p in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE")
    }


async def test_staff_access_is_never_deletable_by_the_app(
    owner_conn: asyncpg.Connection,
) -> None:
    assert await _privileges(owner_conn, "staff_access") == {
        "SELECT": True,
        "INSERT": True,
        "UPDATE": True,
        "DELETE": False,
        "TRUNCATE": False,
    }


async def test_staff_audit_is_append_only_for_the_app(owner_conn: asyncpg.Connection) -> None:
    assert await _privileges(owner_conn, "staff_access_audit") == {
        "SELECT": True,
        "INSERT": True,
        "UPDATE": False,
        "DELETE": False,
        "TRUNCATE": False,
    }


async def test_app_role_cannot_rewrite_or_erase_an_audit_row(
    app_conn: asyncpg.Connection,
) -> None:
    tx = app_conn.transaction()
    await tx.start()
    try:
        await app_conn.execute(
            "INSERT INTO staff_access_audit (actor_email, action, target_email) "
            "VALUES ('a@x.io', 'grant', 'b@x.io')"
        )
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await app_conn.execute("UPDATE staff_access_audit SET actor_email = 'z@x.io'")
    finally:
        await tx.rollback()
    tx = app_conn.transaction()
    await tx.start()
    try:
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await app_conn.execute("DELETE FROM staff_access_audit")
    finally:
        await tx.rollback()


async def test_realtime_tables_keep_the_app_role_least_privileged(
    owner_conn: asyncpg.Connection,
) -> None:
    none = {"DELETE": False, "TRUNCATE": False}
    cursor = await _privileges(owner_conn, "event_relay_cursor")
    assert cursor == {"SELECT": True, "INSERT": False, "UPDATE": True, **none}
    for table in ("realtime_publish_budget", "realtime_token_cap"):
        assert await _privileges(owner_conn, table) == {
            "SELECT": True,
            "INSERT": True,
            "UPDATE": True,
            **none,
        }


async def test_the_event_log_is_append_only_for_the_app_role(
    owner_conn: asyncpg.Connection,
) -> None:
    # Its (txid, id) is the ordering the relay trusts: the runtime role may add and read, no more.
    assert await _privileges(owner_conn, "appointment_events") == {
        "SELECT": True,
        "INSERT": True,
        "UPDATE": False,
        "DELETE": False,
        "TRUNCATE": False,
    }


async def test_the_app_role_cannot_rewrite_an_events_ordering_column(
    app_conn: asyncpg.Connection,
) -> None:
    tx = app_conn.transaction()
    await tx.start()
    try:
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await app_conn.execute("UPDATE appointment_events SET txid = pg_current_xact_id()")
    finally:
        await tx.rollback()
