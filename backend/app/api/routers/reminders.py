"""The scheduled reminder run and the daily email budget, for the web app's server side only.

``/internal/reminders/*`` is for the run itself (it signs as the system caller). The budget
endpoints take any valid assertion, because the acknowledgement emails are sent while a patient's
request is being served and count against the same daily limit.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_clock, get_session, get_settings, require_identity, require_system
from app.core.clock import Clock
from app.core.config import Settings
from app.core.logging import APP_LOGGER
from app.domain.errors import AppointmentNotFound, DateOutOfRange
from app.repositories import admin as admin_repo
from app.repositories import appointments as appt_repo
from app.repositories import reminders as reminder_repo
from app.schemas.problem import problem_responses
from app.schemas.reminder import (
    ClaimedReminder,
    EmailBudget,
    ReminderBatch,
    ReminderSent,
    ReminderSentRequest,
)

router = APIRouter(prefix="/internal", tags=["reminders"], responses=problem_responses(401, 403))

_NO_STORE = {"Cache-Control": "no-store"}
_log = logging.getLogger(APP_LOGGER)
_FALLBACK_TZ = "Africa/Nairobi"


async def _clinic_tz(session: AsyncSession) -> ZoneInfo:
    name = await admin_repo.clinic_timezone(session)
    await session.rollback()
    return ZoneInfo(name or _FALLBACK_TZ)


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
    tz = await _clinic_tz(session)
    local_today = now.astimezone(tz).date()
    target = on or local_today + timedelta(days=1)
    if target <= local_today:
        raise DateOutOfRange()

    sent = await reminder_repo.sent_today(session, now.astimezone(UTC).date())
    await session.rollback()
    # The day's budget minus the room kept for acknowledgements sent later in the day.
    budget = max(0, settings.EMAIL_DAILY_LIMIT - sent - settings.EMAIL_ACK_RESERVE)
    n = min(limit, settings.REMINDER_RUN_LIMIT, budget)
    if n < min(limit, settings.REMINDER_RUN_LIMIT):
        _log.warning(
            "reminder claim limited by the daily email budget",
            extra={"sent_today": sent, "allowed": n, "daily_limit": settings.EMAIL_DAILY_LIMIT},
        )

    rows: list[dict[str, object]] = []
    if n > 0:
        # Tomorrow's run takes everything still to come up to the end of tomorrow, so an appointment
        # whose reminder could not be sent earlier is picked up again while it is still ahead. A
        # rehearsal date (?on=) is exactly that clinic-local day.
        end_of_target = datetime.combine(target, time.min, tzinfo=tz).astimezone(UTC) + timedelta(
            days=1
        )
        window_start = (
            datetime.combine(target, time.min, tzinfo=tz).astimezone(UTC) if on is not None else now
        )
        async with session.begin():
            rows = await reminder_repo.claim(
                session,
                now=now,
                lease_cutoff=now - timedelta(minutes=settings.REMINDER_LEASE_MINUTES),
                day_start=window_start,
                day_end=end_of_target,
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


def _budget(day: date, sent: int, settings: Settings) -> EmailBudget:
    return EmailBudget(
        day=day,
        sent=sent,
        daily_limit=settings.EMAIL_DAILY_LIMIT,
        remaining=max(0, settings.EMAIL_DAILY_LIMIT - sent),
    )


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
    day = clock.now().astimezone(UTC).date()
    sent = await reminder_repo.sent_today(session, day)
    await session.rollback()
    return _budget(day, sent, settings)


@router.post(
    "/emails/record",
    response_model=EmailBudget,
    dependencies=[Depends(require_identity)],
)
async def record_email(
    response: Response,
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    settings: Settings = Depends(get_settings),
) -> EmailBudget:
    """Count one email the provider accepted, for the day (UTC) it was accepted."""
    response.headers.update(_NO_STORE)
    day = clock.now().astimezone(UTC).date()
    async with session.begin():
        sent = await reminder_repo.count_one(session, day)
    return _budget(day, sent, settings)
