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
    CAN_MANAGE_ACCESS,
    OWNER_ONLY,
    get_clock,
    get_relay,
    get_session,
    get_settings,
    require_identity,
)
from app.core.assertion import Principal
from app.core.clock import Clock
from app.core.config import Settings
from app.domain.booking_rules import RULE_CANCEL, RULE_RESCHEDULE
from app.domain.emailnorm import normalize_email
from app.schemas.access import (
    AccessEntry,
    AccessList,
    ChangeRoleRequest,
    Email,
    GrantRequest,
    SessionInfo,
)
from app.schemas.admin import AdminAppointment, AdminAppointmentPage, Bucket, Lineage, Metrics
from app.schemas.appointment import CancelRequest
from app.schemas.problem import change_too_late_responses, problem_responses
from app.schemas.staff import StaffAppointmentChange, StaffRescheduleRequest
from app.services import access as access_service
from app.services import admin as service
from app.services import staff_actions
from app.services.relay import Relay

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
# Managing access. Granting directly stays with the owner; listing, changing and revoking are for
# owner and admin, and the service refuses an admin anything above a viewer (amending the owner-only
# rule). All of it is enforced here and not only in the UI.
access_router = APIRouter(
    prefix="/internal/admin/access",
    tags=["admin"],
    responses=problem_responses(401, 403),
)

_NO_STORE = {"Cache-Control": "no-store"}
STAFF_EXEMPT = (
    " Staff are exempt from the lead-time rule and only from it: this route never returns "
    "CHANGE_TOO_LATE or BOOKING_TOO_SOON. Every other check applies (SLOT_IN_PAST, "
    "APPOINTMENT_ALREADY_STARTED, APPOINTMENT_ALREADY_CANCELLED, DATE_OUT_OF_RANGE, "
    "SLOT_MISALIGNED, OUTSIDE_WORKING_HOURS, SLOT_TAKEN, PATIENT_DOUBLE_BOOKED), and a reason is "
    "required."
)


@router.get(
    "/metrics",
    response_model=Metrics,
    responses=problem_responses(422),
    description=(
        "Activity series, totals and per-doctor load for the clinic-local days `[from, to)`. Each "
        "event or visit is placed by the zone of its own doctor's clinic. `bucket_start` is "
        "clinic-local wall-clock time, not an instant, so with clinics in different zones the "
        "series merges the same local day (or hour) of every clinic."
    ),
)
async def get_metrics(
    response: Response,
    from_: Annotated[date, Query(alias="from")],
    to: date,
    bucket: Bucket = "day",
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    relay: Relay = Depends(get_relay),
) -> Metrics:
    response.headers.update(_NO_STORE)
    # A dashboard request is also a chance to push events stuck behind an open transaction.
    await relay.run(clock)
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
    who: Principal = Depends(ANY_STAFF),
    session: AsyncSession = Depends(get_session),
    principal: Principal = Depends(ANY_STAFF),
) -> AdminAppointmentPage:
    response.headers.update(_NO_STORE)
    return await service.appointments(
        session,
        show_avatars=service.may_see_avatars(principal.role),
        status=status,
        doctor_id=doctor_id,
        start=from_,
        end=to,
        limit=limit,
        cursor=cursor,
        role=who.role,
    )


@router.get(
    "/appointments/{appointment_id}",
    response_model=AdminAppointment,
    responses=problem_responses(404, 422),
    description=(
        "One appointment as an item of the admin list: same fields and the same projection by "
        "role (a viewer gets initials, a masked phone, no email and no reason). Appointments of "
        "synthetic patients are not shown in admin views and answer 404, like an unknown id."
    ),
)
async def get_appointment(
    response: Response,
    appointment_id: uuid.UUID,
    who: Principal = Depends(ANY_STAFF),
    session: AsyncSession = Depends(get_session),
) -> AdminAppointment:
    response.headers.update(_NO_STORE)
    return await service.appointment(session, appointment_id, role=who.role)


