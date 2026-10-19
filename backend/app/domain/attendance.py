"""When arrival and no-show can be recorded, and what the status of an appointment is."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Literal

Attendance = Literal["arrived", "no_show"]

OPENS_BEFORE = timedelta(minutes=15)
CLOSES_AFTER = timedelta(hours=2)


def window_is_open(starts_at: datetime, now: datetime, kind: Attendance = "arrived") -> bool:
    """Arrival: from 15 minutes before the start to 2 hours after it. No-show: from the start (a
    patient cannot fail to turn up for a visit that has not begun) to 2 hours after it. Both ends
    are included."""
    opens = starts_at - OPENS_BEFORE if kind == "arrived" else starts_at
    return opens <= now <= starts_at + CLOSES_AFTER
