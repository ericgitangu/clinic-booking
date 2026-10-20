"""Shapes of the doctor email and the record of telling a doctor a patient arrived. Staff only."""

from __future__ import annotations

import datetime as _dt
import re
import uuid
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, field_validator

from app.domain.emailnorm import normalize_email
from app.schemas.appointment import _strip

# The same reason every staff write carries: trimmed, 3 to 500 characters.
Reason = Annotated[str, BeforeValidator(_strip), Field(min_length=3, max_length=500)]

NoticeStatus = Literal["pending", "sent", "failed", "skipped"]
NoticeReason = Literal[
    "no_email", "allowance_day", "allowance_month", "demo_address", "not_configured"
]

# One @, something either side, a dot in the domain, no spaces: what the table's CHECK enforces.
# Deliverability is not checked here; the provider is the judge of that.
_SHAPE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _normalise(value: object) -> object:
    if isinstance(value, str):
        if "\x00" in value:
            raise ValueError("the address must not contain NUL characters")
        value = normalize_email(value)
        return value or None  # a blank address clears it
    return value


class DoctorEmailRequest(BaseModel):
    """Set the doctor's address, or clear it with ``email: null`` (or a blank)."""

    model_config = ConfigDict(extra="forbid")
    email: Annotated[Annotated[str, Field(max_length=254)] | None, BeforeValidator(_normalise)]
    reason: Reason

    @field_validator("email")
    @classmethod
    def _well_formed(cls, v: str | None) -> str | None:
        if v is not None and (len(v) < 6 or not _SHAPE.match(v)):
            raise ValueError("enter an email address like name@clinic.example")
        return v


class DoctorEmail(BaseModel):
    doctor_id: uuid.UUID
    email: str | None
    audit_id: uuid.UUID | None = Field(
        description="The audit row of this change; null when the address was already that."
    )


class DoctorNoticeState(BaseModel):
    """Where telling the doctor stands. ``reason`` says why a row was skipped."""

    id: uuid.UUID
    status: NoticeStatus
    reason: NoticeReason | None
    attempts: int
    sent_at: _dt.datetime | None


class DoctorNoticeToSend(BaseModel):
    """What the web app needs to write and send the arrival email, once it holds the claim."""

    id: uuid.UUID
    appointment_id: uuid.UUID
    attempt: int
    doctor_email: str
    doctor_name: str
    patient_name: str
    starts_at: _dt.datetime
    timezone: str


class DoctorNoticeFinish(BaseModel):
    model_config = ConfigDict(extra="forbid")
    outcome: Literal["sent", "failed", "skipped"]
    provider_id: Annotated[Annotated[str, Field(max_length=200)] | None, Field()] = None
    error: Annotated[Annotated[str, Field(max_length=300)] | None, Field()] = None
    reason: NoticeReason | None = None


class DoctorNoticeFinished(BaseModel):
    id: uuid.UUID
    status: NoticeStatus
    updated: bool = Field(description="False when the row was not held by a claim or was final.")


class DoctorNoticeClaim(BaseModel):
    """``send`` is set when the caller now holds the claim and should send; otherwise the row is
    sent, skipped, out of attempts or held by another sender, and there is nothing to do."""

    send: DoctorNoticeToSend | None
