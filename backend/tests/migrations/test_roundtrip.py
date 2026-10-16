"""Migrations round-trip on a throwaway database: upgrade -> downgrade -> upgrade.

Runs the real alembic CLI (the same path compose and CI use) against an isolated DB so the
shared seeded database is never mutated.
"""

from __future__ import annotations

import asyncio
import pathlib
import subprocess

import asyncpg

from tests.conftest import owner_dsn, owner_sqlalchemy_url

BACKEND_DIR = pathlib.Path(__file__).resolve().parents[2]
TMP_DB = "clinic_roundtrip"


async def _reset_database() -> None:
    conn = await asyncpg.connect(owner_dsn())
    try:
        await conn.execute(f'DROP DATABASE IF EXISTS "{TMP_DB}" WITH (FORCE)')
        await conn.execute(f'CREATE DATABASE "{TMP_DB}"')
    finally:
        await conn.close()


async def _drop_database() -> None:
    conn = await asyncpg.connect(owner_dsn())
    try:
        await conn.execute(f'DROP DATABASE IF EXISTS "{TMP_DB}" WITH (FORCE)')
    finally:
        await conn.close()


def _alembic(args: list[str]) -> None:
    env_url = owner_sqlalchemy_url(TMP_DB)
    import os

    env = {**os.environ, "DATABASE_URL": env_url}
    result = subprocess.run(
        ["uv", "run", "alembic", *args],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"alembic {args} failed:\n{result.stdout}\n{result.stderr}"


def test_migrations_roundtrip() -> None:
    asyncio.run(_reset_database())
    try:
        _alembic(["upgrade", "head"])
        _alembic(["downgrade", "base"])
        _alembic(["upgrade", "head"])
    finally:
        asyncio.run(_drop_database())
