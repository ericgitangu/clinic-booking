"""What a signed-in patient may do, through the web app's server side only.

Every route needs a valid, request-bound assertion for a verified email
(``require_verified_identity``). The patient is the one the assertion's subject is linked to; a
patient id is never taken from the request. An appointment that is not the caller's answers 404,
the same as one that does not exist, so ids cannot be probed.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import (
    IdempotencyKey,
    get_clock,
    get_relay,
    get_session,
    get_settings,
    require_verified_identity,
)
from app.core.assertion import Principal
from app.core.clock import Clock
from app.core.config import Settings
from app.domain.booking_rules import RULE_CANCEL, RULE_RESCHEDULE
from app.domain.errors import AppointmentNotFound, PatientNotFound
from app.models.appointment import Appointment as AppointmentModel
from app.repositories import accounts as account_repo
from app.repositories import appointments as appt_repo
from app.repositories.errors import map_integrity_error
from app.repositories.patients import insert_patient
from app.schemas.account import AccountLinked, AccountLinkRequest, MeAppointmentCreate
from app.schemas.appointment import (
    Appointment,
    AppointmentWithDoctor,
    CancelRequest,
    DoctorRef,
    PatientAppointments,
    RescheduleRequest,
)
from app.schemas.problem import (
    REPLAY_HEADER,
    REPLAYED_HEADER,
    change_too_late_responses,
    problem_responses,
)
from app.services import booking
from app.services.relay import Relay

router = APIRouter(
    prefix="/internal",
    tags=["patient account"],
    responses=problem_responses(401, 403),
)

_NO_STORE = {"Cache-Control": "no-store"}


async def _linked_patient(session: AsyncSession, who: Principal) -> uuid.UUID:
    patient_id = await account_repo.patient_id_for(session, who.sub)
    # The lookup began a transaction; end it so the service can open its own.
    await session.rollback()
    if patient_id is None:
        raise PatientNotFound()
    return patient_id


async def _own(session: AsyncSession, patient_id: uuid.UUID, appointment_id: uuid.UUID) -> None:
    appt = await appt_repo.get_appointment(session, appointment_id)
    # Read before ending the transaction: ending it expires the loaded object.
    owned = appt is not None and appt.patient_id == patient_id
    await session.rollback()
    if not owned:
        raise AppointmentNotFound()


def _to_schema(appt: AppointmentModel) -> Appointment:
    return Appointment.model_validate(appt)


@router.post(
    "/accounts/link",
    response_model=AccountLinked,
    responses={
        **problem_responses(403, 422),
        201: {"model": AccountLinked, "description": "The patient was created by this call"},
    },
)
async def link_account(
    body: AccountLinkRequest,
    response: Response,
    who: Principal = Depends(require_verified_identity),
    session: AsyncSession = Depends(get_session),
) -> AccountLinked:
    """Idempotent: the first call for a sign-in creates a patient from the display name and the
    verified email and records the link (201); every later call returns the same patient (200).
    It never adopts an existing patient that happens to share a phone number or an email."""
    response.headers.update(_NO_STORE)
    existing = await account_repo.patient_id_for(session, who.sub)
    await session.rollback()
    if existing is not None:
        return AccountLinked(patient_id=existing, created=False)
    try:
        async with session.begin():
            patient = await insert_patient(
                session, full_name=body.full_name.strip(), phone=None, email=who.email
            )
            created = await account_repo.insert_link(
                session, sub=who.sub, patient_id=patient.id, email=who.email
            )
            if created is None:
                # Another request linked this sign-in first: undo the patient made for this one.
                await session.rollback()
    except IntegrityError as exc:
        raise map_integrity_error(exc) from exc
    if created is None:
        winner = await account_repo.patient_id_for(session, who.sub)
        await session.rollback()
        if winner is None:  # pragma: no cover - the row exists once the conflict was reported
            raise PatientNotFound()
        return AccountLinked(patient_id=winner, created=False)
    response.status_code = 201
    return AccountLinked(patient_id=created, created=True)


@router.get(
    "/me/appointments",
    response_model=PatientAppointments,
    responses=problem_responses(404),
)
async def my_appointments(
    response: Response,
    limit: int = Query(default=50, ge=1, le=100),
    who: Principal = Depends(require_verified_identity),
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
) -> PatientAppointments:
    response.headers.update(_NO_STORE)
    patient_id = await _linked_patient(session, who)
    rows = await appt_repo.upcoming_for_patient(session, patient_id, clock.now(), limit)
    page = PatientAppointments(
        items=[
            AppointmentWithDoctor(
                id=appt.id,
                doctor_id=appt.doctor_id,
                patient_id=appt.patient_id,
                starts_at=appt.starts_at,
                ends_at=appt.ends_at,
                status=appt.status,
                cancellation_reason=appt.cancellation_reason,
                cancelled_at=appt.cancelled_at,
                created_at=appt.created_at,
                updated_at=appt.updated_at,
                timezone=appt.timezone,
                doctor=DoctorRef(
                    id=doctor.id, full_name=doctor.full_name, specialty=doctor.specialty
                ),
            )
            for appt, doctor in rows
        ]
    )
    await session.rollback()
    return page


@router.get(
    "/me/appointments/{appointment_id}",
    response_model=Appointment,
    responses=problem_responses(404, 422),
)
async def my_appointment(
    appointment_id: uuid.UUID,
    response: Response,
    who: Principal = Depends(require_verified_identity),
    session: AsyncSession = Depends(get_session),
) -> Appointment:
    response.headers.update(_NO_STORE)
    patient_id = await _linked_patient(session, who)
    appt = await appt_repo.get_appointment(session, appointment_id)
    if appt is None or appt.patient_id != patient_id:
        await session.rollback()
        raise AppointmentNotFound()
    found = _to_schema(appt)
    await session.rollback()
    return found


@router.post(
    "/me/appointments",
    response_model=Appointment,
    status_code=201,
    responses={**problem_responses(404, 409, 422, 503), **REPLAY_HEADER},
)
async def book_mine(
    body: MeAppointmentCreate,
    response: Response,
    idempotency_key: IdempotencyKey = None,
    who: Principal = Depends(require_verified_identity),
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    settings: Settings = Depends(get_settings),
    relay: Relay = Depends(get_relay),
) -> Appointment:
    response.headers.update(_NO_STORE)
    patient_id = await _linked_patient(session, who)
    booked = await booking.book(
        session,
        clock,
        settings,
        doctor_id=body.doctor_id,
        patient_id=patient_id,
        starts_at=body.starts_at,
        idempotency_key=idempotency_key,
    )
    await relay.run(clock)
    if booked.replayed:
        response.headers[REPLAYED_HEADER] = "true"
    return _to_schema(booked.appointment)


@router.patch(
    "/me/appointments/{appointment_id}/cancel",
    response_model=Appointment,
    description=RULE_CANCEL,
    responses=change_too_late_responses(),
)
async def cancel_mine(
    appointment_id: uuid.UUID,
    body: CancelRequest,
    response: Response,
    who: Principal = Depends(require_verified_identity),
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    settings: Settings = Depends(get_settings),
    relay: Relay = Depends(get_relay),
) -> Appointment:
    response.headers.update(_NO_STORE)
    patient_id = await _linked_patient(session, who)
    await _own(session, patient_id, appointment_id)
    appt = await booking.cancel(
        session, clock, settings, appointment_id=appointment_id, reason=body.reason
    )
    await relay.run(clock)
    return _to_schema(appt)


@router.patch(
    "/me/appointments/{appointment_id}/reschedule",
    response_model=Appointment,
    description=RULE_RESCHEDULE,
    responses=change_too_late_responses(new_start=True),
)
async def reschedule_mine(
    appointment_id: uuid.UUID,
    body: RescheduleRequest,
    response: Response,
    who: Principal = Depends(require_verified_identity),
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    settings: Settings = Depends(get_settings),
    relay: Relay = Depends(get_relay),
) -> Appointment:
    response.headers.update(_NO_STORE)
    patient_id = await _linked_patient(session, who)
    await _own(session, patient_id, appointment_id)
    appt = await booking.reschedule(
        session, clock, settings, appointment_id=appointment_id, new_starts_at=body.starts_at
    )
    await relay.run(clock)
    return _to_schema(appt)
