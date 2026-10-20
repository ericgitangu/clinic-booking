"""The scheduled reminder run and the daily email budget, for the web app's server side only.

``/internal/reminders/*`` is for the run itself (it signs as the system caller). The budget
endpoints take any valid assertion, because the acknowledgement emails are sent while a patient's
request is being served and count against the same daily limit.
"""

from __future__ import annotations

import asyncio
import logging
import random
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_clock, get_session, get_settings, require_identity, require_system
from app.core.clinic_zone import default_zone
from app.core.clock import Clock
from app.core.config import Settings
from app.core.logging import APP_LOGGER
from app.db.errors import is_retryable_conflict
from app.domain.errors import AppointmentNotFound, ConcurrentUpdate, DateOutOfRange
from app.repositories import appointments as appt_repo
from app.repositories import reminders as reminder_repo
from app.schemas.problem import problem_responses
from app.schemas.reminder import (
    ClaimedReminder,
    EmailBudget,
    EmailRelease,
    EmailReservation,
    ReminderBatch,
    ReminderSent,
    ReminderSentRequest,
)

router = APIRouter(prefix="/internal", tags=["reminders"], responses=problem_responses(401, 403))

_NO_STORE = {"Cache-Control": "no-store"}
_log = logging.getLogger(APP_LOGGER)
# Which cap was reported as used up (and for which day or month): each is logged once per process.
_spent_logged: set[tuple[str, date]] = set()
# Days on which a non-acknowledgement send was held back at the reserve (logged once each).
_held_logged: set[date] = set()


@router.post(
    "/reminders/claim",
    response_model=ReminderBatch,
    dependencies=[Depends(require_system)],
    responses=problem_responses(422),
)
async def claim_reminders(
    response: Response,
    limit: int = Query(default=50, ge=1, le=100),
    on: date | None = Query(
        default=None,
        description="Remind for this clinic-local date, not tomorrow (a rehearsal or a re-run).",
    ),
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    settings: Settings = Depends(get_settings),
) -> ReminderBatch:
    """Claim the appointments due a reminder, with a lease. Each claimed row stays claimed until it
    is marked sent; a claim older than the lease can be taken again by a later run."""
    response.headers.update(_NO_STORE)
    now = clock.now()
    # The date reported back, and the check that a rehearsal names a future day, use the default
    # clinic zone; which appointments are due is decided per clinic, in each clinic's own zone.
    local_today = now.astimezone(default_zone()).date()
    target = on or local_today + timedelta(days=1)
    if target <= local_today:
        raise DateOutOfRange()

    day = now.astimezone(UTC).date()
    month = _month_of(now)
    sent = await reminder_repo.sent_today(session, day)
    month_sent = await reminder_repo.sent_month(session, month)
    await session.rollback()
    budget = max(
        0,
        min(
            # The reserve is a DAY reserve (acknowledgements sent later today); the month has none.
            settings.EMAIL_DAILY_LIMIT - sent - settings.EMAIL_ACK_RESERVE,
            settings.EMAIL_MONTHLY_LIMIT - month_sent,
        ),
    )
    n = min(limit, settings.REMINDER_RUN_LIMIT, budget)
    if n < min(limit, settings.REMINDER_RUN_LIMIT):
        _log.warning(
            "reminder claim limited by the email budget",
            extra={
                "sent_today": sent,
                "sent_this_month": month_sent,
                "allowed": n,
                "daily_limit": settings.EMAIL_DAILY_LIMIT,
                "monthly_limit": settings.EMAIL_MONTHLY_LIMIT,
            },
        )

    rows: list[dict[str, object]] = []
    if n > 0:
        async with session.begin():
            rows = await reminder_repo.claim(
                session,
                now=now,
                lease_cutoff=now - timedelta(minutes=settings.REMINDER_LEASE_MINUTES),
                on_date=on,
                limit=n,
            )
    return ReminderBatch(
        date=target,
        items=[ClaimedReminder.model_validate(r) for r in rows],
        sent_today=sent,
        daily_limit=settings.EMAIL_DAILY_LIMIT,
    )


@router.post(
    "/reminders/{appointment_id}/sent",
    response_model=ReminderSent,
    dependencies=[Depends(require_system)],
    responses=problem_responses(404, 422),
)
async def mark_reminder_sent(
    appointment_id: uuid.UUID,
    body: ReminderSentRequest,
    response: Response,
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
) -> ReminderSent:
    """Record that the email provider accepted this reminder. Called only after a 2xx from it, and
    only for the claim it was sent under: if the appointment was moved or the claim has been
    replaced since, nothing is marked (``sent`` is false) and the reminder stays due."""
    response.headers.update(_NO_STORE)
    if await appt_repo.get_appointment(session, appointment_id) is None:
        await session.rollback()
        raise AppointmentNotFound()
    await session.rollback()
    async with session.begin():
        marked = await reminder_repo.mark_sent(
            session,
            appointment_id=appointment_id,
            claimed_at=body.claimed_at,
            starts_at=body.starts_at,
            now=clock.now(),
        )
    return ReminderSent(appointment_id=appointment_id, sent=marked is not None)


