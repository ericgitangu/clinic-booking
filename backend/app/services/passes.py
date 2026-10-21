"""Reviewer passes: a link that any verified Google account can accept to get a staff role.

Like an invite the raw token is 32 random bytes, shown once to the owner who makes the pass and
never stored or logged: only its SHA-256 is kept. Unlike an invite it is not tied to an address,
so what bounds it is the seat count and the expiry, and what keeps it safe is that only the owner
makes one, every use is audited, and a pass never undoes a revoke. Every way an accept can fail
raises the same ``PassInvalid``, so the response never says which check it was.
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import UTC, datetime, time, timedelta
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.assertion import Principal
from app.core.clock import Clock
from app.core.config import Settings
from app.domain.emailnorm import normalize_email
from app.domain.errors import PassInvalid, RateLimited
from app.repositories import access as access_repo
from app.repositories import passes as repo
from app.repositories import staff as staff_repo
from app.schemas.access import AccessEntry
from app.schemas.staff import Pass, PassAccepted, PassCreated, PassList, PassRevoked, PassStatus
from app.services import access as access_service
from app.services.invites import ACCEPT_DAILY_LIMIT, WINDOW, email_hash, hash_token

DAILY_LIMIT = 5
LIST_LIMIT = 100


def status_of(row: dict[str, Any], used: int, now: datetime) -> PassStatus:
    """Revoked wins over expired, and expired over used up: the first thing that ended it."""
    if row["revoked_at"] is not None:
        return "revoked"
    if row["expires_at"] <= now:
        return "expired"
    if used >= row["max_uses"]:
        return "used_up"
    return "active"


def _view(row: dict[str, Any], uses: list[dict[str, Any]], now: datetime) -> Pass:
    return Pass(
        id=row["id"],
        role=row["role"],
        max_uses=row["max_uses"],
        used=len(uses),
        created_by=row["created_by"],
        created_at=row["created_at"],
        expires_at=row["expires_at"],
        revoked_at=row["revoked_at"],
        status=status_of(row, len(uses), now),
        uses=uses,
    )


async def _audit(
    session: AsyncSession, actor: Principal, action: str, reason: str, after: dict[str, object]
) -> uuid.UUID:
    """One audit row for a pass event, in the transaction of the event. Ids and a role: never the
    token, its hash or an address."""
    return await staff_repo.insert_audit(
        session,
        actor_email=normalize_email(actor.email),
        actor_role=actor.role,
        action=action,
        appointment_id=None,
        reason=reason,
        before={},
        after=after,
    )


async def create(
    session: AsyncSession,
    clock: Clock,
    *,
    actor: Principal,
    role: str,
    max_uses: int,
    days: int,
) -> PassCreated:
    owner = normalize_email(actor.email)
    now = clock.now()
    token = secrets.token_urlsafe(32)
    async with session.begin():
        await repo.lock_creator(session, owner)
        used, oldest = await repo.recent_passes(session, actor=owner, since=now - WINDOW)
        if used >= DAILY_LIMIT:
            wait = int(((oldest or now) + WINDOW - now).total_seconds())
            raise RateLimited(max(wait, 1), "At most 5 reviewer passes a day.")
        row = await repo.insert(
            session,
            token_hash=hash_token(token),
            role=role,
            max_uses=max_uses,
            created_by=owner,
            now=now,
            expires_at=now + timedelta(days=days),
        )
        audit_id = await _audit(
            session,
            actor,
            "pass_create",
            f"Reviewer pass for {role}, {max_uses} people, {days} days",
            {
                "pass_id": str(row["id"]),
                "role": role,
                "max_uses": max_uses,
                "expires_at": row["expires_at"].isoformat(),
            },
        )
    return PassCreated(**_view(row, [], now).model_dump(), token=token, audit_id=audit_id)


async def list_all(session: AsyncSession, clock: Clock) -> PassList:
    rows = await repo.list_passes(session, LIST_LIMIT)
    uses = await repo.uses_of(session, [r["id"] for r in rows])
    now = clock.now()
    items = [_view(r, uses[r["id"]], now) for r in rows]
    await session.rollback()
    return PassList(items=items)


async def revoke(
    session: AsyncSession, clock: Clock, *, actor: Principal, pass_id: uuid.UUID
) -> PassRevoked:
    """Stops new sign-ins with the pass. People who already joined keep their access: that is
    revoked person by person, as for any staff member."""
    now = clock.now()
    async with session.begin():
        row = await repo.get_for_update(session, pass_id)
        if row is None or row["revoked_at"] is not None:
            raise PassInvalid()
        row = await repo.revoke(session, pass_id=pass_id, by=normalize_email(actor.email), now=now)
        audit_id = await _audit(
            session,
            actor,
            "pass_revoke",
            "Reviewer pass revoked",
            {"pass_id": str(pass_id), "role": row["role"]},
        )
        uses = (await repo.uses_of(session, [pass_id]))[pass_id]
    return PassRevoked(**_view(row, uses, now).model_dump(), audit_id=audit_id)


async def accept(
    session: AsyncSession,
    clock: Clock,
    settings: Settings,
    *,
    who: Principal,
    token: str,
) -> PassAccepted:
    now = clock.now()
    address = normalize_email(who.email)
    if not who.email_verified:
        # Refused before it is counted: someone else's address, unverified, must not be able to
        # use up that person's attempts for the day.
        raise PassInvalid()
    # The same per-address budget as accepting an invitation, in a transaction of its own so a
    # failed attempt still costs one.
    async with session.begin():
        allowed = await staff_repo.take_accept_attempt(
            session,
            key=hashlib.sha256(address.encode("utf-8")).hexdigest(),
            day=now.date(),
            cap=ACCEPT_DAILY_LIMIT,
        )
    if not allowed:
        midnight = datetime.combine(now.date() + timedelta(days=1), time.min, tzinfo=UTC)
        raise RateLimited(max(int((midnight - now).total_seconds()), 1), "Too many attempts today.")
    async with session.begin():
        # The row lock queues concurrent accepts of one pass, so the last seat goes to one only.
        row = await repo.get_by_hash(session, hash_token(token))
        if row is None or row["revoked_at"] is not None or row["expires_at"] <= now:
            raise PassInvalid()
        # The pass is only as good as the owner who made it: if they lost that role it is void.
        if await access_service.resolve_role(session, settings, row["created_by"]) != "owner":
            raise PassInvalid()
        if address in settings.owner_emails:
            raise PassInvalid()
        existing = await access_repo.get_for_update(session, address)
        if existing is not None and existing["revoked_at"] is not None:
            # A pass never undoes a revoke: only the owner can, from the Access page.
            raise PassInvalid()
        used = await repo.count_uses(session, row["id"])
        if existing is not None:
            # Already staff: opening the link twice is harmless. No seat, nothing written.
            return PassAccepted(
                **AccessEntry(**existing, source="db").model_dump(),
                joined=False,
                pass_id=row["id"],
                use=used,
                of=row["max_uses"],
            )
        if used >= row["max_uses"]:
            raise PassInvalid()
        granted = await access_repo.upsert(
            session, email=address, role=row["role"], actor=row["created_by"], now=now
        )
        await access_repo.audit(
            session,
            actor=row["created_by"],
            action="grant",
            target=address,
            old_role=None,
            new_role=row["role"],
        )
        await repo.insert_use(session, pass_id=row["id"], email=address, now=now)
        # The actor is the person who accepted, in the role they now hold, so actor_email holds
        # their address in plain text, as it does for every staff actor in this table. Only
        # `after` keeps the address as a hash.
        await staff_repo.insert_audit(
            session,
            actor_email=address,
            actor_role=row["role"],
            action="pass_accept",
            appointment_id=None,
            reason="Reviewer pass accepted",
            before={},
            after={
                "pass_id": str(row["id"]),
                "email_hash": email_hash(address),
                "role": row["role"],
                "use": used + 1,
                "of": row["max_uses"],
            },
        )
    return PassAccepted(
        **AccessEntry(**granted, source="db").model_dump(),
        joined=True,
        pass_id=row["id"],
        use=used + 1,
        of=row["max_uses"],
    )
