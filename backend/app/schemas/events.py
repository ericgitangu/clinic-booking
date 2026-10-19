"""Event contract v1: what is pushed to browsers. Non-personal by construction.

The patient channel carries ``SlotEvent``; the admin channel carries ``AdminEvent``. Neither has an
appointment id, a patient field or a time of occurrence. The JSON Schemas under ``contracts/events``
are exported from these models (``scripts/export_openapi.py``) and a test keeps them in step; the
same models are placed in the OpenAPI components so the generated clients carry types and zod
schemas for them.
"""

from __future__ import annotations

import datetime as _dt
import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

# Cursor of the event, "<txid>.<id>", plus ".<part>" for a patient message: see app.domain.realtime.
SEQ_PATTERN = r"^(0|[1-9][0-9]{0,19})\.(0|[1-9][0-9]{0,19})\.[01]$"
CURSOR_PATTERN = r"^(0|[1-9][0-9]{0,19})\.(0|[1-9][0-9]{0,19})$"


class SlotEvent(BaseModel):
    """A time of one doctor on one clinic-local day was taken or became free again."""

    model_config = ConfigDict(extra="forbid", title="SlotEvent")
    doctor_id: uuid.UUID
    local_date: _dt.date = Field(description="Clinic-local date of the slot (the channel's date).")
    starts_at: _dt.datetime = Field(description="The slot's start as a UTC instant (…Z).")
    kind: Literal["slot_taken", "slot_freed"]
    seq: str = Field(
        pattern=SEQ_PATTERN,
        description=(
            '"<txid>.<id>.<part>": apply a message only if it sorts after the last one applied '
            "and its (txid, id) is after the cursor of the availability response in use."
        ),
    )


class AdminEvent(BaseModel):
    """A booking changed, for the staff dashboard. No appointment or patient identifiers."""

    model_config = ConfigDict(extra="forbid", title="AdminEvent")
    event_type: Literal[
        "booked", "rescheduled", "cancelled", "vetoed", "unlocked", "arrived", "no_show"
    ]
    doctor_id: uuid.UUID
    local_date: _dt.date
    from_local_date: _dt.date | None
    from_starts_at: _dt.datetime | None
    to_starts_at: _dt.datetime | None
    seq: str = Field(pattern=CURSOR_PATTERN, description='"<txid>.<id>" of the event.')


class StaffEvent(AdminEvent):
    """The same event for an owner or admin on the live feed: it adds the appointment (to link to
    it), the patient's name and, for a cancellation, the reason. Only the Go gateway
    (``services/realtime``) sends it, over the admin app's IAM-protected stream; it never travels
    through the push service. A viewer gets ``AdminEvent`` instead."""

    model_config = ConfigDict(extra="forbid", title="StaffEvent")
    appointment_id: uuid.UUID
    patient_name: str
    cancellation_reason: str | None
    actor_email: str | None = Field(
        description="The staff member who made the change; null for a patient's own change."
    )
    actor_role: Literal["owner", "admin", "viewer"] | None
    staff_reason: str | None = Field(
        description="The reason the staff member recorded (veto, unlock, attendance, staff "
        "booking, reschedule or cancel); null for a patient's own change."
    )


ActionKind = Literal[
    "reminder_now", "running_late", "invite_created", "invite_revoked", "invite_accepted"
]


class AdminActionEvent(BaseModel):
    """A staff action that changed no appointment (a reminder sent now, "running late", an
    invitation), for a viewer of the live feed: what happened and, for the two patient
    notifications, the doctor and the visit time. No person, no reason, no address. Streamed only
    by the Go gateway from ``staff_action_audit``; it never travels through the push service."""

    model_config = ConfigDict(extra="forbid", title="AdminActionEvent")
    kind: ActionKind
    doctor_id: uuid.UUID | None
    starts_at: _dt.datetime | None
    delay_minutes: int | None
    seq: str = Field(pattern=CURSOR_PATTERN, description='"<txid>.<id>" of the event.')


class StaffActionEvent(AdminActionEvent):
    """The same staff action for an owner or admin: who did it, why, the patient (for a reminder
    or "running late") and the invited address and role (for an invitation)."""

    model_config = ConfigDict(extra="forbid", title="StaffActionEvent")
    appointment_id: uuid.UUID | None
    patient_name: str | None
    actor_email: str
    actor_role: Literal["owner", "admin", "viewer"]
    reason: str
    invite_email: str | None
    invite_role: Literal["admin", "viewer"] | None


class RealtimeToken(BaseModel):
    """A short-lived subscribe-only credential for one channel (a signed JWT)."""

    token: str
    channel: str
    stream_url: str = Field(description="Open this URL with `Authorization: Bearer <token>`.")
    expires_at: _dt.datetime
    ttl_seconds: int


class PatientTokenRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    doctor_id: uuid.UUID
    date: _dt.date


EVENT_MODELS: dict[str, type[BaseModel]] = {
    "SlotEvent": SlotEvent,
    "AdminEvent": AdminEvent,
    "StaffEvent": StaffEvent,
    "AdminActionEvent": AdminActionEvent,
    "StaffActionEvent": StaffActionEvent,
}


def event_json_schemas() -> dict[str, dict[str, object]]:
    """Standalone JSON Schemas (draft 2020-12) of the pushed messages, by file stem."""
    out: dict[str, dict[str, object]] = {}
    for stem, model in (
        ("slot-event.v1", SlotEvent),
        ("admin-event.v1", AdminEvent),
        ("staff-event.v1", StaffEvent),
        ("admin-action.v1", AdminActionEvent),
        ("staff-action.v1", StaffActionEvent),
    ):
        schema = model.model_json_schema()
        out[stem] = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": f"https://clinic.example/contracts/events/{stem}.schema.json",
            **schema,
        }
    return out
