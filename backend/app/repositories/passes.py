"""staff_passes and staff_pass_uses. The runtime role can read and insert; the only update it has
is closing a pass (``revoked_at``, ``revoked_by``); nothing deletes."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

_INSERT = text(
    """
    INSERT INTO staff_passes (token_hash, role, max_uses, created_by, created_at, expires_at)
    VALUES (:token_hash, CAST(:role AS staff_role), :max_uses, :created_by, :now, :expires_at)
    RETURNING id, role::text AS role, max_uses, created_by, created_at, expires_at, revoked_at,
              revoked_by
    """
)

_BY_HASH = text(
    """
    SELECT id, role::text AS role, max_uses, created_by, created_at, expires_at, revoked_at,
           revoked_by
    FROM staff_passes WHERE token_hash = :h FOR UPDATE
    """
)
_BY_ID = text(
    """
    SELECT id, role::text AS role, max_uses, created_by, created_at, expires_at, revoked_at,
           revoked_by
    FROM staff_passes WHERE id = :id FOR UPDATE
    """
)

_LIST = text(
    """
    SELECT id, role::text AS role, max_uses, created_by, created_at, expires_at, revoked_at,
           revoked_by
    FROM staff_passes ORDER BY created_at DESC, id DESC LIMIT :limit
    """
)

_REVOKE = text(
    """
    UPDATE staff_passes SET revoked_at = :now, revoked_by = :by WHERE id = :id
    RETURNING id, role::text AS role, max_uses, created_by, created_at, expires_at, revoked_at,
              revoked_by
    """
)

# The daily budget is per owner and rolling: passes made in the last 24 hours, revoked ones
# included (a revoke must not refund the budget).
_COUNT_RECENT = text(
    """
    SELECT count(*) AS n, min(created_at) AS oldest
    FROM staff_passes WHERE created_by = :actor AND created_at > :since
    """
)

_USES_OF = text(
    """
    SELECT pass_id, email::text AS email, used_at
    FROM staff_pass_uses WHERE pass_id = ANY(CAST(:ids AS uuid[])) ORDER BY used_at, email
    """
)

_COUNT_USES = text("SELECT count(*) FROM staff_pass_uses WHERE pass_id = :id")

_INSERT_USE = text(
    """
    INSERT INTO staff_pass_uses (pass_id, email, used_at)
    VALUES (:pass_id, CAST(:email AS citext), :now)
    """
)

_LOCK_CREATOR = text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))")


async def lock_creator(session: AsyncSession, actor: str) -> None:
    """Serialises one owner's pass creations, so two at once cannot both pass the count."""
    await session.execute(_LOCK_CREATOR, {"k": f"pass:{actor}"})


async def recent_passes(
    session: AsyncSession, *, actor: str, since: datetime
) -> tuple[int, datetime | None]:
    row = (await session.execute(_COUNT_RECENT, {"actor": actor, "since": since})).one()
    return int(row.n), row.oldest


async def insert(
    session: AsyncSession,
    *,
    token_hash: str,
    role: str,
    max_uses: int,
    created_by: str,
    now: datetime,
    expires_at: datetime,
) -> dict[str, Any]:
    row = await session.execute(
        _INSERT,
        {
            "token_hash": token_hash,
            "role": role,
            "max_uses": max_uses,
            "created_by": created_by,
            "now": now,
            "expires_at": expires_at,
        },
    )
    return dict(row.mappings().one())


async def get_by_hash(session: AsyncSession, token_hash: str) -> dict[str, Any] | None:
    """The pass, locked until the transaction ends: concurrent accepts of it queue here."""
    row = (await session.execute(_BY_HASH, {"h": token_hash})).mappings().first()
    return dict(row) if row else None


async def get_for_update(session: AsyncSession, pass_id: uuid.UUID) -> dict[str, Any] | None:
    row = (await session.execute(_BY_ID, {"id": pass_id})).mappings().first()
    return dict(row) if row else None


async def list_passes(session: AsyncSession, limit: int) -> list[dict[str, Any]]:
    return [dict(r) for r in (await session.execute(_LIST, {"limit": limit})).mappings()]


async def revoke(
    session: AsyncSession, *, pass_id: uuid.UUID, by: str, now: datetime
) -> dict[str, Any]:
    row = await session.execute(_REVOKE, {"id": pass_id, "by": by, "now": now})
    return dict(row.mappings().one())


async def uses_of(
    session: AsyncSession, pass_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[dict[str, Any]]]:
    """Who took a seat on each pass, oldest first."""
    out: dict[uuid.UUID, list[dict[str, Any]]] = {i: [] for i in pass_ids}
    rows = await session.execute(_USES_OF, {"ids": [str(i) for i in pass_ids]})
    for r in rows.mappings():
        out[r["pass_id"]].append({"email": r["email"], "used_at": r["used_at"]})
    return out


async def count_uses(session: AsyncSession, pass_id: uuid.UUID) -> int:
    return int((await session.execute(_COUNT_USES, {"id": pass_id})).scalar_one())


async def insert_use(
    session: AsyncSession, *, pass_id: uuid.UUID, email: str, now: datetime
) -> None:
    await session.execute(_INSERT_USE, {"pass_id": pass_id, "email": email, "now": now})
