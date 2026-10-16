"""The single source of 'now'.

This is the only module permitted to read the wall clock; ruff bans the time APIs
everywhere else. A ``Clock`` is injected so tests are deterministic.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Protocol


class Clock(Protocol):
    def now(self) -> datetime:
        """Return an aware UTC instant."""
        ...


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(UTC)


class FakeClock:
    """A fixed clock for tests. ``FakeClock(datetime(2026,10,19,4,0,tzinfo=UTC))`` is
    Monday 07:00 EAT."""

    def __init__(self, fixed: datetime) -> None:
        if fixed.tzinfo is None:
            raise ValueError("FakeClock requires an aware datetime")
        self._fixed = fixed.astimezone(UTC)

    def now(self) -> datetime:
        return self._fixed
