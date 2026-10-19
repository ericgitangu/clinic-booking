from __future__ import annotations

import asyncio
import random
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import Clock
from app.core.config import Settings
from app.db.errors import is_retryable_conflict
from app.domain.attendance import Attendance, window_is_open
from app.domain.booking_rules import require_lead_time, validate_slot
from app.domain.errors import (
    AppointmentAlreadyCancelled,
    AppointmentAlreadyStarted,
    AppointmentLocked,
    AppointmentNotFound,
    AttendanceWindowClosed,
    ChangeTooLate,
    ConcurrentUpdate,
    NothingToVeto,
    PatientDoubleBooked,
    ReasonRequired,
    SlotTaken,
    UnknownDoctor,
    UnknownPatient,
)
from app.domain.events import (
    annotation_event,
    booked_event,
    cancelled_event,
    rescheduled_event,
)
from app.domain.idempotency import check_replay, request_fingerprint
from app.domain.slots import SLOT
from app.domain.staff import StaffAction
from app.models.appointment import Appointment
from app.repositories import appointments as appt_repo
from app.repositories import doctors as doctor_repo
from app.repositories import events as event_repo
from app.repositories import patients as patient_repo
from app.repositories import staff as staff_repo
from app.repositories.errors import IdempotencyKeyRaced, map_integrity_error
from app.schemas.patient import PatientCreate


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


async def _staff_may_touch(
    session: AsyncSession, patient_id: uuid.UUID, staff: StaffAction | None
) -> None:
    """Staff do not act on the release pipeline's synthetic patients: the admin views never show
    them, so an id for one is answered as an appointment that does not exist."""
    if staff is None:
        return
    patient = await patient_repo.get_patient(session, patient_id)
    if patient is None or patient.synthetic:
        raise AppointmentNotFound()


def _actor(staff: StaffAction | None) -> str:
    return "staff" if staff is not None else "patient"


async def _audit(
    session: AsyncSession,
    staff: StaffAction,
    *,
    appointment_id: uuid.UUID,
    before: dict[str, object],
    after: dict[str, object],
) -> None:
    """The staff audit row, in the transaction of the change it describes. The jsonb carries ids,
    statuses and instants only: never a patient's name, phone or email."""
    staff.audit_id = await staff_repo.insert_audit(
        session,
        actor_email=staff.actor_email,
        actor_role=staff.actor_role,
        action=staff.action,
        appointment_id=appointment_id,
        reason=staff.reason,
        before=before,
        after=after,
    )


