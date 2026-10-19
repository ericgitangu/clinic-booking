"""Who may use the admin app. The owner comes from configuration; everyone else from staff_access.

Every grant, change and revoke writes an audit row in the same transaction as the change.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.domain.emailnorm import normalize_email
from app.domain.errors import AccessExists, AccessNotFound, OwnerProtected, RoleEscalation
from app.repositories import access as repo
from app.schemas.access import AccessEntry, AccessList, Role


async def resolve_role(session: AsyncSession, settings: Settings, email: str) -> Role | None:
    """The role this email holds right now, or None. Read on every request, never cached."""
    address = normalize_email(email)
    if address in settings.owner_emails:
        return "owner"
    role = await repo.active_role(session, address)
    if role in ("owner", "admin", "viewer"):
        return role  # type: ignore[return-value]  # narrowed by the membership test above
    return None


def _entry(row: dict[str, Any]) -> AccessEntry:
    return AccessEntry(**row, source="db")


def _owner_entry(email: str) -> AccessEntry:
    return AccessEntry(
        email=email,
        role="owner",
        granted_by="configuration",
        granted_at=None,
        revoked_at=None,
        source="env",
    )


async def list_access(session: AsyncSession, settings: Settings) -> AccessList:
    owners = [_owner_entry(e) for e in sorted(settings.owner_emails)]
    return AccessList(items=[*owners, *(_entry(r) for r in await repo.list_all(session))])


def _guard_owner(settings: Settings, actor: str, target: str) -> None:
    if target in settings.owner_emails:
        raise OwnerProtected()
    if target == actor:
        raise OwnerProtected("You cannot change or revoke your own access.")


# Who outranks whom. Acting on a row needs a STRICTLY higher rank than the row holds, so an admin
# can manage viewers and nothing above them, and nobody can touch the owner (checked first).
RANK = {"viewer": 1, "admin": 2, "owner": 3}


def _guard_change(
    settings: Settings, *, actor: str, actor_role: str, target: str, target_role: str
) -> None:
    """The staff-CRUD matrix for changing or revoking an existing row."""
    if target in settings.owner_emails:
        raise OwnerProtected()
    if target == actor:
        raise RoleEscalation("You cannot change or revoke your own access.")
    if RANK[actor_role] <= RANK[target_role]:
        raise RoleEscalation()


async def grant(
    session: AsyncSession,
    settings: Settings,
    *,
    actor: str,
    email: str,
    role: str,
    now: datetime,
) -> AccessEntry:
    _guard_owner(settings, actor, email)
    existing = await repo.get_for_update(session, email)
    if existing is not None and existing["revoked_at"] is None:
        raise AccessExists()
    row = await repo.upsert(session, email=email, role=role, actor=actor, now=now)
    await repo.audit(
        session, actor=actor, action="grant", target=email, old_role=None, new_role=role
    )
    await session.commit()
    return _entry(row)


async def change_role(
    session: AsyncSession,
    settings: Settings,
    *,
    actor: str,
    actor_role: str,
    email: str,
    role: str,
    now: datetime,
) -> AccessEntry:
    if email in settings.owner_emails:
        raise OwnerProtected()
    existing = await repo.get_for_update(session, email)
    if existing is None or existing["revoked_at"] is not None:
        raise AccessNotFound()
    _guard_change(
        settings, actor=actor, actor_role=actor_role, target=email, target_role=existing["role"]
    )
    if actor_role != "owner" and role == "admin":
        # An admin reaches admin only through an invitation, which binds the verified email and
        # expires; promoting an existing row would skip both. The owner may.
        raise RoleEscalation("Only the owner can make someone an admin; send an invitation.")
    row = await repo.set_role(session, email=email, role=role, actor=actor, now=now)
    await repo.audit(
        session,
        actor=actor,
        action="change",
        target=email,
        old_role=existing["role"],
        new_role=role,
    )
    await session.commit()
    return _entry(row)


async def revoke(
    session: AsyncSession,
    settings: Settings,
    *,
    actor: str,
    actor_role: str,
    email: str,
    now: datetime,
) -> AccessEntry:
    if email in settings.owner_emails:
        raise OwnerProtected()
    existing = await repo.get_for_update(session, email)
    if existing is None or existing["revoked_at"] is not None:
        raise AccessNotFound()
    _guard_change(
        settings, actor=actor, actor_role=actor_role, target=email, target_role=existing["role"]
    )
    row = await repo.revoke(session, email=email, now=now)
    await repo.audit(
        session,
        actor=actor,
        action="revoke",
        target=email,
        old_role=existing["role"],
        new_role=None,
    )
    await session.commit()
    return _entry(row)
