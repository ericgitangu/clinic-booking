"""Staff writes on appointments: book, move, cancel, veto, unlock.

These call the same booking service as the patient routes, with a ``StaffAction`` that lifts the
lead-time rule and records who acted and why. The audit row is written by the service inside the
transaction of the change.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.assertion import Principal
from app.core.clock import Clock
from app.core.config import Settings
from app.domain.attendance import Attendance
from app.domain.emailnorm import normalize_email
from app.domain.errors import (
    AppointmentNotFound,
    DoctorNotFound,
    NothingToVeto,
    PatientDoubleBooked,
    SlotTaken,
    UnknownPatient,
)
from app.domain.staff import StaffAction, StaffActionName
from app.models.appointment import Appointment
from app.repositories import appointments as appt_repo
from app.repositories import doctors as doctor_repo
from app.repositories import events as event_repo
from app.repositories import patients as patient_repo
from app.schemas.appointment import Appointment as AppointmentOut
from app.schemas.staff import StaffAppointmentChange, StaffCreateAppointment
from app.services import booking


def _ctx(
    actor: Principal, action: StaffActionName, reason: str, *, lock: bool = False
) -> StaffAction:
    return StaffAction(
        action=action,
        actor_email=normalize_email(actor.email),
        actor_role=actor.role,
        reason=reason,
        lock=lock,
    )


async def _change(
    session: AsyncSession, appt: Appointment, ctx: StaffAction
) -> StaffAppointmentChange:
    """The response: the appointment plus what the web app needs to tell the patient."""
    patient = await patient_repo.get_patient(session, appt.patient_id)
    doctor = await doctor_repo.get_doctor(session, appt.doctor_id)
    if patient is None:  # pragma: no cover - a foreign key guarantees the row
        raise UnknownPatient()
    if doctor is None:  # pragma: no cover - a foreign key guarantees the row
        raise DoctorNotFound()
    change = StaffAppointmentChange(
        **AppointmentOut.model_validate(appt).model_dump(),
        audit_id=ctx.audit_id,
        patient_name=patient.full_name,
        patient_email=patient.email,
        doctor_name=doctor.full_name,
        previous_starts_at=ctx.previous_starts_at,
    )
    await session.rollback()  # end the read transaction the lookups began (values are copied)
    return change


async def create(
    session: AsyncSession,
    clock: Clock,
    settings: Settings,
    *,
    actor: Principal,
    body: StaffCreateAppointment,
) -> StaffAppointmentChange:
    ctx = _ctx(actor, "book", body.reason)
    booked = await booking.book(
        session,
        clock,
        settings,
        doctor_id=body.doctor_id,
        patient_id=body.patient_id,
        new_patient=body.patient,
        starts_at=body.starts_at,
        staff=ctx,
    )
    return await _change(session, booked.appointment, ctx)


async def cancel(
    session: AsyncSession,
    clock: Clock,
    settings: Settings,
    *,
    actor: Principal,
    appointment_id: uuid.UUID,
    reason: str,
) -> StaffAppointmentChange:
    ctx = _ctx(actor, "cancel", reason)
    appt = await booking.cancel(
        session, clock, settings, appointment_id=appointment_id, reason=reason, staff=ctx
    )
    return await _change(session, appt, ctx)


async def reschedule(
    session: AsyncSession,
    clock: Clock,
    settings: Settings,
    *,
    actor: Principal,
    appointment_id: uuid.UUID,
    starts_at: datetime,
    reason: str,
) -> StaffAppointmentChange:
    ctx = _ctx(actor, "reschedule", reason)
    appt = await booking.reschedule(
        session,
        clock,
        settings,
        appointment_id=appointment_id,
        new_starts_at=starts_at,
        staff=ctx,
    )
    return await _change(session, appt, ctx)


async def veto(
    session: AsyncSession,
    clock: Clock,
    settings: Settings,
    *,
    actor: Principal,
    appointment_id: uuid.UUID,
    reason: str,
) -> StaffAppointmentChange:
    """Undo the patient's latest change with the existing actions, then lock the appointment.

    A reschedule is moved back to where it was (same row; the lock is set in the same
    transaction). A cancel is undone by booking the same slot again as a NEW appointment that
    points at the cancelled one and starts locked; the old row stays cancelled.
    """
    appt = await appt_repo.get_appointment(session, appointment_id)
    if appt is None:
        raise AppointmentNotFound()
    owner = await patient_repo.get_patient(session, appt.patient_id)
    if owner is None or owner.synthetic:
        raise AppointmentNotFound()
    latest = await event_repo.latest_event(session, appointment_id)
    successor = await appt_repo.has_successor(session, appointment_id)
    doctor_id, patient_id = appt.doctor_id, appt.patient_id  # read before the rollback expires it
    await session.rollback()  # end the read transaction before the write opens its own
    # Only a change recorded as the patient's can be vetoed. A NULL actor is an event from before
    # actors were recorded: it cannot be shown to be the patient's, so it is left alone.
    if (
        latest is None
        or latest["actor"] != "patient"
        or latest["event_type"] == "booked"
        or successor
    ):
        raise NothingToVeto()
    ctx = _ctx(actor, "veto", reason, lock=True)
    if latest["event_type"] == "rescheduled":
        moved = await booking.reschedule(
            session,
            clock,
            settings,
            appointment_id=appointment_id,
            new_starts_at=latest["from_starts_at"],
            staff=ctx,
            expect_event_id=latest["id"],
        )
        return await _change(session, moved, ctx)
    start = latest["from_starts_at"]
    try:
        booked = await booking.book(
            session,
            clock,
            settings,
            doctor_id=doctor_id,
            patient_id=patient_id,
            starts_at=start,
            staff=ctx,
            predecessor_id=appointment_id,
        )
    except (SlotTaken, PatientDoubleBooked):
        # If this patient already holds the slot again (a concurrent veto, a staff re-booking) the
        # cancel is already undone: there is nothing left to veto. Anyone else holding it is a
        # real conflict.
        held = await appt_repo.booked_same_slot(session, doctor_id, patient_id, start)
        await session.rollback()
        if held:
            raise NothingToVeto() from None
        raise
    ctx.previous_starts_at = latest["from_starts_at"]
    return await _change(session, booked.appointment, ctx)


async def unlock(
    session: AsyncSession,
    clock: Clock,
    *,
    actor: Principal,
    appointment_id: uuid.UUID,
    reason: str,
) -> StaffAppointmentChange:
    ctx = _ctx(actor, "unlock", reason)
    appt = await booking.unlock(session, clock, appointment_id=appointment_id, staff=ctx)
    return await _change(session, appt, ctx)


async def attendance(
    session: AsyncSession,
    clock: Clock,
    *,
    actor: Principal,
    appointment_id: uuid.UUID,
    kind: Attendance,
    reason: str | None,
) -> StaffAppointmentChange:
    ctx = _ctx(actor, kind, reason or "")
    appt = await booking.mark_attendance(
        session, clock, appointment_id=appointment_id, kind=kind, staff=ctx
    )
    return await _change(session, appt, ctx)
