from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_clock, get_session
from app.core.clock import Clock
from app.domain.errors import PatientNotFound
from app.repositories import appointments as appt_repo
from app.repositories import patients as patient_repo
from app.schemas.appointment import AppointmentWithDoctor, DoctorRef, PatientAppointments
from app.schemas.patient import Patient, PatientCreate
from app.schemas.problem import problem_responses
from app.services.patients import create_patient

router = APIRouter(tags=["patients"])

_NO_STORE = {"Cache-Control": "no-store"}


@router.post(
    "/patients", response_model=Patient, status_code=201, responses=problem_responses(409, 422)
)
async def post_patient(
    body: PatientCreate,
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> Patient:
    patient = await create_patient(session, body)
    response.headers["Location"] = f"/patients/{patient.id}"
    response.headers.update(_NO_STORE)
    return Patient.model_validate(patient)


@router.get(
    "/patients/{patient_id}/appointments",
    response_model=PatientAppointments,
    responses=problem_responses(404, 422),
)
async def patient_appointments(
    patient_id: uuid.UUID,
    response: Response,
    limit: int = Query(default=50, ge=1, le=100),
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
) -> PatientAppointments:
    response.headers.update(_NO_STORE)
    if await patient_repo.get_patient(session, patient_id) is None:
        raise PatientNotFound()
    rows = await appt_repo.upcoming_for_patient(session, patient_id, clock.now(), limit)
    items = [
        AppointmentWithDoctor(
            id=appt.id,
            doctor_id=appt.doctor_id,
            patient_id=appt.patient_id,
            starts_at=appt.starts_at,
            ends_at=appt.ends_at,
            status=appt.status,  # a DB CHECK pins this to booked|cancelled
            cancellation_reason=appt.cancellation_reason,
            cancelled_at=appt.cancelled_at,
            created_at=appt.created_at,
            updated_at=appt.updated_at,
            doctor=DoctorRef(id=doctor.id, full_name=doctor.full_name, specialty=doctor.specialty),
        )
        for appt, doctor in rows
    ]
    return PatientAppointments(items=items)
