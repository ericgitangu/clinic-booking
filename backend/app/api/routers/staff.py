"""Staff booking, veto/unlock, invites and the audit trail.

For the web app's server side only, behind the signed assertion. Every write is owner or admin,
refused by the API itself whatever the UI shows. All of it answers 404 when STAFF_CRUD_ENABLED is
false.
"""

from __future__ import annotations

import base64
import binascii
import json
import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import (
    CAN_MANAGE,
    get_clock,
    get_relay,
    get_session,
    get_settings,
    require_identity,
    staff_crud_enabled,
)
from app.api.guards import guard_replay_only, guard_staff_write
from app.core.assertion import Principal
from app.core.clock import Clock
from app.core.config import Settings
from app.domain.emailnorm import normalize_email
from app.domain.errors import NotFoundRoute
from app.repositories import staff as repo
from app.schemas.access import AccessEntry
from app.schemas.problem import problem_responses, with_throttle
from app.schemas.staff import (
    AcceptRequest,
    AttendanceRequest,
    AuditEntry,
    AuditPage,
    InviteCreated,
    InviteList,
    InviteRequest,
    InviteRevoked,
    Notified,
    NotifyResult,
    ReminderRequest,
    RunningLateRequest,
    StaffAppointmentChange,
    StaffCreateAppointment,
    StaffReasonRequest,
)
from app.services import invites, notify, staff_actions
from app.services.admin import InvalidAdminQuery
from app.services.relay import Relay

_NO_STORE = {"Cache-Control": "no-store"}
_GATE = [Depends(staff_crud_enabled)]

appointments_router = APIRouter(
    prefix="/internal/admin/appointments",
    tags=["admin"],
    dependencies=[*_GATE, Depends(CAN_MANAGE)],
    responses=problem_responses(401, 403, 404),
)
invites_router = APIRouter(
    prefix="/internal/admin/invites",
    tags=["admin"],
    dependencies=_GATE,
    responses=problem_responses(401),
)
doctors_router = APIRouter(
    prefix="/internal/admin/doctors",
    tags=["admin"],
    dependencies=[*_GATE, Depends(CAN_MANAGE)],
    responses=problem_responses(401, 403, 404),
)
audit_router = APIRouter(
    prefix="/internal/admin/audit",
    tags=["admin"],
    dependencies=[*_GATE, Depends(CAN_MANAGE)],
    responses=problem_responses(401, 403, 404),
)


@appointments_router.post(
    "",
    response_model=StaffAppointmentChange,
    status_code=201,
    description=(
        "Book for a patient: an existing `patient_id`, or `patient` details (exactly one). Staff "
        "are exempt from the lead-time rule; the slot, working-hours and double-booking rules "
        "still apply. A reason is required and is recorded in the audit trail."
    ),
    responses=with_throttle(problem_responses(409, 422)),
)
async def create_appointment(
    body: StaffCreateAppointment,
    response: Response,
    actor: Principal = Depends(CAN_MANAGE),
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    settings: Settings = Depends(get_settings),
    relay: Relay = Depends(get_relay),
    _guard: None = Depends(guard_staff_write),
) -> StaffAppointmentChange:
    response.headers.update(_NO_STORE)
    change = await staff_actions.create(session, clock, settings, actor=actor, body=body)
    await relay.run(clock)
    return change


@appointments_router.post(
    "/{appointment_id}/veto",
    response_model=StaffAppointmentChange,
    description=(
        "Undo the patient's latest change and lock the appointment against further patient "
        "changes. A reschedule is moved back (same appointment). A cancel is undone by booking "
        "the same slot again as a NEW appointment (the response carries its id) that starts "
        "locked. 409 NOTHING_TO_VETO when the latest change is not the patient's or is already "
        "undone."
    ),
    responses=with_throttle(problem_responses(409, 422)),
)
async def veto_appointment(
    appointment_id: uuid.UUID,
    body: StaffReasonRequest,
    response: Response,
    actor: Principal = Depends(CAN_MANAGE),
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    settings: Settings = Depends(get_settings),
    relay: Relay = Depends(get_relay),
    _guard: None = Depends(guard_staff_write),
) -> StaffAppointmentChange:
    response.headers.update(_NO_STORE)
    change = await staff_actions.veto(
        session, clock, settings, actor=actor, appointment_id=appointment_id, reason=body.reason
    )
    await relay.run(clock)
    return change


