from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, field_validator

from app.schemas.common import ClinicZoned, StrAwareDatetime


class AppointmentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    doctor_id: uuid.UUID
    patient_id: uuid.UUID
    starts_at: StrAwareDatetime


class RescheduleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    starts_at: StrAwareDatetime


def _strip(value: object) -> object:
    return value.strip() if isinstance(value, str) else value


class CancelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # Trim first, then bound the trimmed text, so surrounding whitespace never counts against
    # the limit and the stored reason is the trimmed one.
    reason: Annotated[str, BeforeValidator(_strip), Field(min_length=3, max_length=500)]

    @field_validator("reason")
    @classmethod
    def _no_nul(cls, v: str) -> str:
        if "\x00" in v:
            raise ValueError("reason must not contain NUL characters")
        return v


class Appointment(ClinicZoned):
    """An appointment, with its instants in the offset of ``timezone``, its doctor's clinic zone."""

    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    doctor_id: uuid.UUID
    patient_id: uuid.UUID
    starts_at: datetime
    ends_at: datetime
    status: Literal["booked", "cancelled"]
    cancellation_reason: str | None
    cancelled_at: datetime | None
    # True once staff vetoed a change of the patient's: the patient can no longer cancel or move it
    # (APPOINTMENT_LOCKED). Only the flag, never the staff reason.
    locked: bool
    created_at: datetime
    updated_at: datetime


class DoctorRef(BaseModel):
    id: uuid.UUID
    full_name: str
    specialty: str


class AppointmentWithDoctor(Appointment):
    doctor: DoctorRef


class PatientAppointments(BaseModel):
    items: list[AppointmentWithDoctor]
    next_cursor: None = None
