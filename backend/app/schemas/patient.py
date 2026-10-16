from __future__ import annotations

import uuid

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.schemas.common import ClinicDatetime


class PatientCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    full_name: str = Field(min_length=2, max_length=200)
    phone: str | None = Field(default=None, pattern=r"^\+[1-9][0-9]{7,14}$")
    email: EmailStr | None = None

    @field_validator("full_name")
    @classmethod
    def _trim_nonblank(cls, v: str) -> str:
        if len(v.strip()) < 2:
            raise ValueError("full_name must be at least 2 non-blank characters")
        return v


class Patient(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    full_name: str
    phone: str | None
    email: str | None
    created_at: ClinicDatetime
