from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.domain.ops import RUNNING_BEHIND_AFTER, board_status, coalesce_gaps, running_behind

T0 = datetime(2026, 10, 27, 7, 0, tzinfo=UTC)
M = timedelta(minutes=30)


def test_board_status_precedence() -> None:
    assert board_status("cancelled", "arrived") == "cancelled"
    assert board_status("booked", "arrived") == "arrived"
    assert board_status("booked", "no_show") == "no_show"
    assert board_status("booked", None) == "booked"


def test_running_behind_needs_an_unresolved_start_more_than_ten_minutes_ago() -> None:
    now = T0 + RUNNING_BEHIND_AFTER
    assert not running_behind([("a", T0)], now).behind  # exactly ten minutes: still within grace
    late = running_behind([("a", T0)], now + timedelta(seconds=1))
    assert late.behind and late.minutes == 10 and late.appointment_id == "a"
    assert not running_behind([("a", T0 + M)], now).behind  # starts later: not yet
    assert not running_behind([], now).behind


def test_running_behind_reports_the_earliest_unresolved() -> None:
    now = T0 + timedelta(minutes=50)
    result = running_behind([("b", T0 + M), ("a", T0)], now)
    assert result.appointment_id == "a" and result.minutes == 50


def test_coalesce_gaps_merges_only_back_to_back_slots() -> None:
    free = [(T0, T0 + M), (T0 + M, T0 + 2 * M), (T0 + 3 * M, T0 + 4 * M)]
    gaps = coalesce_gaps(free)
    assert [(g.starts_at, g.ends_at, g.slots) for g in gaps] == [
        (T0, T0 + 2 * M, 2),
        (T0 + 3 * M, T0 + 4 * M, 1),
    ]
    assert coalesce_gaps([]) == []