@appointments_router.post(
    "/{appointment_id}/unlock",
    response_model=StaffAppointmentChange,
    description="Lift the lock so the patient can change the appointment again.",
    responses=with_throttle(problem_responses(409, 422)),
)
async def unlock_appointment(
    appointment_id: uuid.UUID,
    body: StaffReasonRequest,
    response: Response,
    actor: Principal = Depends(CAN_MANAGE),
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    _guard: None = Depends(guard_staff_write),
) -> StaffAppointmentChange:
    response.headers.update(_NO_STORE)
    return await staff_actions.unlock(
        session, clock, actor=actor, appointment_id=appointment_id, reason=body.reason
    )


_ATTENDANCE_DOC = (
    "Arrival: from 15 minutes before the appointment to 2 hours after it starts. No-show: from "
    "the start to 2 hours after (409 ATTENDANCE_WINDOW_CLOSED outside that). Marking what is "
    "already marked changes nothing. "
    "Changing an earlier mark needs a `reason`. Audited."
)


@appointments_router.post(
    "/{appointment_id}/arrived",
    response_model=StaffAppointmentChange,
    description="Record that the patient arrived. " + _ATTENDANCE_DOC,
    responses=with_throttle(problem_responses(409, 422)),
)
async def mark_arrived(
    appointment_id: uuid.UUID,
    response: Response,
    body: AttendanceRequest | None = None,
    actor: Principal = Depends(CAN_MANAGE),
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    _guard: None = Depends(guard_staff_write),
) -> StaffAppointmentChange:
    response.headers.update(_NO_STORE)
    return await staff_actions.attendance(
        session,
        clock,
        actor=actor,
        appointment_id=appointment_id,
        kind="arrived",
        reason=body.reason if body else None,
    )


@appointments_router.post(
    "/{appointment_id}/no-show",
    response_model=StaffAppointmentChange,
    description="Record that the patient did not turn up. " + _ATTENDANCE_DOC,
    responses=with_throttle(problem_responses(409, 422)),
)
async def mark_no_show(
    appointment_id: uuid.UUID,
    response: Response,
    body: AttendanceRequest | None = None,
    actor: Principal = Depends(CAN_MANAGE),
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    _guard: None = Depends(guard_staff_write),
) -> StaffAppointmentChange:
    response.headers.update(_NO_STORE)
    return await staff_actions.attendance(
        session,
        clock,
        actor=actor,
        appointment_id=appointment_id,
        kind="no_show",
        reason=body.reason if body else None,
    )


_NOTIFY_DOC = (
    " The API writes the audit row(s) and decides who may be emailed; it sends nothing. Send only "
    "the items with `deliver: true` (Idempotency-Key = `audit_id`), then POST "
    "`/internal/admin/audit/{audit_id}/notified`. A demo recipient (a reserved example domain) is "
    'recorded as "demo, not sent" and never has `deliver: true`.'
)


@appointments_router.post(
    "/{appointment_id}/remind",
    response_model=NotifyResult,
    description="Remind the patient of this appointment now." + _NOTIFY_DOC,
    responses=with_throttle(problem_responses(409, 422)),
)
async def remind_now(
    appointment_id: uuid.UUID,
    response: Response,
    body: ReminderRequest | None = None,
    actor: Principal = Depends(CAN_MANAGE),
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    _guard: None = Depends(guard_staff_write),
) -> NotifyResult:
    response.headers.update(_NO_STORE)
    return await notify.remind_now(
        session,
        clock,
        actor=actor,
        appointment_id=appointment_id,
        reason=body.reason if body else None,
    )


@doctors_router.post(
    "/{doctor_id}/running-late",
    response_model=NotifyResult,
    description=(
        "Tell the doctor's remaining patients of today (booked, not yet marked, not synthetic; at "
        "most 50) that the doctor is running late." + _NOTIFY_DOC + " One audit row per patient."
    ),
    responses=with_throttle(problem_responses(422)),
)
async def doctor_running_late(
    doctor_id: uuid.UUID,
    body: RunningLateRequest,
    response: Response,
    actor: Principal = Depends(CAN_MANAGE),
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    _guard: None = Depends(guard_staff_write),
) -> NotifyResult:
    response.headers.update(_NO_STORE)
    return await notify.running_late(
        session,
        clock,
        actor=actor,
        doctor_id=doctor_id,
        minutes=body.minutes,
        reason=body.reason,
    )


# --- invites ---------------------------------------------------------------------------------


@invites_router.post(
    "",
    response_model=InviteCreated,
    status_code=201,
    description=(
        "Invite an email as admin (owner only) or viewer; valid 72 hours. The raw `token` is in "
        "this response only (for the email link): the API keeps its hash. Re-inviting an email "
        "supersedes its open invite. At most 10 a day per person (429 RATE_LIMITED). An audit row "
        "(`audit_id`) is written; when `deliver` is true the web app emails the link and then "
        "marks that row notified."
    ),
    responses=with_throttle({**problem_responses(403, 409, 422, 429)}),
)
async def create_invite(
    body: InviteRequest,
    response: Response,
    actor: Principal = Depends(CAN_MANAGE),
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    settings: Settings = Depends(get_settings),
    _guard: None = Depends(guard_staff_write),
) -> InviteCreated:
    response.headers.update(_NO_STORE)
    return await invites.create(
        session, clock, settings, actor=actor, email=body.email, role=body.role
    )


