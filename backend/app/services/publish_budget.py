"""The hard monthly publish budget.

One row per calendar month in ``realtime_publish_budget``. Every message is debited before it is
published, atomically in the database::

    UPDATE ... SET used = used + :n WHERE month = :m AND used + :n <= :cap RETURNING used

so concurrent publishers can never spend more than the cap, however many API instances run. When a
debit is refused the relay stops publishing for the rest of the month (the Disabled behaviour:
clients see no events and poll), and the switch is logged once per month per process. Nothing here
relies on what the push service does at its own limit.
"""

from __future__ import annotations

import logging
from datetime import UTC, date, datetime

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.logging import APP_LOGGER

_log = logging.getLogger(APP_LOGGER)

_ENSURE = text(
    "INSERT INTO realtime_publish_budget (month, used, updated_at) VALUES (:m, 0, :now) "
    "ON CONFLICT (month) DO NOTHING"
)
_DEBIT = text(
    "UPDATE realtime_publish_budget SET used = used + :n, updated_at = :now "
    "WHERE month = :m AND used + :n <= :cap RETURNING used"
)
_REFUND = text(
    "UPDATE realtime_publish_budget SET used = greatest(used - :n, 0), updated_at = :now "
    "WHERE month = :m"
)
_USED = text("SELECT used FROM realtime_publish_budget WHERE month = :m")


def month_of(moment: datetime) -> date:
    """The first day of the calendar month (UTC) the instant falls in."""
    utc = moment.astimezone(UTC)
    return date(utc.year, utc.month, 1)


class PublishBudget:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession], cap: int) -> None:
        self._sessionmaker = sessionmaker
        self.cap = cap
        self._switch_logged: set[date] = set()

    async def debit(self, n: int, now: datetime) -> bool:
        """Reserve ``n`` publishes for this month; False when they do not fit under the cap."""
        if n <= 0:
            return True
        month = month_of(now)
        async with self._sessionmaker() as session, session.begin():
            await session.execute(_ENSURE, {"m": month, "now": now})
            row = (
                await session.execute(_DEBIT, {"m": month, "n": n, "now": now, "cap": self.cap})
            ).first()
        if row is None:
            self._log_switch_once(month)
            return False
        return True

    async def refund(self, n: int, now: datetime) -> None:
        """Give back a reservation for a batch that provably never left this process."""
        async with self._sessionmaker() as session, session.begin():
            await session.execute(_REFUND, {"m": month_of(now), "n": n, "now": now})

    async def used(self, now: datetime) -> int:
        async with self._sessionmaker() as session:
            value = (await session.execute(_USED, {"m": month_of(now)})).scalar_one_or_none()
        return int(value) if value is not None else 0

    async def exhausted(self, now: datetime) -> bool:
        return await self.used(now) >= self.cap

    def _log_switch_once(self, month: date) -> None:
        if month in self._switch_logged:
            return
        self._switch_logged.add(month)
        _log.warning(
            "realtime publish budget spent for %s (cap %s): push is off until next month",
            month.isoformat(),
            self.cap,
        )
