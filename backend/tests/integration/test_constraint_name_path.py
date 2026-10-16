"""Pin the asyncpg attribute path for sqlstate and constraint_name.

Everything in repositories/errors.py depends on this exact path, so it is tested first.
"""

from __future__ import annotations

import asyncpg
import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import create_async_engine

from app.db.errors import extract_sqlstate_constraint
from tests.conftest import app_sqlalchemy_url, owner_dsn

PHONE = "+254700111222"
pytestmark = pytest.mark.asyncio


async def _delete_phone() -> None:
    conn = await asyncpg.connect(owner_dsn())
    try:
        await conn.execute("DELETE FROM patients WHERE phone = $1", PHONE)
    finally:
        await conn.close()


async def test_unique_violation_exposes_sqlstate_and_constraint() -> None:
    await _delete_phone()  # idempotent: clear any leftover from a prior run
    engine = create_async_engine(app_sqlalchemy_url())
    try:
        async with engine.begin() as conn:
            await conn.execute(
                text("INSERT INTO patients (full_name, phone) VALUES ('Path One', :p)"),
                {"p": PHONE},
            )
        with pytest.raises(IntegrityError) as exc_info:
            async with engine.begin() as conn:
                await conn.execute(
                    text("INSERT INTO patients (full_name, phone) VALUES ('Path Two', :p)"),
                    {"p": PHONE},
                )
        sqlstate, constraint = extract_sqlstate_constraint(exc_info.value)
        assert sqlstate == "23505"
        assert constraint == "uq_patients_phone"
    finally:
        await engine.dispose()
        await _delete_phone()
