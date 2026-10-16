from __future__ import annotations

import asyncio
import random
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import Clock
from app.core.config import Settings
from app.domain.booking_rules import validate_slot
from app.domain.errors import (
    AppointmentAlreadyCancelled,
    AppointmentAlreadyStarted,
    AppointmentNotFound,
    ConcurrentUpdate,
    UnknownDoctor,
    UnknownPatient,
)
from app.domain.events import booked_event, cancelled_event, rescheduled_event
from app.models.appointment import Appointment
from app.repositories import appointments as appt_repo
from app.repositories import doctors as doctor_repo
from app.repositories import events as event_repo
from app.repositories import patients as patient_repo
from app.repositories.errors import is_retryable_conflict, map_integrity_error

SLOT = timedelta(minutes=30)


async def _after_write(session: AsyncSession) -> None:
    """No-op seam called after a write and before commit. Race tests monkeypatch this to
    inject a `pg_sleep` that widens the contention window; production keeps the no-op."""
    return None


async def _run_txn(session: AsyncSession, fn: Callable[[], Awaitable[Appointment]]) -> Appointment:
    """Run a write transaction, retrying once on a serialization/deadlock conflict."""
    for attempt in range(2):
        try:
            async with session.begin():
                return await fn()
        except IntegrityError as exc:
            # Unique violations are deterministic: map, never retry.
            raise map_integrity_error(exc) from exc
        except OperationalError as exc:
            if is_retryable_conflict(exc) and attempt == 0:
                await asyncio.sleep(random.uniform(0.02, 0.08))  # noqa: S311  # jitter, not crypto
                continue
            raise ConcurrentUpdate() from exc
    raise ConcurrentUpdate()


async def _clinic_tz(session: AsyncSession, doctor_id: uuid.UUID) -> ZoneInfo:
    doctor = await doctor_repo.get_active_doctor(session, doctor_id)
    if doctor is None:
        raise UnknownDoctor()
    clinic = await doctor_repo.get_clinic(session, doctor.clinic_id)
    if clinic is None:
        raise UnknownDoctor()
    return ZoneInfo(clinic.timezone)


async def book(
    session: AsyncSession,
    clock: Clock,
    settings: Settings,
    *,
    doctor_id: uuid.UUID,
    patient_id: uuid.UUID,
    starts_at: datetime,
) -> Appointment:
    lead = timedelta(minutes=settings.BOOKING_MIN_LEAD_MINUTES)

    async def _do() -> Appointment:
        doctor = await doctor_repo.get_active_doctor(session, doctor_id)
        if doctor is None:
            raise UnknownDoctor()
        if await patient_repo.get_patient(session, patient_id) is None:
            raise UnknownPatient()
        clinic = await doctor_repo.get_clinic(session, doctor.clinic_id)
        if clinic is None:
            raise UnknownDoctor()
        tz = ZoneInfo(clinic.timezone)
        weekday = starts_at.astimezone(tz).isoweekday()
        windows = [
            (wh.start_time, wh.end_time)
            for wh in await doctor_repo.working_hours_for(session, doctor_id)
            if wh.weekday == weekday
        ]
        validate_slot(starts_at, windows, tz, clock.now(), lead, settings.BOOKING_HORIZON_DAYS)
        appt = await appt_repo.insert_appointment(
            session,
            doctor_id=doctor_id,
            patient_id=patient_id,
            starts_at=starts_at,
            ends_at=starts_at + SLOT,
        )
        await event_repo.insert_event(
            session,
            appointment_id=appt.id,
            doctor_id=doctor_id,
            fields=booked_event(starts_at, tz),
        )
        await _after_write(session)
        return appt

    return await _run_txn(session, _do)


async def cancel(
    session: AsyncSession,
    clock: Clock,
    *,
    appointment_id: uuid.UUID,
    reason: str,
) -> Appointment:
    async def _do() -> Appointment:
        appt = await appt_repo.get_for_update(session, appointment_id)
        if appt is None:
            raise AppointmentNotFound()
        if appt.status == "cancelled":
            raise AppointmentAlreadyCancelled()
        now = clock.now()
        if appt.starts_at <= now:
            raise AppointmentAlreadyStarted()
        tz = await _clinic_tz(session, appt.doctor_id)
        appt.status = "cancelled"
        appt.cancelled_at = now
        appt.cancellation_reason = reason
        appt.updated_at = now
        await event_repo.insert_event(
            session,
            appointment_id=appt.id,
            doctor_id=appt.doctor_id,
            fields=cancelled_event(appt.starts_at, tz),
        )
        await _after_write(session)
        return appt

    return await _run_txn(session, _do)


async def reschedule(
    session: AsyncSession,
    clock: Clock,
    settings: Settings,
    *,
    appointment_id: uuid.UUID,
    new_starts_at: datetime,
) -> Appointment:
    lead = timedelta(minutes=settings.BOOKING_MIN_LEAD_MINUTES)

    async def _do() -> Appointment:
        appt = await appt_repo.get_for_update(session, appointment_id)
        if appt is None:
            raise AppointmentNotFound()
        if appt.status == "cancelled":
            raise AppointmentAlreadyCancelled()
        now = clock.now()
        if appt.starts_at <= now:
            raise AppointmentAlreadyStarted()
        if appt.starts_at == new_starts_at:
            return appt  # same-start no-op
        tz = await _clinic_tz(session, appt.doctor_id)
        weekday = new_starts_at.astimezone(tz).isoweekday()
        windows = [
            (wh.start_time, wh.end_time)
            for wh in await doctor_repo.working_hours_for(session, appt.doctor_id)
            if wh.weekday == weekday
        ]
        validate_slot(new_starts_at, windows, tz, now, lead, settings.BOOKING_HORIZON_DAYS)
        old_starts = appt.starts_at
        appt.starts_at = new_starts_at
        appt.ends_at = new_starts_at + SLOT
        appt.updated_at = now
        await event_repo.insert_event(
            session,
            appointment_id=appt.id,
            doctor_id=appt.doctor_id,
            fields=rescheduled_event(old_starts, new_starts_at, tz),
        )
        await _after_write(session)
        return appt

    return await _run_txn(session, _do)
