from __future__ import annotations

import uuid

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.common import StrAwareDatetime


class AccountLinkRequest(BaseModel):
    """What the web app knows from the sign-in besides the signed identity: the display name."""

    model_config = ConfigDict(extra="forbid")
    full_name: str = Field(min_length=2, max_length=200)


class AccountLinked(BaseModel):
    patient_id: uuid.UUID
    # True on the call that created the patient, False on every later call for the same sign-in.
    created: bool


class MeAppointmentCreate(BaseModel):
    """Booking as the signed-in patient: the patient comes from the account, never from the body."""

    model_config = ConfigDict(extra="forbid")
    doctor_id: uuid.UUID
    starts_at: StrAwareDatetime
