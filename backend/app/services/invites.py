"""Email invites to the admin app.

The raw token is 32 random bytes, shown once to the caller that creates the invite (for the email
link) and never stored or logged: only its SHA-256 is kept. Accepting needs a verified sign-in
whose email equals the invited one, compared in constant time. Every way an accept can fail
raises the same ``InviteInvalid``, so the response never says which check it was.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
from datetime import UTC, datetime, time, timedelta
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.assertion import Principal
from app.core.clock import Clock
from app.core.config import Settings
from app.domain.emailnorm import normalize_email
from app.domain.errors import (
    AccessExists,
    InviteInvalid,
    OwnerProtected,
    RateLimited,
    RoleEscalation,
)
from app.domain.notify import outcome_for
from app.repositories import access as access_repo
from app.repositories import staff as repo
from app.schemas.access import AccessEntry
from app.schemas.staff import Invite, InviteCreated, InviteList, InviteRevoked, InviteStatus
from app.services import access as access_service

INVITE_TTL = timedelta(hours=72)
DAILY_LIMIT = 10
# Attempts to accept an invitation, per person per UTC day, whether or not they succeed.
ACCEPT_DAILY_LIMIT = 20
WINDOW = timedelta(hours=24)
LIST_LIMIT = 100
# Compared against when no invite matched, so a miss does the same work as a near miss.
_NO_EMAIL = "no-invite@invalid"


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("ascii", "replace")).hexdigest()


def _status(row: dict[str, Any], now: datetime) -> InviteStatus:
    if row["consumed_at"] is not None:
        return "consumed"
    if row["revoked_at"] is not None:
        return "revoked"
    if row["expires_at"] <= now:
        return "expired"
    return "open"


def _view(row: dict[str, Any], now: datetime) -> Invite:
    return Invite(
        id=row["id"],
        email=row["email"],
        role=row["role"],
        invited_by=row["invited_by"],
        status=_status(row, now),
        created_at=row["created_at"],
        expires_at=row["expires_at"],
    )


def email_hash(email: str) -> str:
    """What the audit trail keeps instead of an address."""
    return hashlib.sha256(normalize_email(email).encode("utf-8")).hexdigest()


async def _audit(
    session: AsyncSession,
    actor: Principal,
    action: str,
    reason: str,
    invite_id: uuid.UUID,
    email: str,
    extra: dict[str, object] | None = None,
) -> uuid.UUID:
    """One audit row for an invitation event, in the transaction of the event. Ids, a role and a
    hash of the address: never the address."""
    return await repo.insert_audit(
        session,
        actor_email=normalize_email(actor.email),
        actor_role=actor.role,
        action=action,
        appointment_id=None,
        reason=reason,
        before={},
        after={"invite_id": str(invite_id), "email_hash": email_hash(email), **(extra or {})},
    )


async def create(
    session: AsyncSession,
    clock: Clock,
    settings: Settings,
    *,
    actor: Principal,
    email: str,
    role: str,
) -> InviteCreated:
    inviter = normalize_email(actor.email)
    if email in settings.owner_emails:
        raise OwnerProtected()
    if role == "admin" and actor.role != "owner":
        # Admin is the owner's to give: an admin inviting an admin could undo an owner's revoke.
        raise RoleEscalation("Only the owner can invite an admin.")
    if email == inviter:
        raise RoleEscalation("You cannot invite yourself.")
    now = clock.now()
    token = secrets.token_urlsafe(32)
    async with session.begin():
        # Serialises this actor's invites, so two at once cannot both pass the count.
        await repo.lock_actor(session, inviter)
        used, oldest = await repo.recent_invites(session, actor=inviter, since=now - WINDOW)
        if used >= DAILY_LIMIT:
            wait = int(((oldest or now) + WINDOW - now).total_seconds())
            raise RateLimited(max(wait, 1), "At most 10 invitations a day per person.")
        before = await access_repo.get_for_update(session, email)
        if before is not None and before["revoked_at"] is None:
            raise AccessExists()
        if before is not None and actor.role != "owner":
            # Access that was revoked stays revoked unless the owner says otherwise, whatever role
            # the new invitation offers.
            raise RoleEscalation("Only the owner can invite someone whose access was revoked.")
        for closed in await repo.supersede_open(session, email=email, by=inviter, now=now):
            await _audit(
                session, actor, "invite_revoke", "Superseded by a new invitation", closed, email
            )
        row = await repo.insert_invite(
            session,
            email=email,
            role=role,
            token_hash=hash_token(token),
            invited_by=inviter,
            now=now,
            expires_at=now + INVITE_TTL,
        )
        outcome = outcome_for(email)
        audit_id = await _audit(
            session,
            actor,
            "invite_create",
            f"Invited as {role}",
            row["id"],
            email,
            extra={"role": role, "outcome": outcome},
        )
    return InviteCreated(
        **_view(row, now).model_dump(),
        token=token,
        audit_id=audit_id,
        deliver=outcome == "to send",
        outcome=outcome,
    )


async def list_all(session: AsyncSession, clock: Clock) -> InviteList:
    rows = await repo.list_invites(session, LIST_LIMIT)
    now = clock.now()
    items = [_view(r, now) for r in rows]
    await session.rollback()
    return InviteList(items=items)


async def revoke(
    session: AsyncSession, clock: Clock, *, actor: Principal, invite_id: uuid.UUID
) -> InviteRevoked:
    now = clock.now()
    async with session.begin():
        row = await repo.get_invite_for_update(session, invite_id)
        if row is None or row["consumed_at"] is not None or row["revoked_at"] is not None:
            raise InviteInvalid()
        if row["role"] == "admin" and actor.role != "owner":
            raise RoleEscalation("Only the owner can revoke an invitation to be an admin.")
        row = await repo.revoke_invite(
            session, invite_id=invite_id, by=normalize_email(actor.email), now=now
        )
        audit_id = await _audit(
            session, actor, "invite_revoke", "Invitation revoked", invite_id, row["email"]
        )
    return InviteRevoked(**_view(row, now).model_dump(), audit_id=audit_id)


async def accept(
    session: AsyncSession,
    clock: Clock,
    settings: Settings,
    *,
    who: Principal,
    token: str,
) -> AccessEntry:
    now = clock.now()
    address = normalize_email(who.email)
    if not who.email_verified:
        # Refused before it is counted: someone else's address, unverified, must not be able to
        # use up that person's attempts for the day.
        raise InviteInvalid()
    # Counted in a transaction of its own, so a failed attempt still costs one.
    async with session.begin():
        allowed = await repo.take_accept_attempt(
            session,
            key=hashlib.sha256(address.encode("utf-8")).hexdigest(),
            day=now.date(),
            cap=ACCEPT_DAILY_LIMIT,
        )
    if not allowed:
        midnight = datetime.combine(now.date() + timedelta(days=1), time.min, tzinfo=UTC)
        raise RateLimited(max(int((midnight - now).total_seconds()), 1), "Too many attempts today.")
    async with session.begin():
        row = await repo.get_invite_by_hash(session, hash_token(token))
        invited = row["email"] if row is not None else _NO_EMAIL
        # Constant-time comparison of the verified sign-in email with the invited one.
        same_email = hmac.compare_digest(invited.encode("utf-8"), address.encode("utf-8"))
        usable = (
            row is not None
            and row["consumed_at"] is None
            and row["revoked_at"] is None
            and row["expires_at"] > now
        )
        if not (usable and same_email and who.email_verified) or row is None:
            raise InviteInvalid()
        # The invite is only as good as the person who sent it: if they have lost the right to
        # invite, or the address became staff since, it is void.
        inviter_role = await access_service.resolve_role(session, settings, row["invited_by"])
        if inviter_role not in ("owner", "admin"):
            raise InviteInvalid()
        if address in settings.owner_emails:
            raise InviteInvalid()
        existing = await access_repo.get_for_update(session, address)
        if existing is not None and existing["revoked_at"] is None:
            raise InviteInvalid()
        granted = await access_repo.upsert(
            session, email=address, role=row["role"], actor=row["invited_by"], now=now
        )
        await access_repo.audit(
            session,
            actor=row["invited_by"],
            action="grant",
            target=address,
            old_role=None,
            new_role=row["role"],
        )
        await repo.consume_invite(session, invite_id=row["id"], now=now)
    return AccessEntry(**granted, source="db")
