from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.common import ClinicDatetime, StrAwareDatetime


class AppointmentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    doctor_id: uuid.UUID
    patient_id: uuid.UUID
    starts_at: StrAwareDatetime


class RescheduleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    starts_at: StrAwareDatetime


class CancelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: str = Field(min_length=3, max_length=500)

    @field_validator("reason")
    @classmethod
    def _trim_nonblank(cls, v: str) -> str:
        if "\x00" in v:
            raise ValueError("reason must not contain NUL characters")
        trimmed = v.strip()
        if not (3 <= len(trimmed) <= 500):
            raise ValueError("reason must be 3..500 non-blank characters")
        return v


class Appointment(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    doctor_id: uuid.UUID
    patient_id: uuid.UUID
    starts_at: ClinicDatetime
    ends_at: ClinicDatetime
    status: Literal["booked", "cancelled"]
    cancellation_reason: str | None
    cancelled_at: ClinicDatetime | None
    created_at: ClinicDatetime
    updated_at: ClinicDatetime


class DoctorRef(BaseModel):
    id: uuid.UUID
    full_name: str
    specialty: str


class AppointmentWithDoctor(Appointment):
    doctor: DoctorRef


class PatientAppointments(BaseModel):
    items: list[AppointmentWithDoctor]
    next_cursor: None = None
