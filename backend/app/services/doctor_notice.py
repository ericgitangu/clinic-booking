"""Telling a doctor that a patient arrived.

The arrival writes one ``doctor_notification`` row in its own transaction (``record_arrival``), so
the dashboard can always say what became of the email: pending, or skipped with the reason (the
doctor has no address). The web app then claims the row, reserves one email from the shared daily
and monthly allowance, sends through the same sender as every other email, and reports the result
(``claim`` and ``finish``). Nothing here sends: like the staff emails, the API records and the web
app delivers, after the response, so an arrival never waits for or fails on an email.

Setting the doctor's address is a staff action with a reason, audited with the address before and
after, in the transaction of the change (``set_email``).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.assertion import Principal
from app.core.clock import Clock
from app.core.config import Settings
from app.domain.emailnorm import normalize_email
from app.domain.errors import DoctorNotFound, NotFoundRoute
from app.domain.notify import is_demo_recipient
from app.repositories import doctor_notice as repo
from app.repositories import staff as staff_repo
from app.schemas.doctor_notice import (
    DoctorEmail,
    DoctorNoticeClaim,
    DoctorNoticeFinish,
    DoctorNoticeFinished,
    DoctorNoticeState,
    DoctorNoticeToSend,
)

# A row is sent at most this many times (the first try and two retries).
MAX_ATTEMPTS = 3
# A pending row nobody has claimed this long after it was written is not going to be sent by the
# after() that was meant to (it was cut off, or its claim call failed): the sheet offers a resend.
UNCLAIMED_GRACE = timedelta(minutes=2)


def _state(
    row: dict[str, Any], *, now: datetime | None = None, lease: timedelta | None = None
) -> DoctorNoticeState:
    """The row as the sheet and the toast see it. With ``now`` and ``lease`` it also says whether a
    resend can help: a failed row with attempts left, or a pending row nothing is sending any more.
    A pending row that has used every attempt and is no longer being sent is reported as failed, so
    it never reads "on its way" forever."""
    status = row["status"]
    attempts = row.get("attempts", 0)
    retryable = False
    if now is not None and lease is not None:
        leased_at = row.get("leased_at")
        if status == "failed":
            retryable = attempts < MAX_ATTEMPTS
        elif status == "pending":
            held = leased_at is not None and leased_at >= now - lease
            unclaimed = leased_at is None and row["updated_at"] < now - UNCLAIMED_GRACE
            gone = leased_at is not None and not held
            if unclaimed or gone:
                if attempts >= MAX_ATTEMPTS:
                    status = "failed"
                else:
                    retryable = True
    return DoctorNoticeState(
        id=row["id"],
        status=status,
        reason=row.get("reason"),
        attempts=attempts,
        sent_at=row.get("sent_at"),
        retryable=retryable,
    )


async def record_arrival(
    session: AsyncSession, clock: Clock, *, appointment_id: uuid.UUID, doctor_id: uuid.UUID
) -> DoctorNoticeState:
    """Write the row for this arrival inside the caller's transaction. A doctor with no address (or
    a reserved demo address) gets a row that is already skipped, with the reason. A second mark of
    the same appointment writes nothing and returns the row that is there."""
    email = await repo.doctor_email(session, doctor_id)
    if not email:
        status, reason = "skipped", "no_email"
    elif is_demo_recipient(email):
        status, reason = "skipped", "demo_address"
    else:
        status, reason = "pending", None
    row = await repo.insert_for_arrival(
        session,
        appointment_id=appointment_id,
        doctor_id=doctor_id,
        status=status,
        reason=reason,
        now=clock.now(),
    )
    if row is None:
        existing = await repo.for_appointment(session, appointment_id)
        if existing is None:  # pragma: no cover - the unique key said it is there
            raise NotFoundRoute("No doctor notification for this appointment.")
        return _state(existing)
    return _state({**row, "attempts": 0, "sent_at": None})


async def state_for(
    session: AsyncSession, clock: Clock, settings: Settings, appointment_id: uuid.UUID
) -> DoctorNoticeState:
    row = await repo.for_appointment(session, appointment_id)
    await session.rollback()
    if row is None:
        raise NotFoundRoute("No doctor notification for this appointment.")
    return _state(row, now=clock.now(), lease=timedelta(minutes=settings.REMINDER_LEASE_MINUTES))


async def claim(
    session: AsyncSession,
    clock: Clock,
    settings: Settings,
    *,
    notification_id: uuid.UUID,
) -> DoctorNoticeClaim:
    now = clock.now()
    async with session.begin():
        row = await repo.claim(
            session,
            notification_id,
            now=now,
            lease_cutoff=now - timedelta(minutes=settings.REMINDER_LEASE_MINUTES),
            max_attempts=MAX_ATTEMPTS,
        )
        if row is None:
            return DoctorNoticeClaim(send=None)
        email = row["doctor_email"]
        # The address may have been cleared, or set to a reserved name, since the row was written.
        if not email or is_demo_recipient(email):
            await repo.finish_skipped(
                session,
                notification_id,
                attempt=row["attempts"],
                reason="no_email" if not email else "demo_address",
                now=now,
            )
            return DoctorNoticeClaim(send=None)
        return DoctorNoticeClaim(
            send=DoctorNoticeToSend(
                id=row["id"],
                appointment_id=row["appointment_id"],
                attempt=row["attempts"],
                doctor_email=email,
                doctor_name=row["doctor_name"],
                patient_name=row["patient_name"],
                starts_at=row["starts_at"],
                timezone=row["timezone"],
            )
        )


async def finish(
    session: AsyncSession,
    clock: Clock,
    *,
    notification_id: uuid.UUID,
    body: DoctorNoticeFinish,
) -> DoctorNoticeFinished:
    """Record the result of a send made under a claim. The result names the attempt the claim
    returned and is applied only to that attempt: a sender whose lease ran out and whose row was
    claimed again since cannot overwrite the newer claim. A row that is not held, is already sent
    or skipped, or is on another attempt is left alone and the answer says what it is."""
    now = clock.now()
    async with session.begin():
        if body.outcome == "sent":
            done = await repo.finish_sent(
                session,
                notification_id,
                attempt=body.attempt,
                provider_id=body.provider_id,
                now=now,
            )
        elif body.outcome == "failed":
            done = await repo.finish_failed(
                session,
                notification_id,
                attempt=body.attempt,
                error=body.error or "send failed",
                now=now,
            )
        else:
            done = await repo.finish_skipped(
                session,
                notification_id,
                attempt=body.attempt,
                reason=body.reason or "not_configured",
                now=now,
            )
        row = await repo.by_id(session, notification_id)
    if row is None:
        raise NotFoundRoute("No such notification.")
    return DoctorNoticeFinished(id=row["id"], status=row["status"], updated=done)


async def set_email(
    session: AsyncSession,
    *,
    actor: Principal,
    doctor_id: uuid.UUID,
    email: str | None,
    reason: str,
) -> DoctorEmail:
    """Set, change or clear the doctor's address, with the audit row in the same transaction.
    Setting what is already there changes and records nothing."""
    async with session.begin():
        doctor = await repo.lock_doctor(session, doctor_id)
        if doctor is None:
            raise DoctorNotFound()
        before = doctor["email"]
        if before == email:
            return DoctorEmail(doctor_id=doctor_id, email=email, audit_id=None)
        await repo.set_email(session, doctor_id, email)
        audit_id = await staff_repo.insert_audit(
            session,
            actor_email=normalize_email(actor.email),
            actor_role=actor.role,
            action="doctor_email",
            appointment_id=None,
            reason=reason,
            before={"doctor_id": str(doctor_id), "email": before},
            after={"doctor_id": str(doctor_id), "email": email},
        )
    return DoctorEmail(doctor_id=doctor_id, email=email, audit_id=audit_id)