async def _counter_txn[T](session: AsyncSession, fn: Callable[[], Awaitable[T]]) -> T:
    """Run a counter write in a transaction, retrying once on a deadlock or serialization
    failure and then reporting CONCURRENT_UPDATE, as the booking service does. Every counter writer
    takes its row locks in one order (see ``_month_then_day``), so this is defence in depth, not
    the fix."""
    for attempt in range(2):
        try:
            async with session.begin():
                return await fn()
        except DBAPIError as exc:
            if not is_retryable_conflict(exc):
                raise
            if attempt == 0:
                await asyncio.sleep(random.uniform(0.02, 0.08))  # noqa: S311  # jitter, not crypto
                continue
            raise ConcurrentUpdate() from exc
    raise ConcurrentUpdate()


def _month_of(moment: datetime) -> date:
    utc = moment.astimezone(UTC)
    return date(utc.year, utc.month, 1)


def _budget(day: date, month: date, sent: int, month_sent: int, settings: Settings) -> EmailBudget:
    return EmailBudget(
        day=day,
        sent=sent,
        daily_limit=settings.EMAIL_DAILY_LIMIT,
        month=month,
        month_sent=month_sent,
        monthly_limit=settings.EMAIL_MONTHLY_LIMIT,
        remaining=max(
            0,
            min(settings.EMAIL_DAILY_LIMIT - sent, settings.EMAIL_MONTHLY_LIMIT - month_sent),
        ),
    )


async def _current(session: AsyncSession, now: datetime, settings: Settings) -> EmailBudget:
    day, month = now.astimezone(UTC).date(), _month_of(now)
    sent = await reminder_repo.sent_today(session, day)
    month_sent = await reminder_repo.sent_month(session, month)
    return _budget(day, month, sent, month_sent, settings)


@router.get(
    "/emails/today",
    response_model=EmailBudget,
    dependencies=[Depends(require_identity)],
)
async def emails_today(
    response: Response,
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    settings: Settings = Depends(get_settings),
) -> EmailBudget:
    response.headers.update(_NO_STORE)
    budget = await _current(session, clock.now(), settings)
    await session.rollback()
    return budget


@router.post(
    "/emails/reserve",
    response_model=EmailReservation,
    dependencies=[Depends(require_identity)],
)
async def reserve_email(
    response: Response,
    purpose: Annotated[
        Literal["ack", "other"],
        Query(
            description=(
                "`ack`: a booking acknowledgement, which may use the whole day. `other` (the "
                "default): any other email (reminders, staff emails, the doctor's arrival email); "
                "its day stops EMAIL_ACK_RESERVE short of EMAIL_DAILY_LIMIT, so the room kept "
                "for acknowledgements cannot be used up by them. The month has no reserve. It is "
                "optional, and defaults to `other`, so a caller that does not say (the patient "
                "app during a rollout, before it sends `ack`) is held back from the reserve "
                "rather than allowed to spend it: the safe direction."
            )
        ),
    ] = "other",
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    settings: Settings = Depends(get_settings),
) -> EmailReservation:
    """Take one email from the day's and the month's allowance before sending it, atomically: under
    any number of concurrent senders the caps are never exceeded. A refusal is a normal answer
    (``granted`` false and the cap that said no), not an error: the caller just does not send."""
    response.headers.update(_NO_STORE)
    now = clock.now()
    day, month = now.astimezone(UTC).date(), _month_of(now)
    held_back = settings.EMAIL_ACK_RESERVE if purpose == "other" else 0
    reason = await _counter_txn(
        session,
        lambda: reminder_repo.reserve(
            session,
            day=day,
            month=month,
            day_cap=settings.EMAIL_DAILY_LIMIT - held_back,
            month_cap=settings.EMAIL_MONTHLY_LIMIT,
        ),
    )
    budget = await _current(session, now, settings)
    await session.rollback()
    if reason == "day" and purpose == "other" and budget.sent < settings.EMAIL_DAILY_LIMIT:
        # Not used up: the last EMAIL_ACK_RESERVE of the day are held back for acknowledgements.
        if day not in _held_logged:
            _held_logged.add(day)
            _log.info(
                "email held back for acknowledgements: the rest of the day is kept for them",
                extra={"sent_today": budget.sent, "reserve": settings.EMAIL_ACK_RESERVE},
            )
    elif reason is not None and (reason, month if reason == "month" else day) not in _spent_logged:
        _spent_logged.add((reason, month if reason == "month" else day))
        _log.warning(
            "email allowance used up for the %s: no more email until it resets",
            reason,
            extra={
                "daily_limit": settings.EMAIL_DAILY_LIMIT,
                "monthly_limit": settings.EMAIL_MONTHLY_LIMIT,
            },
        )
    return EmailReservation(
        granted=reason is None,
        reason="day" if reason == "day" else "month" if reason == "month" else None,
        day=day,
        month=month,
        budget=budget,
    )


@router.post(
    "/emails/release",
    response_model=EmailBudget,
    dependencies=[Depends(require_identity)],
)
async def release_email(
    body: EmailRelease,
    response: Response,
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    settings: Settings = Depends(get_settings),
) -> EmailBudget:
    """Give back one reserved email whose send failed, so a failure does not use the allowance."""
    response.headers.update(_NO_STORE)
    await _counter_txn(
        session, lambda: reminder_repo.release(session, day=body.day, month=body.month)
    )
    budget = await _current(session, clock.now(), settings)
    await session.rollback()
    return budget