async def _annotate(
    session: AsyncSession, appt: Appointment, event_type: str, staff: StaffAction
) -> None:
    """A staff annotation on the event stream, in the transaction of the change it describes."""
    tz = await _clinic_tz(session, appt.doctor_id, require_active=False)
    await event_repo.insert_event(
        session,
        appointment_id=appt.id,
        doctor_id=appt.doctor_id,
        fields=annotation_event(event_type, appt.starts_at, tz),
        actor=_actor(staff),
    )


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
    patient_id: uuid.UUID | None = None,
    new_patient: PatientCreate | None = None,
    starts_at: datetime,
    idempotency_key: str | None = None,
    staff: StaffAction | None = None,
    predecessor_id: uuid.UUID | None = None,
) -> Booked:
    """Book a slot. Exactly one of ``patient_id`` and ``new_patient`` (staff only: the patient row
    is created in the same transaction, so a refused booking leaves no orphan patient).

    ``staff`` lifts the lead-time rule and nothing else: SLOT_IN_PAST, working hours, SLOT_TAKEN and
    PATIENT_DOUBLE_BOOKED still apply. ``predecessor_id`` links a booking that undoes a cancel.
    """
    if (patient_id is None) == (new_patient is None) or (new_patient and staff is None):
        raise ValueError("book needs a patient_id, or new_patient from staff")
    if idempotency_key is not None and patient_id is None:
        raise ValueError("an Idempotency-Key needs a patient_id")
    key_patient = patient_id
    lead = (
        timedelta(0)
        if staff and staff.lead_exempt
        else timedelta(minutes=settings.BOOKING_MIN_LEAD_MINUTES)
    )
    fingerprint = request_fingerprint(doctor_id, starts_at) if idempotency_key is not None else None

    async def _do() -> Booked:
        nonlocal patient_id
        # Replays are answered before any validation: a retry after the slot has since passed
        # or been rescheduled still gets the booking it made.
        if idempotency_key is not None and fingerprint is not None and key_patient is not None:
            prior = await _replay(session, key_patient, idempotency_key, fingerprint)
            if prior is not None:
                return Booked(prior, replayed=True)
        doctor = await doctor_repo.get_active_doctor(session, doctor_id)
        if doctor is None:
            raise UnknownDoctor()
        if new_patient is not None:
            email = str(new_patient.email) if new_patient.email is not None else None
            same = await patient_repo.find_same_person(
                session, full_name=new_patient.full_name, phone=new_patient.phone, email=email
            )
            if same is not None:
                patient_id = same.id  # a repeated submit: the same person, not a second row
            else:
                created = await patient_repo.insert_patient(
                    session,
                    full_name=new_patient.full_name,
                    phone=new_patient.phone,
                    email=email,
                )
                patient_id = created.id
        elif patient_id is None:
            raise UnknownPatient()
        else:
            existing = await patient_repo.get_patient(session, patient_id)
            if existing is None or (staff is not None and existing.synthetic):
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
        if predecessor_id is not None:
            # A veto of a cancel decides from reads taken before this transaction; decide again
            # here, under the cancelled row's lock, so two vetoes (or a veto and a staff
            # re-booking) cannot both go ahead.
            predecessor = await appt_repo.get_for_update(session, predecessor_id)
            latest = await event_repo.latest_event(session, predecessor_id)
            if (
                predecessor is None
                or predecessor.status != "cancelled"
                or latest is None
                or latest["event_type"] != "cancelled"
                or latest["actor"] != "patient"
                or await appt_repo.has_successor(session, predecessor_id)
            ):
                raise NothingToVeto()
        if (
            staff is None
            and patient_id is not None
            and await appt_repo.locked_booking_exists(session, doctor_id, patient_id, starts_at)
        ):
            # Staff vetoed this patient's cancel and re-booked the slot locked: the patient
            # trying to take it again is a change on that lineage, not a lost race.
            raise AppointmentLocked()
        appt = await appt_repo.insert_appointment(
            session,
            doctor_id=doctor_id,
            patient_id=patient_id,
            starts_at=starts_at,
            ends_at=starts_at + SLOT,
            timezone=clinic.timezone,
            idempotency_key=idempotency_key,
            request_fingerprint=fingerprint,
            predecessor_id=predecessor_id,
            staff_locked_at=clock.now() if staff and staff.lock else None,
        )
        await event_repo.insert_event(
            session,
            appointment_id=appt.id,
            doctor_id=doctor_id,
            fields=booked_event(starts_at, tz),
            actor=_actor(staff),
        )
        if staff is not None:
            await _audit(
                session,
                staff,
                appointment_id=appt.id,
                before={"status": "cancelled", "appointment_id": str(predecessor_id)}
                if predecessor_id
                else {},
                after={
                    "status": "booked",
                    "starts_at": starts_at.astimezone(UTC).isoformat(),
                    "doctor_id": str(doctor_id),
                    "patient_id": str(patient_id),
                    "locked": appt.staff_locked_at is not None,
                },
            )
            if staff.action == "veto":
                await _annotate(session, appt, "vetoed", staff)
        await _after_write(session)
        return Booked(appt)

    try:
        return await _run_txn(session, _do)
    except (SlotTaken, PatientDoubleBooked, IdempotencyKeyRaced) as conflict:
        if idempotency_key is None or fingerprint is None or key_patient is None:
            if isinstance(conflict, IdempotencyKeyRaced):  # pragma: no cover - needs a key
                raise ConcurrentUpdate() from conflict
            raise
        # Step 2: on any unique violation re-check the key before reporting a conflict.
        # Postgres may name the doctor-slot index first even when the real cause is a duplicate
        # of this very request, and a lost response must never read as "your slot was taken".
        async with session.begin():
            winner = await _replay(session, key_patient, idempotency_key, fingerprint)
        if winner is not None:
            return Booked(winner, replayed=True)
        if isinstance(conflict, IdempotencyKeyRaced):
            # The key row existed a moment ago and cannot have been removed (no DELETE grant).
            raise ConcurrentUpdate() from conflict  # pragma: no cover
        raise


