"""Booking-time validation.

``validate_slot`` raises the validation errors in a fixed order so the API returns the most
specific, earliest-failing reason.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from app.domain.errors import (
    BookingTooSoon,
    DateOutOfRange,
    DomainError,
    OutsideWorkingHours,
    SlotInPast,
    SlotMisaligned,
)
from app.domain.slots import Window, grid_for_date

# The words the OpenAPI contract uses for the one-hour rule. The contract test
# (tests/contract/test_one_hour_contract.py) asserts the generated spec carries them, so the
# documentation cannot drift from the code.
RULE_BOOK = (
    "Refused with 422 BOOKING_TOO_SOON when the appointment begins less than 60 minutes from now "
    "(BOOKING_MIN_LEAD_MINUTES)."
)
RULE_CANCEL = (
    "Refused with 409 CHANGE_TOO_LATE when the appointment begins less than 60 minutes from now "
    "(BOOKING_MIN_LEAD_MINUTES)."
)
RULE_RESCHEDULE = (
    "Refused with 409 CHANGE_TOO_LATE when the appointment's current start begins less than 60 "
    "minutes from now (BOOKING_MIN_LEAD_MINUTES), and with 422 BOOKING_TOO_SOON when the new "
    "start does, exactly as for a fresh booking. Repeating a reschedule that already happened "
    "(same new start) returns the appointment."
)
RULE_AVAILABILITY = "Slots starting within 60 minutes are never offered."


def require_lead_time(
    starts_at: datetime, now: datetime, lead: timedelta, error: type[DomainError]
) -> None:
    """The one-hour rule, in one place: raise ``error`` when ``starts_at`` is less than ``lead``
    from ``now``. Exactly ``lead`` away is allowed. Booking and a reschedule's new time call this
    through ``validate_slot`` (BOOKING_TOO_SOON); cancel and a reschedule's current time call it
    directly (CHANGE_TOO_LATE)."""
    if starts_at.astimezone(UTC) < now.astimezone(UTC) + lead:
        raise error()


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
    require_lead_time(starts_at, now, lead, BookingTooSoon)

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
