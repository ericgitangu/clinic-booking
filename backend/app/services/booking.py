from __future__ import annotations

import asyncio
import random
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import Clock
from app.core.config import Settings
from app.db.errors import is_retryable_conflict
from app.domain.booking_rules import validate_slot
from app.domain.errors import (
    AppointmentAlreadyCancelled,
    AppointmentAlreadyStarted,
    AppointmentNotFound,
    ConcurrentUpdate,
    PatientDoubleBooked,
    SlotTaken,
    UnknownDoctor,
    UnknownPatient,
)
from app.domain.events import booked_event, cancelled_event, rescheduled_event
from app.domain.idempotency import check_replay, request_fingerprint
from app.domain.slots import SLOT
from app.models.appointment import Appointment
from app.repositories import appointments as appt_repo
from app.repositories import doctors as doctor_repo
from app.repositories import events as event_repo
from app.repositories import patients as patient_repo
from app.repositories.errors import IdempotencyKeyRaced, map_integrity_error


@dataclass(frozen=True)
class Booked:
    appointment: Appointment
    # True when an Idempotency-Key matched an earlier booking and that booking is returned as is.
    replayed: bool = False


async def _after_write(session: AsyncSession) -> None:
    """No-op seam called after a write and before commit. Race tests monkeypatch this to
    inject a `pg_sleep` that widens the contention window; production keeps the no-op."""
    return None


async def _run_txn[T](session: AsyncSession, fn: Callable[[], Awaitable[T]]) -> T:
    """Run a write transaction, retrying once on a deadlock or serialization failure.

    The asyncpg dialect raises those as a plain ``DBAPIError``, so the decision is made on the
    SQLSTATE. A conflict that survives the retry is reported as CONCURRENT_UPDATE; every other
    database error propagates unchanged (outages become 503, anything else 500).
    """
    for attempt in range(2):
        try:
            async with session.begin():
                return await fn()
        except IntegrityError as exc:
            # Unique violations are deterministic: map, never retry.
            raise map_integrity_error(exc) from exc
        except DBAPIError as exc:
            if not is_retryable_conflict(exc):
                raise
            if attempt == 0:
                await asyncio.sleep(random.uniform(0.02, 0.08))  # noqa: S311  # jitter, not crypto
                continue
            raise ConcurrentUpdate() from exc
    raise ConcurrentUpdate()


async def _clinic_tz(
    session: AsyncSession, doctor_id: uuid.UUID, *, require_active: bool = True
) -> ZoneInfo:
    # Reschedule requires the doctor to still be active (else UNKNOWN_DOCTOR);
    # cancel does not (you can always cancel, even if the doctor was since deactivated).
    doctor = (
        await doctor_repo.get_active_doctor(session, doctor_id)
        if require_active
        else await doctor_repo.get_doctor(session, doctor_id)
    )
    if doctor is None:
        raise UnknownDoctor()
    clinic = await doctor_repo.get_clinic(session, doctor.clinic_id)
    if clinic is None:
        raise UnknownDoctor()
    return ZoneInfo(clinic.timezone)


async def _replay(
    session: AsyncSession, patient_id: uuid.UUID, key: str, fingerprint: str
) -> Appointment | None:
    """The appointment this key already created for this patient, if any.

    Raises IDEMPOTENCY_KEY_REUSED for a different payload and IDEMPOTENCY_KEY_CONSUMED once the
    appointment has left ``booked``; the stored row is otherwise the replay.
    """
    stored = await appt_repo.get_by_idempotency_key(session, patient_id, key)
    if stored is None:
        return None
    # Both columns are set together (ck_appt_idempotency_pair), so a row found by key has a
    # fingerprint.
    check_replay(
        stored_fingerprint=stored.request_fingerprint or "",
        stored_status=stored.status,
        fingerprint=fingerprint,
    )
    return stored


async def book(
    session: AsyncSession,
    clock: Clock,
    settings: Settings,
    *,
    doctor_id: uuid.UUID,
    patient_id: uuid.UUID,
    starts_at: datetime,
    idempotency_key: str | None = None,
) -> Booked:
    lead = timedelta(minutes=settings.BOOKING_MIN_LEAD_MINUTES)
    fingerprint = request_fingerprint(doctor_id, starts_at) if idempotency_key is not None else None

    async def _do() -> Booked:
        # Replays are answered before any validation: a retry after the slot has since passed
        # or been rescheduled still gets the booking it made.
        if idempotency_key is not None and fingerprint is not None:
            prior = await _replay(session, patient_id, idempotency_key, fingerprint)
            if prior is not None:
                return Booked(prior, replayed=True)
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
            timezone=clinic.timezone,
            idempotency_key=idempotency_key,
            request_fingerprint=fingerprint,
        )
        await event_repo.insert_event(
            session,
            appointment_id=appt.id,
            doctor_id=doctor_id,
            fields=booked_event(starts_at, tz),
        )
        await _after_write(session)
        return Booked(appt)

    try:
        return await _run_txn(session, _do)
    except (SlotTaken, PatientDoubleBooked, IdempotencyKeyRaced) as conflict:
        if idempotency_key is None or fingerprint is None:
            if isinstance(conflict, IdempotencyKeyRaced):  # pragma: no cover - needs a key
                raise ConcurrentUpdate() from conflict
            raise
        # Step 2: on any unique violation re-check the key before reporting a conflict.
        # Postgres may name the doctor-slot index first even when the real cause is a duplicate
        # of this very request, and a lost response must never read as "your slot was taken".
        async with session.begin():
            winner = await _replay(session, patient_id, idempotency_key, fingerprint)
        if winner is not None:
            return Booked(winner, replayed=True)
        if isinstance(conflict, IdempotencyKeyRaced):
            # The key row existed a moment ago and cannot have been removed (no DELETE grant).
            raise ConcurrentUpdate() from conflict  # pragma: no cover
        raise


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
        tz = await _clinic_tz(session, appt.doctor_id, require_active=False)
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
        # The new time gets its own reminder.
        appt.reminder_claimed_at = None
        appt.reminder_sent_at = None
        await event_repo.insert_event(
            session,
            appointment_id=appt.id,
            doctor_id=appt.doctor_id,
            fields=rescheduled_event(old_starts, new_starts_at, tz),
        )
        await _after_write(session)
        return appt

    return await _run_txn(session, _do)
