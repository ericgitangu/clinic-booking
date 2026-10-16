from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.clinic import Clinic
from app.models.doctor import Doctor
from app.models.working_hours import WorkingHours


async def list_active_doctors(session: AsyncSession) -> list[Doctor]:
    result = await session.execute(
        select(Doctor).where(Doctor.is_active).order_by(Doctor.full_name)
    )
    return list(result.scalars().all())


async def get_active_doctor(session: AsyncSession, doctor_id: uuid.UUID) -> Doctor | None:
    result = await session.execute(select(Doctor).where(Doctor.id == doctor_id, Doctor.is_active))
    return result.scalar_one_or_none()


async def get_clinic(session: AsyncSession, clinic_id: uuid.UUID) -> Clinic | None:
    result = await session.execute(select(Clinic).where(Clinic.id == clinic_id))
    return result.scalar_one_or_none()


async def working_hours_for(session: AsyncSession, doctor_id: uuid.UUID) -> list[WorkingHours]:
    result = await session.execute(
        select(WorkingHours)
        .where(WorkingHours.doctor_id == doctor_id)
        .order_by(WorkingHours.weekday, WorkingHours.start_time)
    )
    return list(result.scalars().all())


async def all_working_hours_active(session: AsyncSession) -> list[WorkingHours]:
    result = await session.execute(
        select(WorkingHours)
        .join(Doctor, Doctor.id == WorkingHours.doctor_id)
        .where(Doctor.is_active)
        .order_by(WorkingHours.weekday, WorkingHours.start_time)
    )
    return list(result.scalars().all())
