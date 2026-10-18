"""Response shapes of ``/internal/admin/*`` (read-only aggregates for the admin dashboard)."""

from __future__ import annotations

import datetime as _dt
import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.common import ClinicZoned

Bucket = Literal["day", "hour"]
AppointmentStatus = Literal["booked", "cancelled"]
EventType = Literal["booked", "rescheduled", "cancelled"]


class DateRange(BaseModel):
    """Clinic-local dates; ``from`` inclusive, ``to`` exclusive."""

    model_config = ConfigDict(populate_by_name=True)

    from_: _dt.date = Field(alias="from")
    to: _dt.date


class SeriesPoint(BaseModel):
    # Clinic-local start of the bucket as ISO 8601 without an offset ("2026-10-17T00:00:00"): a
    # local day or hour is not an instant, so it is a string and not a date-time.
    bucket_start: str = Field(
        description=(
            "Start of the bucket as ISO 8601 local time without an offset, in the zone of the "
            "clinic each event belongs to (not an instant). With clinics in different zones, "
            "events fall in the bucket of their own clinic's local day or hour, so a series "
            "merges the same local hour or day of every clinic."
        )
    )
    booked: int
    rescheduled: int
    cancelled: int


class Totals(BaseModel):
    booked: int
    rescheduled: int
    cancelled: int
    upcoming_active: int


class DoctorLoad(BaseModel):
    doctor_id: uuid.UUID
    name: str
    booked_visits: int
    cancelled_actions: int
    capacity: int
    utilization: float | None


class Metrics(BaseModel):
    range: DateRange
    bucket: Bucket
    series: list[SeriesPoint]
    totals: Totals
    per_doctor: list[DoctorLoad]


class AdminAppointment(ClinicZoned):
    id: uuid.UUID
    doctor_id: uuid.UUID
    doctor_name: str
    patient_id: uuid.UUID
    patient_name: str
    starts_at: _dt.datetime
    ends_at: _dt.datetime
    status: AppointmentStatus
    cancellation_reason: str | None
    created_at: _dt.datetime


class AdminAppointmentPage(BaseModel):
    items: list[AdminAppointment]
    next_cursor: str | None


class LineageEvent(BaseModel):
    id: int
    event_type: EventType
    from_starts_at: _dt.datetime | None
    to_starts_at: _dt.datetime | None
    occurred_at: _dt.datetime


class Lineage(BaseModel):
    appointment_id: uuid.UUID
    events: list[LineageEvent]
