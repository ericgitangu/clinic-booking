from __future__ import annotations

from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

import pytest

from app.core.clock import FakeClock
from app.domain.booking_rules import validate_slot
from app.domain.errors import (
    BookingTooSoon,
    DateOutOfRange,
    OutsideWorkingHours,
    SlotInPast,
    SlotMisaligned,
)

NAIROBI = ZoneInfo("Africa/Nairobi")
OTIENO_MON = [(time(8, 0), time(12, 0)), (time(13, 0), time(17, 0))]
CLOCK = FakeClock(datetime(2026, 10, 19, 4, 0, tzinfo=UTC))  # Mon 07:00 EAT
LEAD = timedelta(minutes=60)
HORIZON = 90


def _validate(starts_at: datetime) -> None:
    validate_slot(starts_at, OTIENO_MON, NAIROBI, CLOCK.now(), LEAD, HORIZON)


def test_slot_in_past_rejected() -> None:
    with pytest.raises(SlotInPast):
        _validate(datetime(2026, 10, 19, 3, 0, tzinfo=UTC))


def test_lead_59min_rejected() -> None:
    with pytest.raises(BookingTooSoon):
        _validate(CLOCK.now() + timedelta(minutes=59))


def test_lead_60min_accepted() -> None:
    # now + 60 min = 08:00 EAT Monday, a valid Otieno slot.
    _validate(CLOCK.now() + timedelta(minutes=60))


def test_date_out_of_range_rejected() -> None:
    # 08:00 EAT ~100 days ahead, aligned and in-window, but beyond the 90-day horizon.
    far = datetime(2027, 2, 1, 5, 0, tzinfo=UTC)
    with pytest.raises(DateOutOfRange):
        _validate(far)


def test_misaligned_seconds() -> None:
    with pytest.raises(SlotMisaligned):
        _validate(datetime(2026, 10, 26, 5, 0, 15, tzinfo=UTC))  # 08:00:15 EAT


def test_off_grid_within_window_misaligned() -> None:
    # 08:15 EAT is inside the morning window but off the 30-minute grid.
    with pytest.raises(SlotMisaligned):
        _validate(datetime(2026, 10, 26, 5, 15, tzinfo=UTC))


def test_outside_working_hours_rejected() -> None:
    # 12:00 EAT is the lunch break, between the two windows.
    with pytest.raises(OutsideWorkingHours):
        _validate(datetime(2026, 10, 26, 9, 0, tzinfo=UTC))


def test_valid_afternoon_slot_accepted() -> None:
    _validate(datetime(2026, 10, 26, 10, 0, tzinfo=UTC))  # 13:00 EAT
