"""Request and response shapes of the staff write routes, invites and the audit trail."""

from __future__ import annotations

import datetime as _dt
import uuid
from typing import Annotated, Any, Literal, Self

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, field_validator, model_validator

from app.domain.staff import StaffActionName
from app.schemas.access import Email, GrantableRole
from app.schemas.appointment import Appointment, _strip
from app.schemas.common import ClinicDatetime, StrAwareDatetime
from app.schemas.doctor_notice import DoctorNoticeState
from app.schemas.patient import PatientCreate

# Every staff write says why: trimmed, then 3 to 500 characters, no NUL (same as a cancel reason).
Reason = Annotated[str, BeforeValidator(_strip), Field(min_length=3, max_length=500)]


def _clean(value: object) -> object:
    """Trim, and refuse a NUL character (Postgres text cannot hold one)."""
    if isinstance(value, str):
        if "\x00" in value:
            raise ValueError("reason must not contain NUL characters")
        return value.strip()
    return value


# A reason that may be left out; when given it is held to the same 3-500 characters as the audit
# table's CHECK, so a bad one is a 422 at the boundary and never a database error.
def _blank_is_absent(value: object) -> object:
    return None if isinstance(value, str) and not value.strip() else value


# A blank reason is the same as none.
OptionalReason = Annotated[
    Annotated[str, BeforeValidator(_clean), Field(min_length=3, max_length=500)] | None,
    BeforeValidator(_blank_is_absent),
]


class _WithReason(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: Reason

    @field_validator("reason")
    @classmethod
    def _no_nul(cls, v: str) -> str:
        if "\x00" in v:
            raise ValueError("reason must not contain NUL characters")
        return v


class StaffCreateAppointment(_WithReason):
    """Book for a patient: an existing ``patient_id``, or ``patient`` details (exactly one)."""

    doctor_id: uuid.UUID
    starts_at: StrAwareDatetime
    patient_id: uuid.UUID | None = None
    patient: PatientCreate | None = None

    @model_validator(mode="after")
    def _one_patient(self) -> Self:
        if (self.patient_id is None) == (self.patient is None):
            raise ValueError("give exactly one of patient_id and patient")
        return self


class StaffRescheduleRequest(_WithReason):
    starts_at: StrAwareDatetime


class StaffReasonRequest(_WithReason):
    """Cancel, veto and unlock carry only the reason."""


class StaffAppointmentChange(Appointment):
    """The changed appointment plus what the web app needs to tell the patient.

    ``audit_id`` is the audit row of this write and the patient email's idempotency key; it is null
    only when nothing changed (a reschedule to the time it already has). The patient fields are
    full values: these routes are owner and admin only.
    """

    audit_id: uuid.UUID | None
    patient_name: str
    patient_email: str | None
    doctor_name: str
    # Where the appointment was before a reschedule, cancel or veto of a reschedule.
    previous_starts_at: _dt.datetime | None
    # Arrival only: the record of telling the doctor, written in this transaction. Null for every
    # other action, and for a repeat mark that changed nothing.
    doctor_notice: DoctorNoticeState | None = None


class Notified(BaseModel):
    audit_id: uuid.UUID
    notified: Literal[True] = True


class AuditEntry(BaseModel):
    id: uuid.UUID
    actor_email: str
    actor_role: Literal["owner", "admin", "viewer"]
    # The same list the service writes and the database CHECK allows, so a new action can never
    # be stored and then fail to read back.
    action: StaffActionName
    appointment_id: uuid.UUID | None
    reason: str
    before: dict[str, Any]
    after: dict[str, Any]
    notified: bool
    occurred_at: ClinicDatetime


class AuditPage(BaseModel):
    items: list[AuditEntry]
    next_cursor: str | None


NotifyOutcome = Literal["to send", "demo, not sent", "no email on file"]
InviteStatus = Literal["open", "expired", "consumed", "revoked"]


class InviteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: Email
    role: GrantableRole


class Invite(BaseModel):
    id: uuid.UUID
    email: str
    role: GrantableRole
    invited_by: str
    status: InviteStatus
    created_at: ClinicDatetime
    expires_at: ClinicDatetime


class InviteCreated(Invite):
    """Returned once, on creation. ``token`` is the raw secret for the email link: it is not
    stored (only its SHA-256 is), not logged and cannot be read again.

    To email the invitation: when ``deliver`` is true, send the link ``/invite/<token>`` to
    ``email`` (Idempotency-Key ``invite/<id>``), then POST ``/internal/admin/audit/<audit_id>/
    notified``. A reserved example address is "demo, not sent": ``deliver`` is false, the audit row
    says so and nothing may be sent."""

    token: str
    audit_id: uuid.UUID
    deliver: bool
    outcome: NotifyOutcome


class InviteRevoked(Invite):
    audit_id: uuid.UUID


class InviteList(BaseModel):
    items: list[Invite]


class AcceptRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: Annotated[str, Field(min_length=20, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")]


class AttendanceRequest(BaseModel):
    """The reason is optional for a first mark and required to change an earlier one."""

    model_config = ConfigDict(extra="forbid")
    reason: OptionalReason = None


class ReminderRequest(BaseModel):
    """Why the reminder goes now. Optional: it defaults to a standard line in the audit row."""

    model_config = ConfigDict(extra="forbid")
    reason: OptionalReason = None


class RunningLateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    minutes: Annotated[int, Field(ge=5, le=240, description="How late the doctor expects to be.")]
    reason: OptionalReason = None


class NotifyItem(BaseModel):
    """One patient to tell. `deliver` is true only when the outcome is "to send": the web app
    sends the email (Idempotency-Key = `audit_id`) and then marks the audit row notified. For a
    demo or address-less patient nothing is to be sent and `email` is null."""

    audit_id: uuid.UUID
    appointment_id: uuid.UUID
    starts_at: _dt.datetime
    patient_name: str
    email: str | None
    deliver: bool
    outcome: NotifyOutcome


class NotifyResult(BaseModel):
    doctor_name: str
    items: list[NotifyItem]
