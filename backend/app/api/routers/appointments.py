from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_clock, get_session, get_settings
from app.core.clock import Clock
from app.core.config import Settings
from app.domain.errors import AppointmentNotFound
from app.models.appointment import Appointment as AppointmentModel
from app.repositories import appointments as appt_repo
from app.schemas.appointment import (
    Appointment,
    AppointmentCreate,
    CancelRequest,
    RescheduleRequest,
)
from app.schemas.problem import problem_responses
from app.services import booking

router = APIRouter(tags=["appointments"])

_NO_STORE = {"Cache-Control": "no-store"}


def _to_schema(appt: AppointmentModel) -> Appointment:
    return Appointment.model_validate(appt)


@router.post(
    "/appointments",
    response_model=Appointment,
    status_code=201,
    responses=problem_responses(409, 422, 503),
)
async def create_appointment(
    body: AppointmentCreate,
    response: Response,
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    settings: Settings = Depends(get_settings),
) -> Appointment:
    appt = await booking.book(
        session,
        clock,
        settings,
        doctor_id=body.doctor_id,
        patient_id=body.patient_id,
        starts_at=body.starts_at,
    )
    response.headers["Location"] = f"/appointments/{appt.id}"
    response.headers.update(_NO_STORE)
    return _to_schema(appt)


@router.get(
    "/appointments/{appointment_id}",
    response_model=Appointment,
    responses=problem_responses(404, 422),
)
async def get_appointment(
    appointment_id: uuid.UUID,
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> Appointment:
    response.headers.update(_NO_STORE)
    appt = await appt_repo.get_appointment(session, appointment_id)
    if appt is None:
        raise AppointmentNotFound()
    return _to_schema(appt)


@router.patch(
    "/appointments/{appointment_id}/cancel",
    response_model=Appointment,
    responses=problem_responses(404, 409, 422),
)
async def cancel_appointment(
    appointment_id: uuid.UUID,
    body: CancelRequest,
    response: Response,
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
) -> Appointment:
    response.headers.update(_NO_STORE)
    appt = await booking.cancel(session, clock, appointment_id=appointment_id, reason=body.reason)
    return _to_schema(appt)


@router.patch(
    "/appointments/{appointment_id}/reschedule",
    response_model=Appointment,
    responses=problem_responses(404, 409, 422),
)
async def reschedule_appointment(
    appointment_id: uuid.UUID,
    body: RescheduleRequest,
    response: Response,
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    settings: Settings = Depends(get_settings),
) -> Appointment:
    response.headers.update(_NO_STORE)
    appt = await booking.reschedule(
        session, clock, settings, appointment_id=appointment_id, new_starts_at=body.starts_at
    )
    return _to_schema(appt)
