"""The partial unique indexes and key constraints are part of the contract (§5)."""

from __future__ import annotations

import asyncpg
import pytest

pytestmark = pytest.mark.asyncio


async def _indexdef(conn: asyncpg.Connection, name: str) -> str | None:
    return await conn.fetchval("SELECT indexdef FROM pg_indexes WHERE indexname = $1", name)


async def test_doctor_slot_partial_unique_index(owner_conn: asyncpg.Connection) -> None:
    ddl = await _indexdef(owner_conn, "uq_appt_doctor_slot_booked")
    assert ddl is not None
    assert "UNIQUE" in ddl
    assert "(doctor_id, starts_at)" in ddl
    assert "status = 'booked'" in ddl


async def test_patient_slot_partial_unique_index(owner_conn: asyncpg.Connection) -> None:
    ddl = await _indexdef(owner_conn, "uq_appt_patient_slot_booked")
    assert ddl is not None
    assert "UNIQUE" in ddl
    assert "(patient_id, starts_at)" in ddl
    assert "status = 'booked'" in ddl


async def test_check_constraints_present(owner_conn: asyncpg.Connection) -> None:
    names = {
        r["conname"]
        for r in await owner_conn.fetch("SELECT conname FROM pg_constraint WHERE contype = 'c'")
    }
    for expected in (
        "ck_appt_status",
        "ck_appt_duration",
        "ck_appt_alignment",
        "ck_appt_cancel_consistency",
        "ck_wh_order",
        "ck_wh_align",
    ):
        assert expected in names, f"missing check constraint {expected}"