@invites_router.get(
    "",
    response_model=InviteList,
    dependencies=[Depends(CAN_MANAGE)],
    responses=problem_responses(403),
)
async def list_invites(
    response: Response,
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
) -> InviteList:
    response.headers.update(_NO_STORE)
    return await invites.list_all(session, clock)


@invites_router.delete(
    "/{invite_id}",
    response_model=InviteRevoked,
    responses=with_throttle(problem_responses(403, 404)),
)
async def revoke_invite(
    invite_id: uuid.UUID,
    response: Response,
    actor: Principal = Depends(CAN_MANAGE),
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    _guard: None = Depends(guard_staff_write),
) -> InviteRevoked:
    response.headers.update(_NO_STORE)
    return await invites.revoke(session, clock, actor=actor, invite_id=invite_id)


@invites_router.post(
    "/accept",
    response_model=AccessEntry,
    description=(
        "Accept an invite. The caller is whoever the web app signed in with Google; the verified "
        "email in the signed assertion must equal the invited email. Every failure (unknown, "
        "used, expired, revoked, other email, unverified email) is the same 404 INVITE_INVALID "
        "with the same body."
    ),
    responses=problem_responses(404, 422),
)
async def accept_invite(
    body: AcceptRequest,
    response: Response,
    who: Principal = Depends(require_identity),
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    settings: Settings = Depends(get_settings),
    _guard: None = Depends(guard_replay_only),
) -> AccessEntry:
    response.headers.update(_NO_STORE)
    return await invites.accept(session, clock, settings, who=who, token=body.token)


# --- audit -----------------------------------------------------------------------------------


def _encode(at: datetime, audit_id: uuid.UUID) -> str:
    raw = json.dumps({"t": at.isoformat(), "i": str(audit_id)}, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).rstrip(b"=").decode("ascii")


def _decode(cursor: str) -> tuple[datetime, uuid.UUID]:
    bad = InvalidAdminQuery("cursor is not a cursor issued by this endpoint")
    try:
        body = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
        at = datetime.fromisoformat(body["t"])
        if at.tzinfo is None:
            raise bad
        return at, uuid.UUID(body["i"])
    except (binascii.Error, ValueError, KeyError, TypeError) as exc:
        raise bad from exc


@audit_router.get(
    "",
    response_model=AuditPage,
    description="Staff actions, newest first. Owner and admin only.",
    responses=problem_responses(422),
)
async def list_audit(
    response: Response,
    appointment_id: uuid.UUID | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    cursor: str | None = None,
    session: AsyncSession = Depends(get_session),
) -> AuditPage:
    response.headers.update(_NO_STORE)
    after = _decode(cursor) if cursor else None
    rows = await repo.audit_page(
        session, after=after, appointment_id=appointment_id, limit=limit + 1
    )
    await session.rollback()
    page, more = rows[:limit], len(rows) > limit
    items = [AuditEntry.model_validate(r) for r in page]
    nxt = _encode(page[-1]["occurred_at"], page[-1]["id"]) if more else None
    return AuditPage(items=items, next_cursor=nxt)


@audit_router.post(
    "/{audit_id}/notified",
    response_model=Notified,
    description=(
        "Record that the patient was emailed about this action. Only the person who made the "
        "action can mark it, only for an action that emails the patient, and never for a row "
        'recorded as "demo, not sent" or "no email on file". The flag only goes from false to '
        "true (marking twice is fine); nothing else in the audit row can change. Anything else "
        "is the same 404 as an unknown id."
    ),
    responses=with_throttle(problem_responses(404)),
)
async def mark_notified(
    audit_id: uuid.UUID,
    response: Response,
    actor: Principal = Depends(CAN_MANAGE),
    session: AsyncSession = Depends(get_session),
    _guard: None = Depends(guard_staff_write),
) -> Notified:
    response.headers.update(_NO_STORE)
    me = normalize_email(actor.email)
    async with session.begin():
        row = await repo.row_for_notify(session, audit_id)
        if (
            row is None
            or row["actor_email"] != me
            or row["action"] not in notify.EMAILING_ACTIONS
            or row["outcome"] in notify.NOT_SENT
        ):
            raise NotFoundRoute("No such audit row.")
        if not row["notified"]:
            await repo.mark_notified(session, audit_id, me)
    return Notified(audit_id=audit_id)
