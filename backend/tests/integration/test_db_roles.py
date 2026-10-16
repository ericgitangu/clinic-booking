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
