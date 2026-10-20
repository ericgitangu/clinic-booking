"""The doctor's address and the arrival email's record, for the web app's server side only.

Owner and admin, behind the signed assertion, and 404 when STAFF_CRUD_ENABLED is false like the
other staff routes. The API records and decides; the web app sends (see
``app/services/doctor_notice.py``).
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import (
    CAN_MANAGE,
    get_clock,
    get_session,
    get_settings,
    staff_crud_enabled,
)
from app.api.guards import guard_replay_only, guard_staff_write
from app.core.assertion import Principal
from app.core.clock import Clock
from app.core.config import Settings
from app.schemas.doctor_notice import (
    DoctorEmail,
    DoctorEmailRequest,
    DoctorNoticeClaim,
    DoctorNoticeFinish,
    DoctorNoticeFinished,
    DoctorNoticeState,
)
from app.schemas.problem import problem_responses, with_throttle
from app.services import doctor_notice

_NO_STORE = {"Cache-Control": "no-store"}

router = APIRouter(
    prefix="/internal/admin",
    tags=["admin"],
    dependencies=[Depends(staff_crud_enabled), Depends(CAN_MANAGE)],
    responses=problem_responses(401, 403, 404),
)


@router.patch(
    "/doctors/{doctor_id}/email",
    response_model=DoctorEmail,
    description=(
        "Set the doctor's official address, or clear it with `email: null`. It is where the "
        "arrival email goes, and it is never in a public response. A reason is required and is "
        "recorded in the audit trail with the address before and after. Setting what is already "
        "there records nothing (`audit_id` null)."
    ),
    responses=with_throttle(problem_responses(422)),
)
async def set_doctor_email(
    doctor_id: uuid.UUID,
    body: DoctorEmailRequest,
    response: Response,
    actor: Principal = Depends(CAN_MANAGE),
    session: AsyncSession = Depends(get_session),
    _guard: None = Depends(guard_staff_write),
) -> DoctorEmail:
    response.headers.update(_NO_STORE)
    return await doctor_notice.set_email(
        session, actor=actor, doctor_id=doctor_id, email=body.email, reason=body.reason
    )


@router.get(
    "/appointments/{appointment_id}/doctor-notification",
    response_model=DoctorNoticeState,
    description="Where telling the doctor of this arrival stands. 404 when there is none.",
)
async def get_doctor_notification(
    appointment_id: uuid.UUID,
    response: Response,
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    settings: Settings = Depends(get_settings),
) -> DoctorNoticeState:
    response.headers.update(_NO_STORE)
    return await doctor_notice.state_for(session, clock, settings, appointment_id)


@router.post(
    "/doctor-notifications/{notification_id}/claim",
    response_model=DoctorNoticeClaim,
    description=(
        "Take the right to send this arrival email, with a lease. `send` is null when there is "
        "nothing to send (already sent, skipped, out of attempts, or held by another sender)."
    ),
)
async def claim_doctor_notification(
    notification_id: uuid.UUID,
    response: Response,
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    settings: Settings = Depends(get_settings),
    _guard: None = Depends(guard_replay_only),
) -> DoctorNoticeClaim:
    response.headers.update(_NO_STORE)
    return await doctor_notice.claim(session, clock, settings, notification_id=notification_id)


@router.post(
    "/doctor-notifications/{notification_id}/finish",
    response_model=DoctorNoticeFinished,
    description=(
        "Record the result of a send made under a claim: `sent` only after the provider accepted "
        "it, `failed` (it can be claimed again until the attempts are used) or `skipped` with the "
        "reason (the day's or month's allowance used up, a reserved address)."
    ),
    responses=problem_responses(422),
)
async def finish_doctor_notification(
    notification_id: uuid.UUID,
    body: DoctorNoticeFinish,
    response: Response,
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    _guard: None = Depends(guard_replay_only),
) -> DoctorNoticeFinished:
    response.headers.update(_NO_STORE)
    return await doctor_notice.finish(session, clock, notification_id=notification_id, body=body)
