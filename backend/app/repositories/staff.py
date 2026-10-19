"""staff_action_audit (append-only for the runtime role) and staff_invites."""

from __future__ import annotations

import json
import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

_INSERT_AUDIT = text(
    """
    INSERT INTO staff_action_audit
      (actor_email, actor_role, action, appointment_id, reason, before, after)
    VALUES (:actor_email, CAST(:actor_role AS staff_role), :action, :appointment_id, :reason,
            CAST(:before AS jsonb), CAST(:after AS jsonb))
    RETURNING id
    """
)

_MARK_NOTIFIED = text("UPDATE staff_action_audit SET notified = true WHERE id = :id")

_FOR_NOTIFY = text(
    """
    SELECT actor_email, action, notified, after ->> 'outcome' AS outcome
    FROM staff_action_audit WHERE id = :id FOR UPDATE
    """
)

_AUDIT_PAGE = text(
    """
    SELECT id, actor_email, actor_role::text AS actor_role, action, appointment_id, reason,
           before, after, notified, occurred_at
    FROM staff_action_audit
    WHERE (CAST(:after_at AS timestamptz) IS NULL
           OR (occurred_at, id) < (CAST(:after_at AS timestamptz), CAST(:after_id AS uuid)))
      AND (CAST(:appointment_id AS uuid) IS NULL OR appointment_id = CAST(:appointment_id AS uuid))
    ORDER BY occurred_at DESC, id DESC
    LIMIT :limit
    """
)

_INSERT_INVITE = text(
    """
    INSERT INTO staff_invites (email, role, token_hash, invited_by, created_at, expires_at)
    VALUES (CAST(:email AS citext), CAST(:role AS staff_role), :token_hash, :invited_by,
            :now, :expires_at)
    RETURNING id, email::text AS email, role::text AS role, invited_by, created_at, expires_at,
       consumed_at, revoked_at, revoked_by
    """
)

# Re-inviting supersedes: the earlier open invite (even an expired, unused one, which still holds
# the one-open-per-email index) is closed before the new row goes in.
_SUPERSEDE = text(
    """
    UPDATE staff_invites SET revoked_at = :now, revoked_by = :by
    WHERE email = CAST(:email AS citext) AND consumed_at IS NULL AND revoked_at IS NULL
    RETURNING id
    """
)

_LIST_INVITES = text(
    """
    SELECT id, email::text AS email, role::text AS role, invited_by, created_at, expires_at,
           consumed_at, revoked_at, revoked_by
    FROM staff_invites ORDER BY created_at DESC, id DESC LIMIT :limit
    """
)

_GET_INVITE_BY_ID = text(
    """
    SELECT id, email::text AS email, role::text AS role, invited_by, created_at, expires_at,
           consumed_at, revoked_at, revoked_by
    FROM staff_invites WHERE id = :id FOR UPDATE
    """
)

_GET_INVITE_BY_HASH = text(
    """
    SELECT id, email::text AS email, role::text AS role, invited_by, created_at, expires_at,
           consumed_at, revoked_at, revoked_by
    FROM staff_invites WHERE token_hash = :h FOR UPDATE
    """
)

_REVOKE_INVITE = text(
    """
    UPDATE staff_invites SET revoked_at = :now, revoked_by = :by WHERE id = :id
    RETURNING id, email::text AS email, role::text AS role, invited_by, created_at, expires_at,
       consumed_at, revoked_at, revoked_by
    """
)

_CONSUME_INVITE = text(
    """
    UPDATE staff_invites SET consumed_at = :now WHERE id = :id
    RETURNING id, email::text AS email, role::text AS role, invited_by, created_at, expires_at,
           consumed_at, revoked_at, revoked_by
    """
)

# The daily budget is per actor and rolling: invites that actor created in the last 24 hours,
# superseded or revoked ones included (a revoke must not refund the budget).
_COUNT_RECENT = text(
    """
    SELECT count(*) AS n, min(created_at) AS oldest
    FROM staff_invites WHERE invited_by = :actor AND created_at > :since
    """
)

_LATEST_ATTENDANCE = text(
    """
    SELECT kind FROM appointment_attendance WHERE appointment_id = :id ORDER BY id DESC LIMIT 1
    """
)

_INSERT_ATTENDANCE = text(
    """
    INSERT INTO appointment_attendance (appointment_id, kind, marked_by, marked_at)
    VALUES (:id, :kind, :by, :at)
    """
)

# One row per person; the day resets in place, so nothing is ever deleted. No row comes back once
# the person has used the day's attempts.
_ACCEPT_ATTEMPT = text(
    """
    INSERT INTO invite_accept_cap AS t (actor_key, day, n) VALUES (:k, :d, 1)
    ON CONFLICT (actor_key) DO UPDATE
      SET n = CASE WHEN t.day = EXCLUDED.day THEN t.n + 1 ELSE 1 END, day = EXCLUDED.day
      WHERE t.day <> EXCLUDED.day OR t.n < :cap
    RETURNING n
    """
)

_LOCK_ACTOR = text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))")