async def cancel(
    session: AsyncSession,
    clock: Clock,
    settings: Settings,
    *,
    appointment_id: uuid.UUID,
    reason: str,
    staff: StaffAction | None = None,
) -> Appointment:
    # Staff are exempt from the lead-time rule: a zero lead never refuses a start still ahead.
    lead = (
        timedelta(0)
        if staff and staff.lead_exempt
        else timedelta(minutes=settings.BOOKING_MIN_LEAD_MINUTES)
    )

    async def _do() -> Appointment:
        appt = await appt_repo.get_for_update(session, appointment_id)
        if appt is None:
            raise AppointmentNotFound()
        await _staff_may_touch(session, appt.patient_id, staff)
        if staff is None and appt.staff_locked_at is not None:
            raise AppointmentLocked()
        if appt.status == "cancelled":
            raise AppointmentAlreadyCancelled()
        now = clock.now()
        if appt.starts_at <= now:
            raise AppointmentAlreadyStarted()
        require_lead_time(appt.starts_at, now, lead, ChangeTooLate)
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
            actor=_actor(staff),
        )
        if staff is not None:
            staff.previous_starts_at = appt.starts_at
            await _audit(
                session,
                staff,
                appointment_id=appt.id,
                before={
                    "status": "booked",
                    "starts_at": appt.starts_at.astimezone(UTC).isoformat(),
                },
                after={"status": "cancelled"},
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
    staff: StaffAction | None = None,
    expect_event_id: int | None = None,
) -> Appointment:
    lead = (
        timedelta(0)
        if staff and staff.lead_exempt
        else timedelta(minutes=settings.BOOKING_MIN_LEAD_MINUTES)
    )

    async def _do() -> Appointment:
        appt = await appt_repo.get_for_update(session, appointment_id)
        if appt is None:
            raise AppointmentNotFound()
        await _staff_may_touch(session, appt.patient_id, staff)
        if staff is None and appt.staff_locked_at is not None:
            raise AppointmentLocked()
        if expect_event_id is not None:
            # A veto decided what to undo from the latest event; if another change landed since,
            # undoing the old one would be wrong.
            latest = await event_repo.latest_event(session, appointment_id)
            if latest is None or latest["id"] != expect_event_id:
                if latest is not None and latest["actor"] == "staff":
                    raise NothingToVeto()  # another veto (or a staff move) got there first
                raise ConcurrentUpdate()
        if appt.status == "cancelled":
            raise AppointmentAlreadyCancelled()
        now = clock.now()
        if appt.starts_at <= now:
            raise AppointmentAlreadyStarted()
        if appt.starts_at == new_starts_at:
            return appt  # same-start no-op: a retry of a move that already happened
        require_lead_time(appt.starts_at, now, lead, ChangeTooLate)  # the current time
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
            actor=_actor(staff),
        )
        if staff is not None:
            staff.previous_starts_at = old_starts
            if staff.lock:
                appt.staff_locked_at = now
            await _audit(
                session,
                staff,
                appointment_id=appt.id,
                before={"starts_at": old_starts.astimezone(UTC).isoformat()},
                after={
                    "starts_at": new_starts_at.astimezone(UTC).isoformat(),
                    "locked": appt.staff_locked_at is not None,
                },
            )
            if staff.action == "veto":
                await _annotate(session, appt, "vetoed", staff)
        await _after_write(session)
        return appt

    return await _run_txn(session, _do)


async def unlock(
    session: AsyncSession, clock: Clock, *, appointment_id: uuid.UUID, staff: StaffAction
) -> Appointment:
    """Lift the staff lock so the patient can change the appointment again."""

    async def _do() -> Appointment:
        appt = await appt_repo.get_for_update(session, appointment_id)
        if appt is None:
            raise AppointmentNotFound()
        await _staff_may_touch(session, appt.patient_id, staff)
        if appt.staff_locked_at is None:
            raise NothingToVeto("This appointment is not locked.")
        appt.staff_locked_at = None
        appt.updated_at = clock.now()
        await _audit(
            session,
            staff,
            appointment_id=appt.id,
            before={"locked": True},
            after={"locked": False},
        )
        await _annotate(session, appt, "unlocked", staff)
        return appt

    return await _run_txn(session, _do)


async def mark_attendance(
    session: AsyncSession,
    clock: Clock,
    *,
    appointment_id: uuid.UUID,
    kind: Attendance,
    staff: StaffAction,
) -> Appointment:
    """Record that the patient arrived or did not turn up.

    Only inside the attendance window and only on a booked appointment. Marking what is already
    marked changes nothing (no row, no audit row, ``staff.audit_id`` stays None); changing an
    earlier mark appends a new row and needs a reason (the caller passes ``staff.reason`` empty
    when none was given).
    """

    async def _do() -> Appointment:
        appt = await appt_repo.get_for_update(session, appointment_id)
        if appt is None:
            raise AppointmentNotFound()
        await _staff_may_touch(session, appt.patient_id, staff)
        if appt.status == "cancelled":
            raise AppointmentAlreadyCancelled()
        now = clock.now()
        if not window_is_open(appt.starts_at, now, kind):
            raise AttendanceWindowClosed()
        previous = await staff_repo.latest_attendance(session, appointment_id)
        if previous == kind:
            return appt
        reason = staff.reason.strip()
        if (previous is not None and not reason) or (reason and len(reason) < 3):
            raise ReasonRequired("A reason of at least 3 characters is needed to change a mark.")
        if not reason:
            staff.reason = "Marked arrived at the desk" if kind == "arrived" else "Marked no-show"
        await staff_repo.insert_attendance(
            session, appointment_id=appointment_id, kind=kind, by=staff.actor_email, at=now
        )
        await _audit(
            session,
            staff,
            appointment_id=appt.id,
            before={"attendance": previous},
            after={"attendance": kind},
        )
        await _annotate(session, appt, kind, staff)
        return appt

    return await _run_txn(session, _do)
