from __future__ import annotations

import uuid

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.patient import Patient


async def get_patient(session: AsyncSession, patient_id: uuid.UUID) -> Patient | None:
    result = await session.execute(select(Patient).where(Patient.id == patient_id))
    return result.scalar_one_or_none()


async def insert_patient(
    session: AsyncSession,
    *,
    full_name: str,
    phone: str | None,
    email: str | None,
    synthetic: bool = False,
) -> Patient:
    patient = Patient(
        id=uuid.uuid4(), full_name=full_name, phone=phone, email=email, synthetic=synthetic
    )
    session.add(patient)
    await session.flush()
    return patient


async def find_same_person(
    session: AsyncSession, *, full_name: str, phone: str | None, email: str | None
) -> Patient | None:
    """An existing, real patient who is evidently the one described: the same name (ignoring case)
    and the same phone, or the same email. Used so a double-submitted staff booking does not
    create the same person twice."""
    same_name = func.lower(Patient.full_name) == full_name.strip().lower()
    clauses = []
    if phone is not None:
        clauses.append(Patient.phone == phone)
    if email is not None:
        clauses.append(func.lower(Patient.email) == email.strip().lower())
    if not clauses:
        return None
    result = await session.execute(
        select(Patient)
        .where(Patient.synthetic.is_(False), same_name, or_(*clauses))
        .order_by(Patient.created_at)
        .limit(1)
    )
    return result.scalar_one_or_none()
