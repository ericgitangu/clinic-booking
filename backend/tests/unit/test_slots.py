from __future__ import annotations

from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

from app.domain.slots import Slot, generate_slots, grid_for_date

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
    booked = [
        (datetime(2026, 10, 26, 5, 0, tzinfo=UTC), datetime(2026, 10, 26, 5, 30, tzinfo=UTC))
    ]  # 08:00 EAT
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


# --- the slot length is a parameter of the pure function (production wires only 30 minutes) ---

DAY = datetime(2026, 10, 26).date()
HOUR = timedelta(minutes=60)
QUARTER = timedelta(minutes=15)


def _at(hour: int, minute: int = 0) -> datetime:
    """A clinic-local (Nairobi) wall time on DAY as an aware UTC instant."""
    return datetime.combine(DAY, time(hour, minute), tzinfo=NAIROBI).astimezone(UTC)


def _interval(hour: int, minute: int, length_minutes: int) -> tuple[datetime, datetime]:
    start = _at(hour, minute)
    return start, start + timedelta(minutes=length_minutes)


def _starts(slots: list[Slot]) -> list[tuple[int, int]]:
    return _local_times(slots, NAIROBI)


def test_default_slot_length_is_thirty_minutes() -> None:
    slots = generate_slots(OTIENO_MON, [], NAIROBI, DAY, FAR_PAST, timedelta(0))
    assert all(s.ends_at - s.starts_at == timedelta(minutes=30) for s in slots)


def test_sixty_minute_slots_halve_the_grid() -> None:
    slots = generate_slots(OTIENO_MON, [], NAIROBI, DAY, FAR_PAST, timedelta(0), HOUR)
    assert len(slots) == 8
    assert all(s.ends_at - s.starts_at == HOUR for s in slots)
    assert _starts(slots)[:2] == [(8, 0), (9, 0)]


def test_a_slot_that_does_not_fit_the_window_is_not_offered() -> None:
    slots = generate_slots(
        [(time(8, 0), time(9, 30))], [], NAIROBI, DAY, FAR_PAST, timedelta(0), HOUR
    )
    assert _starts(slots) == [(8, 0)]


def test_a_half_hour_booking_removes_the_hour_slot_that_contains_it() -> None:
    # 08:30-09:00 is booked; the 08:00-09:00 slot overlaps it even though no start matches.
    slots = generate_slots(
        OTIENO_MON, [_interval(8, 30, 30)], NAIROBI, DAY, FAR_PAST, timedelta(0), HOUR
    )
    assert (8, 0) not in _starts(slots)
    assert (9, 0) in _starts(slots)


def test_an_hour_booking_removes_both_half_hour_slots_it_covers() -> None:
    slots = generate_slots(OTIENO_MON, [_interval(9, 0, 60)], NAIROBI, DAY, FAR_PAST, timedelta(0))
    starts = _starts(slots)
    assert (9, 0) not in starts and (9, 30) not in starts
    assert (8, 30) in starts and (10, 0) in starts


def test_a_fifteen_minute_grid_drops_every_slot_a_booking_overlaps() -> None:
    slots = generate_slots(
        OTIENO_MON, [_interval(8, 10, 30)], NAIROBI, DAY, FAR_PAST, timedelta(0), QUARTER
    )
    starts = _starts(slots)
    # 08:10-08:40 overlaps 08:00, 08:15 and 08:30 (08:45 starts after it ends).
    assert [t for t in starts if t < (8, 45)] == []
    assert (8, 45) in starts


def test_touching_intervals_do_not_overlap() -> None:
    slots = generate_slots(OTIENO_MON, [_interval(8, 0, 30)], NAIROBI, DAY, FAR_PAST, timedelta(0))
    assert (8, 30) in _starts(slots)


def test_a_booking_that_started_before_the_day_still_blocks_its_overlap() -> None:
    # An interval that begins 23:30 the previous evening and runs to 00:30 overlaps a 00:00 slot.
    slots = generate_slots(
        [(time(0, 0), time(2, 0))],
        [(_at(0) - timedelta(minutes=30), _at(0) + timedelta(minutes=30))],
        NAIROBI,
        DAY,
        FAR_PAST,
        timedelta(0),
    )
    assert (0, 0) not in _starts(slots) and (0, 30) in _starts(slots)
