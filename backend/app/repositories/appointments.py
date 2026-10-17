from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.appointment import Appointment
from app.models.doctor import Doctor


async def get_appointment(session: AsyncSession, appointment_id: uuid.UUID) -> Appointment | None:
    result = await session.execute(select(Appointment).where(Appointment.id == appointment_id))
    return result.scalar_one_or_none()


async def get_for_update(session: AsyncSession, appointment_id: uuid.UUID) -> Appointment | None:
    result = await session.execute(
        select(Appointment).where(Appointment.id == appointment_id).with_for_update()
    )
    return result.scalar_one_or_none()


async def get_by_idempotency_key(
    session: AsyncSession, patient_id: uuid.UUID, key: str
) -> Appointment | None:
    result = await session.execute(
        select(Appointment).where(
            Appointment.patient_id == patient_id, Appointment.idempotency_key == key
        )
    )
    return result.scalar_one_or_none()


async def booked_starts_for_doctor(
    session: AsyncSession,
    doctor_id: uuid.UUID,
    day_start_utc: datetime,
    next_day_start_utc: datetime,
) -> list[datetime]:
    result = await session.execute(
        select(Appointment.starts_at).where(
            Appointment.doctor_id == doctor_id,
            Appointment.status == "booked",
            Appointment.starts_at >= day_start_utc,
            Appointment.starts_at < next_day_start_utc,
        )
    )
    return list(result.scalars().all())


async def insert_appointment(
    session: AsyncSession,
    *,
    doctor_id: uuid.UUID,
    patient_id: uuid.UUID,
    starts_at: datetime,
    ends_at: datetime,
    idempotency_key: str | None = None,
    request_fingerprint: str | None = None,
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
    )
    session.add(appt)
    await session.flush()
    return appt


async def upcoming_for_patient(
    session: AsyncSession, patient_id: uuid.UUID, now: datetime, limit: int
) -> list[tuple[Appointment, Doctor]]:
    # One JOIN, no N+1.
    result = await session.execute(
        select(Appointment, Doctor)
        .join(Doctor, Doctor.id == Appointment.doctor_id)
        .where(
            Appointment.patient_id == patient_id,
            Appointment.status == "booked",
            Appointment.starts_at > now,
        )
        .order_by(Appointment.starts_at, Appointment.id)
        .limit(limit)
    )
    return [(row[0], row[1]) for row in result.all()]
