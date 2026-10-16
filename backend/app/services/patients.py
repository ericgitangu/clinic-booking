from __future__ import annotations

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.patient import Patient
from app.repositories.errors import map_integrity_error
from app.repositories.patients import insert_patient
from app.schemas.patient import PatientCreate


async def create_patient(session: AsyncSession, data: PatientCreate) -> Patient:
    try:
        async with session.begin():
            return await insert_patient(
                session,
                full_name=data.full_name,
                phone=data.phone,
                email=str(data.email) if data.email is not None else None,
            )
    except IntegrityError as exc:
        raise map_integrity_error(exc) from exc
