from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.appointment import Appointment
from app.models.clinic import Clinic
from app.models.doctor import Doctor

# The zone of the appointment's doctor's clinic, as a column of the same SELECT.
_CLINIC_TZ = (
    select(Clinic.timezone)
    .join(Doctor, Doctor.clinic_id == Clinic.id)
    .where(Doctor.id == Appointment.doctor_id)
    .scalar_subquery()
    .label("clinic_timezone")
)


def _with_zone(rows: Sequence[Any]) -> list[Appointment]:
    out: list[Appointment] = []
    for row in rows:
        appt: Appointment = row[0]
        appt.timezone = str(row[1])
        out.append(appt)
    return out


async def get_appointment(session: AsyncSession, appointment_id: uuid.UUID) -> Appointment | None:
    result = await session.execute(
        select(Appointment, _CLINIC_TZ).where(Appointment.id == appointment_id)
    )
    found = _with_zone(result.all())
    return found[0] if found else None


async def get_for_update(session: AsyncSession, appointment_id: uuid.UUID) -> Appointment | None:
    result = await session.execute(
        select(Appointment, _CLINIC_TZ)
        .where(Appointment.id == appointment_id)
        .with_for_update(of=Appointment)
    )
    found = _with_zone(result.all())
    return found[0] if found else None


async def get_by_idempotency_key(
    session: AsyncSession, patient_id: uuid.UUID, key: str
) -> Appointment | None:
    result = await session.execute(
        select(Appointment, _CLINIC_TZ).where(
            Appointment.patient_id == patient_id, Appointment.idempotency_key == key
        )
    )
    found = _with_zone(result.all())
    return found[0] if found else None


async def booked_intervals_for_doctor(
    session: AsyncSession,
    doctor_id: uuid.UUID,
    day_start_utc: datetime,
    next_day_start_utc: datetime,
) -> list[tuple[datetime, datetime]]:
    """Booked ``(starts_at, ends_at)`` that overlap ``[day_start, next_day_start)``."""
    result = await session.execute(
        select(Appointment.starts_at, Appointment.ends_at).where(
            Appointment.doctor_id == doctor_id,
            Appointment.status == "booked",
            Appointment.starts_at < next_day_start_utc,
            Appointment.ends_at > day_start_utc,
        )
    )
    return [(row[0], row[1]) for row in result.all()]


async def insert_appointment(
    session: AsyncSession,
    *,
    doctor_id: uuid.UUID,
    patient_id: uuid.UUID,
    starts_at: datetime,
    ends_at: datetime,
    timezone: str,
    idempotency_key: str | None = None,
    request_fingerprint: str | None = None,
    predecessor_id: uuid.UUID | None = None,
    staff_locked_at: datetime | None = None,
) -> Appointment:
    appt = Appointment(
        id=uuid.uuid4(),
        doctor_id=doctor_id,
        patient_id=patient_id,
        starts_at=starts_at,
        ends_at=ends_at,
        status="booked",
        idempotency_key=idempotency_key,
        request_fingerprint=request_fingerprint,
        predecessor_id=predecessor_id,
        staff_locked_at=staff_locked_at,
    )
    appt.timezone = timezone
    session.add(appt)
    await session.flush()
    return appt


async def upcoming_for_patient(
    session: AsyncSession, patient_id: uuid.UUID, now: datetime, limit: int
) -> list[tuple[Appointment, Doctor]]:
    """Upcoming bookings with their doctor (one JOIN, no N+1); each carries its clinic zone."""
    result = await session.execute(
        select(Appointment, Doctor, _CLINIC_TZ)
        .join(Doctor, Doctor.id == Appointment.doctor_id)
        .where(
            Appointment.patient_id == patient_id,
            Appointment.status == "booked",
            Appointment.starts_at > now,
        )
        .order_by(Appointment.starts_at, Appointment.id)
        .limit(limit)
    )
    out: list[tuple[Appointment, Doctor]] = []
    for row in result.all():
        appt: Appointment = row[0]
        doctor: Doctor = row[1]
        appt.timezone = str(row[2])
        out.append((appt, doctor))
    return out


async def locked_booking_exists(
    session: AsyncSession, doctor_id: uuid.UUID, patient_id: uuid.UUID, starts_at: datetime
) -> bool:
    """A staff-locked, booked appointment of this patient with this doctor at this time."""
    result = await session.execute(
        select(Appointment.id)
        .where(
            Appointment.doctor_id == doctor_id,
            Appointment.patient_id == patient_id,
            Appointment.starts_at == starts_at,
            Appointment.status == "booked",
            Appointment.staff_locked_at.is_not(None),
        )
        .limit(1)
    )
    return result.first() is not None


async def booked_same_slot(
    session: AsyncSession, doctor_id: uuid.UUID, patient_id: uuid.UUID, starts_at: datetime
) -> bool:
    """The patient already holds a booked appointment with this doctor at this time."""
    result = await session.execute(
        select(Appointment.id)
        .where(
            Appointment.doctor_id == doctor_id,
            Appointment.patient_id == patient_id,
            Appointment.starts_at == starts_at,
            Appointment.status == "booked",
        )
        .limit(1)
    )
    return result.first() is not None


async def has_successor(session: AsyncSession, appointment_id: uuid.UUID) -> bool:
    """True when staff already booked a replacement for this cancelled appointment."""
    result = await session.execute(
        select(Appointment.id).where(Appointment.predecessor_id == appointment_id).limit(1)
    )
    return result.first() is not None
