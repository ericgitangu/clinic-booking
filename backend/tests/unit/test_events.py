from __future__ import annotations

from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

from app.domain.events import booked_event, cancelled_event, rescheduled_event

NAIROBI = ZoneInfo("Africa/Nairobi")
NEW_YORK = ZoneInfo("America/New_York")
# 22:00Z on the 26th is 01:00 on the 27th in Nairobi but still the 26th in New York.
LATE = datetime(2026, 10, 26, 22, 0, tzinfo=UTC)
MORNING = datetime(2026, 10, 26, 6, 0, tzinfo=UTC)


def test_booked_event_carries_only_the_new_start_and_its_local_date() -> None:
    e = booked_event(LATE, NAIROBI)
    assert (e.event_type, e.from_starts_at, e.to_starts_at) == ("booked", None, LATE)
    assert e.local_date == date(2026, 10, 27)
    assert e.from_local_date is None


def test_local_date_follows_the_clinic_zone() -> None:
    assert booked_event(LATE, NEW_YORK).local_date == date(2026, 10, 26)


def test_cancelled_event_carries_only_the_old_start_and_its_local_date() -> None:
    e = cancelled_event(LATE, NAIROBI)
    assert (e.event_type, e.from_starts_at, e.to_starts_at) == ("cancelled", LATE, None)
    assert e.local_date == date(2026, 10, 27)
    assert e.from_local_date is None


def test_reschedule_within_a_day_has_no_from_local_date() -> None:
    later = datetime(2026, 10, 26, 7, 0, tzinfo=UTC)
    e = rescheduled_event(MORNING, later, NAIROBI)
    assert (e.event_type, e.from_starts_at, e.to_starts_at) == ("rescheduled", MORNING, later)
    assert e.local_date == date(2026, 10, 26)
    assert e.from_local_date is None


def test_reschedule_across_days_records_the_day_it_left() -> None:
    e = rescheduled_event(MORNING, LATE, NAIROBI)
    assert e.local_date == date(2026, 10, 27)
    assert e.from_local_date == date(2026, 10, 26)
