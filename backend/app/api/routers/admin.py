"""Read-only admin aggregates behind the web app's signed assertion (``role = "admin"``).

These paths are for the BFF only. Responses are never cacheable: they describe the whole clinic.
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Path, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import (
    ANY_STAFF,
    CAN_MANAGE,
    OWNER_ONLY,
    get_clock,
    get_session,
    get_settings,
    require_identity,
)
from app.core.assertion import Principal
from app.core.clock import Clock
from app.core.config import Settings
from app.schemas.access import (
    AccessEntry,
    AccessList,
    ChangeRoleRequest,
    Email,
    GrantRequest,
    SessionInfo,
)
from app.schemas.admin import AdminAppointmentPage, Bucket, Lineage, Metrics
from app.schemas.appointment import Appointment, CancelRequest, RescheduleRequest
from app.schemas.problem import problem_responses
from app.services import access as access_service
from app.services import admin as service
from app.services import booking

router = APIRouter(
    prefix="/internal/admin",
    tags=["admin"],
    dependencies=[Depends(ANY_STAFF)],
    responses=problem_responses(401, 403),
)
# Who the caller is, for any valid assertion: how a web app learns the role of a signed-in email.
identity_router = APIRouter(
    prefix="/internal/admin", tags=["admin"], responses=problem_responses(401)
)
# Acting for a patient: cancel or move an appointment. Owner and admin only; a viewer is refused
# here by the API itself, whatever the web app shows. The booking rules are the public ones.
manage_router = APIRouter(
    prefix="/internal/admin/appointments",
    tags=["admin"],
    dependencies=[Depends(CAN_MANAGE)],
    responses=problem_responses(401, 403),
)
# Managing access: the owner only, enforced here and not only in the UI.
access_router = APIRouter(
    prefix="/internal/admin/access",
    tags=["admin"],
    dependencies=[Depends(OWNER_ONLY)],
    responses=problem_responses(401, 403),
)

_NO_STORE = {"Cache-Control": "no-store"}


@router.get("/metrics", response_model=Metrics, responses=problem_responses(422))
async def get_metrics(
    response: Response,
    from_: Annotated[date, Query(alias="from")],
    to: date,
    bucket: Bucket = "day",
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
) -> Metrics:
    response.headers.update(_NO_STORE)
    return await service.metrics(session, clock, start=from_, end=to, bucket=bucket)


@router.get("/appointments", response_model=AdminAppointmentPage, responses=problem_responses(422))
async def list_appointments(
    response: Response,
    status: Literal["booked", "cancelled", "all"] = "all",
    doctor_id: uuid.UUID | None = None,
    from_: Annotated[date | None, Query(alias="from")] = None,
    to: date | None = None,
    limit: Annotated[int, Query(ge=1, le=service.MAX_LIMIT)] = service.DEFAULT_LIMIT,
    cursor: str | None = None,
    session: AsyncSession = Depends(get_session),
) -> AdminAppointmentPage:
    response.headers.update(_NO_STORE)
    return await service.appointments(
        session,
        status=status,
        doctor_id=doctor_id,
        start=from_,
        end=to,
        limit=limit,
        cursor=cursor,
    )


@router.get(
    "/appointments/{appointment_id}/lineage",
    response_model=Lineage,
    responses=problem_responses(404, 422),
)
async def get_lineage(
    response: Response,
    appointment_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
) -> Lineage:
    response.headers.update(_NO_STORE)
    return await service.lineage(session, appointment_id)


@identity_router.get("/session", response_model=SessionInfo)
async def get_session_info(
    response: Response,
    principal: Principal = Depends(require_identity),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> SessionInfo:
    response.headers.update(_NO_STORE)
    role = await access_service.resolve_role(session, settings, principal.email)
    return SessionInfo(email=principal.email.strip().lower(), role=role)


@access_router.get("", response_model=AccessList)
async def list_access(
    response: Response,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> AccessList:
    response.headers.update(_NO_STORE)
    return await access_service.list_access(session, settings)


@access_router.post(
    "", response_model=AccessEntry, status_code=201, responses=problem_responses(409, 422)
)
async def grant_access(
    body: GrantRequest,
    response: Response,
    actor: Principal = Depends(OWNER_ONLY),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> AccessEntry:
    response.headers.update(_NO_STORE)
    return await access_service.grant(
        session, settings, actor=actor.email.lower(), email=body.email, role=body.role
    )


@access_router.patch(
    "/{email}", response_model=AccessEntry, responses=problem_responses(404, 409, 422)
)
async def change_access_role(
    email: Annotated[Email, Path()],
    body: ChangeRoleRequest,
    response: Response,
    actor: Principal = Depends(OWNER_ONLY),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> AccessEntry:
    response.headers.update(_NO_STORE)
    return await access_service.change_role(
        session, settings, actor=actor.email.lower(), email=email, role=body.role
    )


@access_router.delete(
    "/{email}", response_model=AccessEntry, responses=problem_responses(404, 409, 422)
)
async def revoke_access(
    email: Annotated[Email, Path()],
    response: Response,
    actor: Principal = Depends(OWNER_ONLY),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> AccessEntry:
    response.headers.update(_NO_STORE)
    return await access_service.revoke(session, settings, actor=actor.email.lower(), email=email)


@manage_router.patch(
    "/{appointment_id}/cancel",
    response_model=Appointment,
    responses=problem_responses(404, 409, 422),
)
async def cancel_for_patient(
    appointment_id: uuid.UUID,
    body: CancelRequest,
    response: Response,
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
) -> Appointment:
    response.headers.update(_NO_STORE)
    appt = await booking.cancel(session, clock, appointment_id=appointment_id, reason=body.reason)
    return Appointment.model_validate(appt)


@manage_router.patch(
    "/{appointment_id}/reschedule",
    response_model=Appointment,
    responses=problem_responses(404, 409, 422),
)
async def reschedule_for_patient(
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
    return Appointment.model_validate(appt)
