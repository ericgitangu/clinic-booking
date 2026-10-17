from __future__ import annotations

import uuid
from datetime import date

from pydantic import BaseModel, ConfigDict

from app.schemas.common import ClinicDatetime, StrAwareDatetime


class ClaimedReminder(BaseModel):
    appointment_id: uuid.UUID
    starts_at: ClinicDatetime
    # The lease this claim holds; sending "sent" later must quote it (and the start time).
    claimed_at: ClinicDatetime
    doctor_name: str
    specialty: str
    patient_name: str
    patient_email: str


class ReminderBatch(BaseModel):
    """What one run may send now: the claimed appointments and the day's email budget."""

    # The clinic-local date these appointments are on.
    date: date
    items: list[ClaimedReminder]
    sent_today: int
    daily_limit: int


class ReminderSentRequest(BaseModel):
    """What was claimed: marking sent only applies if the appointment is still that claim."""

    model_config = ConfigDict(extra="forbid")
    claimed_at: StrAwareDatetime
    starts_at: StrAwareDatetime


class ReminderSent(BaseModel):
    appointment_id: uuid.UUID
    sent: bool


class EmailBudget(BaseModel):
    day: date
    sent: int
    daily_limit: int
    remaining: int
