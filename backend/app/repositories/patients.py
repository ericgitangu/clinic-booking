from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.patient import Patient


async def get_patient(session: AsyncSession, patient_id: uuid.UUID) -> Patient | None:
    result = await session.execute(select(Patient).where(Patient.id == patient_id))
    return result.scalar_one_or_none()


async def insert_patient(
    session: AsyncSession, *, full_name: str, phone: str | None, email: str | None
) -> Patient:
    patient = Patient(id=uuid.uuid4(), full_name=full_name, phone=phone, email=email)
    session.add(patient)
    await session.flush()
    return patient
