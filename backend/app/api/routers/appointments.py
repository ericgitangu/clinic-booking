from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import IdempotencyKey, get_clock, get_relay, get_session, get_settings
from app.core.clock import Clock
from app.core.config import Settings
from app.domain.booking_rules import RULE_BOOK, RULE_CANCEL, RULE_RESCHEDULE
from app.domain.errors import AppointmentNotFound
from app.models.appointment import Appointment as AppointmentModel
from app.repositories import appointments as appt_repo
from app.schemas.appointment import (
    Appointment,
    AppointmentCreate,
    CancelRequest,
    RescheduleRequest,
)
from app.schemas.problem import (
    REPLAY_HEADER,
    REPLAYED_HEADER,
    problem_responses,
    problem_with_example,
)
from app.services import booking
from app.services.relay import Relay

router = APIRouter(tags=["appointments"])

_NO_STORE = {"Cache-Control": "no-store"}


def _to_schema(appt: AppointmentModel) -> Appointment:
    return Appointment.model_validate(appt)


@router.post(
    "/appointments",
    response_model=Appointment,
    status_code=201,
    description=RULE_BOOK,
    responses={
        **problem_responses(409, 503),
        **problem_with_example(
            422,
            "BOOKING_TOO_SOON",
            "Booking too soon",
            "starts_at is less than the minimum lead time ahead of now.",
            "/appointments",
        ),
        **REPLAY_HEADER,
    },
)
async def create_appointment(
    body: AppointmentCreate,
    response: Response,
    idempotency_key: IdempotencyKey = None,
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    settings: Settings = Depends(get_settings),
    relay: Relay = Depends(get_relay),
) -> Appointment:
    booked = await booking.book(
        session,
        clock,
        settings,
        doctor_id=body.doctor_id,
        patient_id=body.patient_id,
        starts_at=body.starts_at,
        idempotency_key=idempotency_key,
    )
    await relay.run(clock)
    response.headers["Location"] = f"/appointments/{booked.appointment.id}"
    response.headers.update(_NO_STORE)
    if booked.replayed:
        response.headers[REPLAYED_HEADER] = "true"
    return _to_schema(booked.appointment)


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
    description=RULE_CANCEL,
    responses={
        **problem_responses(404, 422),
        **problem_with_example(
            409,
            "CHANGE_TOO_LATE",
            "Change too late",
            "Cancel, or reschedule from or to, a time less than the minimum lead time "
            "(60 minutes) away.",
            "/appointments/{appointment_id}/cancel",
        ),
    },
)
async def cancel_appointment(
    appointment_id: uuid.UUID,
    body: CancelRequest,
    response: Response,
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    settings: Settings = Depends(get_settings),
    relay: Relay = Depends(get_relay),
) -> Appointment:
    response.headers.update(_NO_STORE)
    appt = await booking.cancel(
        session, clock, settings, appointment_id=appointment_id, reason=body.reason
    )
    await relay.run(clock)
    return _to_schema(appt)


@router.patch(
    "/appointments/{appointment_id}/reschedule",
    response_model=Appointment,
    description=RULE_RESCHEDULE,
    responses={
        **problem_responses(404, 422),
        **problem_with_example(
            409,
            "CHANGE_TOO_LATE",
            "Change too late",
            "Cancel, or reschedule from or to, a time less than the minimum lead time "
            "(60 minutes) away.",
            "/appointments/{appointment_id}/reschedule",
        ),
    },
)
async def reschedule_appointment(
    appointment_id: uuid.UUID,
    body: RescheduleRequest,
    response: Response,
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    settings: Settings = Depends(get_settings),
    relay: Relay = Depends(get_relay),
) -> Appointment:
    response.headers.update(_NO_STORE)
    appt = await booking.reschedule(
        session, clock, settings, appointment_id=appointment_id, new_starts_at=body.starts_at
    )
    await relay.run(clock)
    return _to_schema(appt)
