"""staff_access and its audit trail. The runtime role can insert and update, never delete."""

from __future__ import annotations

from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

_ACTIVE_ROLE = text(
    "SELECT role::text FROM staff_access "
    "WHERE email = CAST(:email AS citext) AND revoked_at IS NULL"
)

_LIST = text(
    """
    SELECT email::text AS email, role::text AS role, granted_by, granted_at, revoked_at
    FROM staff_access
    ORDER BY (revoked_at IS NOT NULL), email
    """
)

_GET = text(
    """
    SELECT email::text AS email, role::text AS role, granted_by, granted_at, revoked_at
    FROM staff_access WHERE email = CAST(:email AS citext)
    FOR UPDATE
    """
)

_UPSERT = text(
    """
    INSERT INTO staff_access (email, role, granted_by)
    VALUES (CAST(:email AS citext), CAST(:role AS staff_role), :actor)
    ON CONFLICT (email) DO UPDATE
      SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by,
          granted_at = now(), revoked_at = NULL
    RETURNING email::text AS email, role::text AS role, granted_by, granted_at, revoked_at
    """
)

_SET_ROLE = text(
    """
    UPDATE staff_access SET role = CAST(:role AS staff_role)
    WHERE email = CAST(:email AS citext) AND revoked_at IS NULL
    RETURNING email::text AS email, role::text AS role, granted_by, granted_at, revoked_at
    """
)

_REVOKE = text(
    """
    UPDATE staff_access SET revoked_at = now()
    WHERE email = CAST(:email AS citext) AND revoked_at IS NULL
    RETURNING email::text AS email, role::text AS role, granted_by, granted_at, revoked_at
    """
)

_AUDIT = text(
    """
    INSERT INTO staff_access_audit (actor_email, action, target_email, old_role, new_role)
    VALUES (:actor, :action, :target, CAST(:old_role AS staff_role), CAST(:new_role AS staff_role))
    """
)


async def active_role(session: AsyncSession, email: str) -> str | None:
    return (await session.execute(_ACTIVE_ROLE, {"email": email})).scalar_one_or_none()


async def list_all(session: AsyncSession) -> list[dict[str, Any]]:
    return [dict(r) for r in (await session.execute(_LIST)).mappings()]


async def get_for_update(session: AsyncSession, email: str) -> dict[str, Any] | None:
    row = (await session.execute(_GET, {"email": email})).mappings().first()
    return dict(row) if row else None


async def upsert(session: AsyncSession, *, email: str, role: str, actor: str) -> dict[str, Any]:
    row = (
        await session.execute(_UPSERT, {"email": email, "role": role, "actor": actor})
    ).mappings()
    return dict(row.one())


async def set_role(session: AsyncSession, *, email: str, role: str) -> dict[str, Any]:
    return dict((await session.execute(_SET_ROLE, {"email": email, "role": role})).mappings().one())


async def revoke(session: AsyncSession, *, email: str) -> dict[str, Any]:
    return dict((await session.execute(_REVOKE, {"email": email})).mappings().one())


async def audit(
    session: AsyncSession,
    *,
    actor: str,
    action: str,
    target: str,
    old_role: str | None,
    new_role: str | None,
) -> None:
    await session.execute(
        _AUDIT,
        {
            "actor": actor,
            "action": action,
            "target": target,
            "old_role": old_role,
            "new_role": new_role,
        },
    )
