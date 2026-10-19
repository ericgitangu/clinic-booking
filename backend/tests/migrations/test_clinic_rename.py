"""The data migration that renames the clinic: updates what holds the old name, nothing else, and a
second run changes nothing. Real Alembic and Postgres on a throwaway database."""

from __future__ import annotations

import asyncio
import os
import pathlib
import subprocess

import asyncpg

from tests.conftest import owner_dsn, owner_sqlalchemy_url

BACKEND_DIR = pathlib.Path(__file__).resolve().parents[2]
TMP_DB = "clinic_rename"
OLD = "Mv" + "ule Family Clinic"  # the retired name, from parts
THIS = "0011"  # the revision under test


def _revision_before() -> str:
    """The revision this migration follows, read from the migration chain itself."""
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    revision = ScriptDirectory.from_config(cfg).get_revision(THIS)
    assert revision is not None and isinstance(revision.down_revision, str)
    return revision.down_revision


BEFORE = _revision_before()


def _alembic(*args: str) -> None:
    env = {**os.environ, "DATABASE_URL": owner_sqlalchemy_url(TMP_DB)}
    r = subprocess.run(
        ["uv", "run", "alembic", *args],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert r.returncode == 0, f"alembic {args} failed:\n{r.stdout}\n{r.stderr}"


async def _admin(sql: str) -> None:
    conn = await asyncpg.connect(owner_dsn())
    try:
        await conn.execute(sql)
    finally:
        await conn.close()


async def _names() -> dict[str, str]:
    conn = await asyncpg.connect(owner_dsn(TMP_DB))
    try:
        rows = await conn.fetch("SELECT id::text, name FROM clinics ORDER BY id")
        return {r["id"]: r["name"] for r in rows}
    finally:
        await conn.close()


async def _insert(rows: dict[str, str]) -> None:
    conn = await asyncpg.connect(owner_dsn(TMP_DB))
    try:
        for id_, name in rows.items():
            await conn.execute(
                "INSERT INTO clinics (id, name, timezone) VALUES ($1::uuid, $2, 'Africa/Nairobi')",
                id_,
                name,
            )
    finally:
        await conn.close()


def test_the_rename_updates_old_names_only_and_a_rerun_changes_nothing() -> None:
    asyncio.run(_admin(f'DROP DATABASE IF EXISTS "{TMP_DB}" WITH (FORCE)'))
    asyncio.run(_admin(f'CREATE DATABASE "{TMP_DB}"'))
    try:
        _alembic("upgrade", BEFORE)  # the schema as it was just before this migration
        a = "00000000-0000-4000-8000-00000000000a"
        b = "00000000-0000-4000-8000-00000000000b"
        c = "00000000-0000-4000-8000-00000000000c"
        asyncio.run(_insert({a: OLD, b: f"{OLD} (Annex)", c: "Some Other Clinic"}))

        _alembic("upgrade", "head")
        after = asyncio.run(_names())
        assert after[a] == "Idyllic Clinic"
        assert after[b] == "Idyllic Clinic (Annex)"
        assert after[c] == "Some Other Clinic"  # untouched

        # idempotent: the migration run again (its downgrade does nothing) changes no row
        _alembic("downgrade", BEFORE)
        _alembic("upgrade", "head")
        assert asyncio.run(_names()) == after
    finally:
        asyncio.run(_admin(f'DROP DATABASE IF EXISTS "{TMP_DB}" WITH (FORCE)'))