@router.get(
    "/appointments/{appointment_id}/lineage",
    response_model=Lineage,
    responses=problem_responses(404, 422),
)
async def get_lineage(
    response: Response,
    appointment_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    principal: Principal = Depends(ANY_STAFF),
) -> Lineage:
    response.headers.update(_NO_STORE)
    return await service.lineage(
        session, appointment_id, show_avatars=service.may_see_avatars(principal.role)
    )


@identity_router.get("/session", response_model=SessionInfo)
async def get_session_info(
    response: Response,
    principal: Principal = Depends(require_identity),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> SessionInfo:
    response.headers.update(_NO_STORE)
    role = await access_service.resolve_role(session, settings, principal.email)
    return SessionInfo(email=normalize_email(principal.email), role=role)


@access_router.get("", response_model=AccessList)
async def list_access(
    response: Response,
    _: Principal = Depends(CAN_MANAGE_ACCESS),
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
    clock: Clock = Depends(get_clock),
) -> AccessEntry:
    response.headers.update(_NO_STORE)
    return await access_service.grant(
        session,
        settings,
        actor=actor.email.lower(),
        email=body.email,
        role=body.role,
        now=clock.now(),
    )


@access_router.patch(
    "/{email}", response_model=AccessEntry, responses=problem_responses(404, 409, 422)
)
async def change_access_role(
    email: Annotated[Email, Path()],
    body: ChangeRoleRequest,
    response: Response,
    actor: Principal = Depends(CAN_MANAGE_ACCESS),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
    clock: Clock = Depends(get_clock),
) -> AccessEntry:
    response.headers.update(_NO_STORE)
    return await access_service.change_role(
        session,
        settings,
        actor=normalize_email(actor.email),
        actor_role=actor.role,
        email=email,
        role=body.role,
        now=clock.now(),
    )


@access_router.delete(
    "/{email}", response_model=AccessEntry, responses=problem_responses(404, 409, 422)
)
async def revoke_access(
    email: Annotated[Email, Path()],
    response: Response,
    actor: Principal = Depends(CAN_MANAGE_ACCESS),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
    clock: Clock = Depends(get_clock),
) -> AccessEntry:
    response.headers.update(_NO_STORE)
    return await access_service.revoke(
        session,
        settings,
        actor=normalize_email(actor.email),
        actor_role=actor.role,
        email=email,
        now=clock.now(),
    )


@manage_router.patch(
    "/{appointment_id}/cancel",
    response_model=StaffAppointmentChange,
    description=RULE_CANCEL + STAFF_EXEMPT,
    responses=change_too_late_responses(),
)
async def cancel_for_patient(
    appointment_id: uuid.UUID,
    body: CancelRequest,
    response: Response,
    actor: Principal = Depends(CAN_MANAGE),
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    settings: Settings = Depends(get_settings),
    relay: Relay = Depends(get_relay),
) -> StaffAppointmentChange:
    response.headers.update(_NO_STORE)
    change = await staff_actions.cancel(
        session, clock, settings, actor=actor, appointment_id=appointment_id, reason=body.reason
    )
    await relay.run(clock)
    return change


@manage_router.patch(
    "/{appointment_id}/reschedule",
    response_model=StaffAppointmentChange,
    description=RULE_RESCHEDULE + STAFF_EXEMPT,
    responses=change_too_late_responses(new_start=True),
)
async def reschedule_for_patient(
    appointment_id: uuid.UUID,
    body: StaffRescheduleRequest,
    response: Response,
    actor: Principal = Depends(CAN_MANAGE),
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    settings: Settings = Depends(get_settings),
    relay: Relay = Depends(get_relay),
) -> StaffAppointmentChange:
    response.headers.update(_NO_STORE)
    change = await staff_actions.reschedule(
        session,
        clock,
        settings,
        actor=actor,
        appointment_id=appointment_id,
        starts_at=body.starts_at,
        reason=body.reason,
    )
    await relay.run(clock)
    return change
