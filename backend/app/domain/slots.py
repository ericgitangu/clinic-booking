"""Slot computation.

Slots are computed, never stored. The grid for a clinic-local date is built by stepping in
UTC so DST is handled correctly: spring-forward gaps are skipped inherently, and fall-back
repeats are de-duplicated by clinic-local wall time.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from app.domain.errors import DomainError

SLOT = timedelta(minutes=30)
DEFAULT_SLOT_MINUTES = 30
MIN_SLOT_MINUTES = 5
MINUTES_PER_DAY = 24 * 60

Window = tuple[time, time]  # (start_time, end_time), clinic-local wall times on the grid


class InvalidSlotLength(DomainError):
    """A slot length the grid cannot honour; reported as VALIDATION_ERROR (422)."""

    code = "VALIDATION_ERROR"


def slot_length(minutes: int) -> timedelta:
    """The slot length as a duration, or InvalidSlotLength.

    Rejects non-positive and absurd values (under 5 minutes, or over a day) and any length that
    does not divide the day evenly, so a grid never straddles midnight unevenly.
    """
    if minutes < MIN_SLOT_MINUTES or minutes > MINUTES_PER_DAY:
        raise InvalidSlotLength(
            f"slot_minutes must be between {MIN_SLOT_MINUTES} and {MINUTES_PER_DAY}."
        )
    if MINUTES_PER_DAY % minutes != 0:
        raise InvalidSlotLength("slot_minutes must divide a day (1440 minutes) evenly.")
    return timedelta(minutes=minutes)


@dataclass(frozen=True)
class Slot:
    starts_at: datetime  # aware, UTC
    ends_at: datetime  # starts_at + the slot length


def grid_for_date(
    windows: Sequence[Window], tz: ZoneInfo, local_date: date, slot: timedelta = SLOT
) -> list[datetime]:
    """Aligned slot starts (UTC) for the date, before lead/booked filtering.

    De-duplicated by clinic-local wall time, so a fall-back repeated hour yields one slot.
    """
    starts: list[datetime] = []
    seen_local: set[tuple[int, int]] = set()
    for start_t, end_t in windows:
        start_utc = datetime.combine(local_date, start_t, tzinfo=tz).astimezone(UTC)
        end_utc = datetime.combine(local_date, end_t, tzinfo=tz).astimezone(UTC)
        cur = start_utc
        while cur + slot <= end_utc:
            local_wall = cur.astimezone(tz)
            # A slot start derived from a real UTC instant always round-trips; the spring-
            # forward gap never appears because UTC stepping jumps over it.
            key = (local_wall.hour, local_wall.minute)
            if key not in seen_local:
                seen_local.add(key)
                starts.append(cur)
            cur += slot
    starts.sort()
    return starts


def generate_slots(
    windows: Sequence[Window],
    booked_starts: Iterable[datetime],
    tz: ZoneInfo,
    local_date: date,
    now: datetime,
    lead: timedelta,
    slot: timedelta = SLOT,
) -> list[Slot]:
    """Bookable slots: the grid minus booked starts and anything inside the lead window."""
    booked = {b.astimezone(UTC) for b in booked_starts}
    threshold = now.astimezone(UTC) + lead
    out: list[Slot] = []
    for start in grid_for_date(windows, tz, local_date, slot):
        if start in booked:
            continue
        if start < threshold:
            continue
        out.append(Slot(starts_at=start, ends_at=start + slot))
    return out
