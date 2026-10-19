"""Response shapes of the operations dashboard (``/internal/admin/ops/*``)."""

from __future__ import annotations

import datetime as _dt
import uuid
from typing import Literal

from pydantic import BaseModel

from app.domain.ops import BoardStatus
from app.domain.reasons import Category
from app.schemas.admin import AppointmentStatus, DateRange
from app.schemas.common import ClinicZoned

View = Literal["full", "minimised"]


class BoardAppointment(ClinicZoned):
    id: uuid.UUID
    starts_at: _dt.datetime
    ends_at: _dt.datetime
    status: BoardStatus
    # Owner and admin: full name and phone. Viewer: initials and a masked phone.
    patient_name: str
    patient_phone: str | None
    locked: bool
    # True when the appointment's latest change was recorded as the patient's and a veto would
    # act on it (the veto action would not answer NOTHING_TO_VETO).
    patient_changed: bool


class BoardGap(ClinicZoned):
    """Back-to-back free 30-minute slots, merged."""

    starts_at: _dt.datetime
    ends_at: _dt.datetime
    slots: int


class RunningBehind(BaseModel):
    """True when the earliest booked, unmarked appointment of today began more than 10 minutes
    ago (nobody has marked the patient arrived or no-show). `minutes` is how long ago it began."""

    behind: bool
    minutes: int
    appointment_id: uuid.UUID | None


class DoctorBoard(BaseModel):
    doctor_id: uuid.UUID
    name: str
    specialty: str
    timezone: str
    date: _dt.date
    appointments: list[BoardAppointment]
    next_gap: BoardGap | None
    free_slots: int
    running_behind: RunningBehind


class BoardTotals(BaseModel):
    booked: int
    arrived: int
    no_show: int
    cancelled: int


class TodayBoard(BaseModel):
    view: View
    doctors: list[DoctorBoard]
    totals: BoardTotals


class KpiValue(BaseModel):
    value: float | None
    previous: float | None
    # value - previous; null when either is undefined.
    delta: float | None


class KpiCounts(BaseModel):
    offered: int
    booked: int
    cancelled: int
    arrived: int
    no_show: int


class Kpis(BaseModel):
    range: DateRange
    previous_range: DateRange
    # arrived / offered slots.
    utilisation: KpiValue
    # booked (not cancelled) / offered slots.
    fill_rate: KpiValue
    # cancelled / (booked + cancelled).
    cancellation_rate: KpiValue
    # no_show / (arrived + no_show): only appointments the desk has marked.
    no_show_rate: KpiValue
    # Median of (start - created) for booked appointments, in minutes.
    median_lead_minutes: KpiValue
    # Reschedule events in the period.
    reschedules: KpiValue
    counts: KpiCounts


class ReasonShare(BaseModel):
    category: Category
    count: int
    share: float


class ReasonBreakdown(BaseModel):
    range: DateRange
    total: int
    items: list[ReasonShare]


class HeatCell(BaseModel):
    weekday: int  # 1 = Monday ... 7 = Sunday, in the clinic's zone
    hour: int  # 0-23 local
    count: int


class Heatmap(BaseModel):
    range: DateRange
    doctor_id: uuid.UUID | None
    max: int
    cells: list[HeatCell]


class FreeSlot(ClinicZoned):
    doctor_id: uuid.UUID
    doctor_name: str
    starts_at: _dt.datetime
    ends_at: _dt.datetime


class GapList(BaseModel):
    hours: int
    items: list[FreeSlot]
    truncated: bool


ChangeKind = Literal["booked", "rescheduled", "cancelled"]


class ChangeItem(ClinicZoned):
    """One booking, reschedule or cancellation, placed by the day the change happened."""

    appointment_id: uuid.UUID
    doctor_id: uuid.UUID
    doctor_name: str
    # Owner and admin: the full name. Viewer: initials.
    patient_name: str
    kind: ChangeKind
    occurred_at: _dt.datetime
    actor: Literal["patient", "staff"] | None
    # Reschedules only: where the visit was and where it went.
    from_starts_at: _dt.datetime | None
    to_starts_at: _dt.datetime | None
    # Where the appointment stands now, not at the time of the change.
    starts_at: _dt.datetime
    status: AppointmentStatus
    attendance: Literal["arrived", "no_show"] | None
    # Cancellations only. Never present for a viewer.
    reason: str | None
    reason_category: Category | None


class ChangeList(BaseModel):
    view: View
    kind: ChangeKind
    range: DateRange
    # Over the whole range and filters, whatever the page size or cursor.
    total: int
    items: list[ChangeItem]
    next_cursor: str | None
