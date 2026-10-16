"""Booking-time validation (ADR-0005, ADR-0006).

``validate_slot`` raises the §6 errors in a fixed order so the API returns the most
specific, earliest-failing reason.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from app.domain.errors import (
    BookingTooSoon,
    DateOutOfRange,
    OutsideWorkingHours,
    SlotInPast,
    SlotMisaligned,
)
from app.domain.slots import Window, grid_for_date


def validate_slot(
    starts_at: datetime,
    windows: Sequence[Window],
    tz: ZoneInfo,
    now: datetime,
    lead: timedelta,
    horizon_days: int,
) -> None:
    starts_at = starts_at.astimezone(UTC)
    now = now.astimezone(UTC)

    if starts_at <= now:
        raise SlotInPast()
    if starts_at < now + lead:
        raise BookingTooSoon()

    local = starts_at.astimezone(tz)
    local_today = now.astimezone(tz).date()
    if local.date() > local_today + timedelta(days=horizon_days):
        raise DateOutOfRange()

    if starts_at.second != 0 or starts_at.microsecond != 0:
        raise SlotMisaligned()

    if starts_at in grid_for_date(windows, tz, local.date()):
        return

    # Not a valid grid point: distinguish off-grid-within-a-window from outside hours.
    local_time = local.time()
    inside_window = any(ws <= local_time < we for ws, we in windows)
    if inside_window:
        raise SlotMisaligned()
    raise OutsideWorkingHours()
