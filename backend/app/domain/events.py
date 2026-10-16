"""Audit-event field construction. Pure: no I/O, no clock reads.

local_date is the clinic-local date of to_starts_at (from_starts_at for a cancel);
from_local_date is set only when a reschedule crosses clinic-local days.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from zoneinfo import ZoneInfo


@dataclass(frozen=True)
class EventFields:
    event_type: str
    from_starts_at: datetime | None
    to_starts_at: datetime | None
    local_date: date
    from_local_date: date | None


def _local_date(dt: datetime, tz: ZoneInfo) -> date:
    return dt.astimezone(tz).date()


def booked_event(to_starts_at: datetime, tz: ZoneInfo) -> EventFields:
    return EventFields("booked", None, to_starts_at, _local_date(to_starts_at, tz), None)


def cancelled_event(from_starts_at: datetime, tz: ZoneInfo) -> EventFields:
    return EventFields("cancelled", from_starts_at, None, _local_date(from_starts_at, tz), None)


def rescheduled_event(
    from_starts_at: datetime, to_starts_at: datetime, tz: ZoneInfo
) -> EventFields:
    to_local = _local_date(to_starts_at, tz)
    from_local = _local_date(from_starts_at, tz)
    return EventFields(
        "rescheduled",
        from_starts_at,
        to_starts_at,
        to_local,
        from_local if from_local != to_local else None,
    )
