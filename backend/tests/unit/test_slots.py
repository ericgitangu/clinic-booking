from __future__ import annotations

from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

import pytest

from app.domain.slots import InvalidSlotLength, Slot, generate_slots, grid_for_date, slot_length

NAIROBI = ZoneInfo("Africa/Nairobi")
BERLIN = ZoneInfo("Europe/Berlin")
OTIENO_MON = [(time(8, 0), time(12, 0)), (time(13, 0), time(17, 0))]
FAR_PAST = datetime(2026, 1, 1, tzinfo=UTC)


def _local_times(slots: list[Slot], tz: ZoneInfo) -> list[tuple[int, int]]:
    out = []
    for s in slots:
        local = s.starts_at.astimezone(tz)
        out.append((local.hour, local.minute))
    return out


def test_lunch_break_split() -> None:
    # A Monday well inside the horizon; far-past clock means no lead filtering.
    slots = generate_slots(
        OTIENO_MON, [], NAIROBI, datetime(2026, 10, 26).date(), FAR_PAST, timedelta(0)
    )
    locals_ = _local_times(slots, NAIROBI)
    assert len(slots) == 16
    assert (11, 30) in locals_
    assert (13, 0) in locals_
    assert (12, 0) not in locals_  # lunch break
    assert (12, 30) not in locals_


def test_lead_filter_excludes_near_slots() -> None:
    now = datetime(2026, 10, 26, 5, 0, tzinfo=UTC)  # 08:00 EAT Monday
    slots = generate_slots(
        OTIENO_MON, [], NAIROBI, datetime(2026, 10, 26).date(), now, timedelta(minutes=60)
    )
    # 08:00 and 08:30 EAT are within 60 min of now, so excluded.
    locals_ = _local_times(slots, NAIROBI)
    assert (8, 0) not in locals_
    assert (8, 30) not in locals_
    assert (9, 0) in locals_


def test_booked_slot_excluded() -> None:
    booked = [datetime(2026, 10, 26, 5, 0, tzinfo=UTC)]  # 08:00 EAT
    slots = generate_slots(
        OTIENO_MON, booked, NAIROBI, datetime(2026, 10, 26).date(), FAR_PAST, timedelta(0)
    )
    assert len(slots) == 15
    assert (8, 0) not in _local_times(slots, NAIROBI)


def test_berlin_dst_spring_forward_skips_nonexistent() -> None:
    # 2026-03-29: clocks jump 02:00 -> 03:00. A 01:00-04:00 window has no 02:xx slot.
    grid = grid_for_date([(time(1, 0), time(4, 0))], BERLIN, datetime(2026, 3, 29).date())
    locals_ = [(g.astimezone(BERLIN).hour, g.astimezone(BERLIN).minute) for g in grid]
    assert (2, 0) not in locals_
    assert (2, 30) not in locals_
    assert (1, 0) in locals_
    assert (3, 0) in locals_


def test_berlin_dst_fall_back_no_duplicate_slots() -> None:
    # 2026-10-25: clocks fall 03:00 -> 02:00. The repeated 02:xx hour yields one slot each.
    grid = grid_for_date([(time(1, 0), time(4, 0))], BERLIN, datetime(2026, 10, 25).date())
    locals_ = [(g.astimezone(BERLIN).hour, g.astimezone(BERLIN).minute) for g in grid]
    assert len(locals_) == len(set(locals_)), "fall-back produced duplicate local slots"
    assert locals_.count((2, 0)) == 1
    assert locals_.count((2, 30)) == 1


def test_empty_windows_yield_no_slots() -> None:
    assert (
        generate_slots([], [], NAIROBI, datetime(2026, 10, 26).date(), FAR_PAST, timedelta(0)) == []
    )


# --- slot length is a parameter -------------------------------------------------


def test_default_slot_length_is_thirty_minutes() -> None:
    assert slot_length(30) == timedelta(minutes=30)
    slots = generate_slots(
        OTIENO_MON, [], NAIROBI, datetime(2026, 10, 26).date(), FAR_PAST, timedelta(0)
    )
    assert all(s.ends_at - s.starts_at == timedelta(minutes=30) for s in slots)


def test_sixty_minute_slots_halve_the_grid() -> None:
    slots = generate_slots(
        OTIENO_MON,
        [],
        NAIROBI,
        datetime(2026, 10, 26).date(),
        FAR_PAST,
        timedelta(0),
        slot_length(60),
    )
    assert len(slots) == 8
    assert all(s.ends_at - s.starts_at == timedelta(minutes=60) for s in slots)
    assert _local_times(slots, NAIROBI)[:2] == [(8, 0), (9, 0)]


def test_a_slot_that_does_not_fit_the_window_is_not_offered() -> None:
    slots = generate_slots(
        [(time(8, 0), time(9, 30))],
        [],
        NAIROBI,
        datetime(2026, 10, 26).date(),
        FAR_PAST,
        timedelta(0),
        slot_length(60),
    )
    assert _local_times(slots, NAIROBI) == [(8, 0)]


def test_valid_lengths_are_the_divisors_of_a_day_from_five_minutes() -> None:
    for minutes in (5, 10, 15, 20, 30, 45, 60, 90, 120, 480, 1440):
        assert slot_length(minutes) == timedelta(minutes=minutes)


def test_invalid_lengths_are_refused() -> None:
    for minutes in (-30, 0, 1, 4, 7, 25, 50, 1441, 2000, 10**9):
        with pytest.raises(InvalidSlotLength):
            slot_length(minutes)
