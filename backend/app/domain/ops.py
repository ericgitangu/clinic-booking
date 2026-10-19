"""Pure rules for the operations board: gaps, status and "running behind". No I/O or clock."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal

BoardStatus = Literal["booked", "arrived", "no_show", "cancelled"]

# A doctor is running behind when an appointment that began this long ago is still unresolved:
# booked, and neither marked arrived nor no-show. Ten minutes is the grace before the desk is
# expected to have decided.
RUNNING_BEHIND_AFTER = timedelta(minutes=10)


def board_status(status: str, attendance: str | None) -> BoardStatus:
    """cancelled wins; otherwise the latest attendance mark; otherwise just booked."""
    if status == "cancelled":
        return "cancelled"
    if attendance == "arrived":
        return "arrived"
    if attendance == "no_show":
        return "no_show"
    return "booked"


@dataclass(frozen=True)
class Behind:
    behind: bool
    minutes: int
    appointment_id: object | None


def running_behind(unresolved: Sequence[tuple[object, datetime]], now: datetime) -> Behind:
    """`unresolved` holds (appointment id, start) of today's booked, unmarked appointments.

    Behind when the earliest of those started more than RUNNING_BEHIND_AFTER ago; `minutes` is how
    long ago it started (whole minutes, 0 when not behind).
    """
    started = [(i, s) for i, s in unresolved if s <= now]
    if not started:
        return Behind(False, 0, None)
    appt_id, start = min(started, key=lambda t: t[1])
    late = now - start
    if late > RUNNING_BEHIND_AFTER:
        return Behind(True, int(late.total_seconds() // 60), appt_id)
    return Behind(False, 0, None)


@dataclass(frozen=True)
class Gap:
    starts_at: datetime
    ends_at: datetime
    slots: int


def coalesce_gaps(free: Sequence[tuple[datetime, datetime]]) -> list[Gap]:
    """Merge back-to-back free slots (sorted by start) into gaps."""
    gaps: list[Gap] = []
    for start, end in free:
        if gaps and gaps[-1].ends_at == start:
            last = gaps[-1]
            gaps[-1] = Gap(last.starts_at, end, last.slots + 1)
        else:
            gaps.append(Gap(start, end, 1))
    return gaps