async def insert_audit(
    session: AsyncSession,
    *,
    actor_email: str,
    actor_role: str,
    action: str,
    appointment_id: uuid.UUID | None,
    reason: str,
    before: dict[str, Any],
    after: dict[str, Any],
) -> uuid.UUID:
    result = await session.execute(
        _INSERT_AUDIT,
        {
            "actor_email": actor_email,
            "actor_role": actor_role,
            "action": action,
            "appointment_id": appointment_id,
            "reason": reason,
            "before": json.dumps(before, default=str),
            "after": json.dumps(after, default=str),
        },
    )
    audit_id: uuid.UUID = result.scalar_one()
    return audit_id


async def row_for_notify(session: AsyncSession, audit_id: uuid.UUID) -> dict[str, Any] | None:
    row = (await session.execute(_FOR_NOTIFY, {"id": audit_id})).mappings().first()
    return dict(row) if row else None


async def mark_notified(session: AsyncSession, audit_id: uuid.UUID, actor: str) -> None:
    # The trigger lets the flag be set only by the row's actor; it learns who is asking here.
    await session.execute(text("SELECT set_config('app.actor', :actor, true)"), {"actor": actor})
    await session.execute(_MARK_NOTIFIED, {"id": audit_id})


async def audit_page(
    session: AsyncSession,
    *,
    after: tuple[datetime, uuid.UUID] | None,
    appointment_id: uuid.UUID | None,
    limit: int,
) -> list[dict[str, Any]]:
    rows = await session.execute(
        _AUDIT_PAGE,
        {
            "after_at": after[0] if after else None,
            "after_id": after[1] if after else None,
            "appointment_id": appointment_id,
            "limit": limit,
        },
    )
    return [dict(r) for r in rows.mappings()]


async def lock_actor(session: AsyncSession, actor: str) -> None:
    await session.execute(_LOCK_ACTOR, {"k": f"invite:{actor}"})


async def recent_invites(
    session: AsyncSession, *, actor: str, since: datetime
) -> tuple[int, datetime | None]:
    row = (await session.execute(_COUNT_RECENT, {"actor": actor, "since": since})).one()
    return int(row.n), row.oldest


async def supersede_open(
    session: AsyncSession, *, email: str, by: str, now: datetime
) -> list[uuid.UUID]:
    """Close the open invite for this address (if any); the ids closed."""
    rows = await session.execute(_SUPERSEDE, {"email": email, "by": by, "now": now})
    return [r[0] for r in rows.all()]


async def insert_invite(
    session: AsyncSession,
    *,
    email: str,
    role: str,
    token_hash: str,
    invited_by: str,
    now: datetime,
    expires_at: datetime,
) -> dict[str, Any]:
    row = await session.execute(
        _INSERT_INVITE,
        {
            "email": email,
            "role": role,
            "token_hash": token_hash,
            "invited_by": invited_by,
            "now": now,
            "expires_at": expires_at,
        },
    )
    return dict(row.mappings().one())


async def list_invites(session: AsyncSession, limit: int) -> list[dict[str, Any]]:
    return [dict(r) for r in (await session.execute(_LIST_INVITES, {"limit": limit})).mappings()]


async def get_invite_for_update(
    session: AsyncSession, invite_id: uuid.UUID
) -> dict[str, Any] | None:
    row = (await session.execute(_GET_INVITE_BY_ID, {"id": invite_id})).mappings().first()
    return dict(row) if row else None


async def get_invite_by_hash(session: AsyncSession, token_hash: str) -> dict[str, Any] | None:
    row = (await session.execute(_GET_INVITE_BY_HASH, {"h": token_hash})).mappings().first()
    return dict(row) if row else None


async def revoke_invite(
    session: AsyncSession, *, invite_id: uuid.UUID, by: str, now: datetime
) -> dict[str, Any]:
    row = await session.execute(_REVOKE_INVITE, {"id": invite_id, "by": by, "now": now})
    return dict(row.mappings().one())


async def consume_invite(
    session: AsyncSession, *, invite_id: uuid.UUID, now: datetime
) -> dict[str, Any]:
    row = await session.execute(_CONSUME_INVITE, {"id": invite_id, "now": now})
    return dict(row.mappings().one())


async def latest_attendance(session: AsyncSession, appointment_id: uuid.UUID) -> str | None:
    kind: str | None = (
        await session.execute(_LATEST_ATTENDANCE, {"id": appointment_id})
    ).scalar_one_or_none()
    return kind


async def insert_attendance(
    session: AsyncSession, *, appointment_id: uuid.UUID, kind: str, by: str, at: datetime
) -> None:
    await session.execute(
        _INSERT_ATTENDANCE, {"id": appointment_id, "kind": kind, "by": by, "at": at}
    )


async def take_accept_attempt(session: AsyncSession, *, key: str, day: date, cap: int) -> bool:
    """Count one accept attempt for ``key`` today; False when the day's attempts are used up."""
    row = (await session.execute(_ACCEPT_ATTEMPT, {"k": key, "d": day, "cap": cap})).first()
    return row is not None
