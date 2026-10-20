"""The database's list of audit actions is the code's list: a migration that rebuilds the CHECK
from an old copy (and so forbids an action the code still writes) fails here."""

from __future__ import annotations

import re
from typing import get_args

import asyncpg
import pytest

from app.domain.staff import StaffActionName

pytestmark = pytest.mark.asyncio


async def test_the_audit_action_check_lists_exactly_the_actions_the_code_writes(
    owner_conn: asyncpg.Connection,
) -> None:
    definition = await owner_conn.fetchval(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
        "WHERE conname = 'staff_action_audit_action_check'"
    )
    in_database = set(re.findall(r"'([a-z_]+)'", definition))
    assert in_database == set(get_args(StaffActionName))
