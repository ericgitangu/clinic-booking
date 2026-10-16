"""CI/local helper: create the clinic_app role from docker/initdb/01-roles.sql.

Run as the Postgres owner. Idempotent enough for CI (role is fresh each run).
"""

from __future__ import annotations

import asyncio
import pathlib

import asyncpg

OWNER_URL = "postgresql://clinic:clinic@localhost:5432/clinic"
ROLES_SQL = pathlib.Path(__file__).resolve().parent.parent / "docker" / "initdb" / "01-roles.sql"


async def main() -> None:
    for _ in range(30):
        try:
            conn = await asyncpg.connect(OWNER_URL)
            break
        except OSError:
            await asyncio.sleep(1)
    else:
        raise SystemExit("postgres did not become ready")
    try:
        await conn.execute(ROLES_SQL.read_text())
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
