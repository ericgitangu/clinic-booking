from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict

from app.schemas.common import ClinicZoned, StrAwareDatetime


class ClaimedReminder(ClinicZoned):
    """One appointment to remind, with its instants in the offset of ``timezone``, the zone of the
    clinic the doctor works at (the email shows the time in that zone)."""

    appointment_id: uuid.UUID
    starts_at: datetime
    # The lease this claim holds; sending "sent" later must quote it (and the start time).
    claimed_at: datetime
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
    """What the email provider's free plan still allows: the day's and the month's counts (both
    UTC), and ``remaining``, how many more may be sent now, which is the smaller of the two."""

    day: date
    sent: int
    daily_limit: int
    month: date  # the first day of the UTC calendar month
    month_sent: int
    monthly_limit: int
    remaining: int


class EmailReservation(BaseModel):
    """The answer to "may I send one more email": ``granted`` means one was taken from both the day
    and the month (give it back with ``/emails/release`` if the send then fails); otherwise
    ``reason`` names the cap that refused it. ``day`` and ``month`` are what it was taken from."""

    granted: bool
    reason: Literal["day", "month"] | None
    day: date
    month: date
    budget: EmailBudget


class EmailRelease(BaseModel):
    """Which day and month a reserved email that was never sent is given back to."""

    model_config = ConfigDict(extra="forbid")
    day: date
    month: date
