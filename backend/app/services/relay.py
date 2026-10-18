"""The outbox relay: hand committed events to the push service, at least once, in order.

``relay_once`` runs inside one transaction:

1. take the single cursor row ``FOR UPDATE SKIP LOCKED`` (a second relay returns at once);
2. read events after the cursor whose writing transaction is older than the snapshot's ``xmin``
   (every such transaction has finished, so no earlier event can still appear), at most 100;
3. drop events too old to matter, debit the monthly budget, publish them in one batch with
   deterministic ids ``<txid>.<id>`` (``…<part>`` for patient messages);
4. advance the cursor only after the push service accepted the batch.

A failure leaves the cursor where it was, so the next trigger retries; a repeat inside the push
service's duplicate window is dropped by id, and consumers also order by ``seq``.

It is called synchronously right after each committing write, with a short timeout, before the
response is sent. It is never a background task: Cloud Run throttles CPU once the response is out.
There is no always-on worker, so an event stuck behind a concurrent open transaction waits for
the next trigger; the clients' safety-net poll covers that gap.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timedelta

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.clock import Clock
from app.core.config import Settings
from app.core.logging import APP_LOGGER
from app.domain.realtime import OutboundMessage, OutboxEvent, messages_for
from app.services.publish_budget import PublishBudget
from app.services.publisher import EventPublisher, PublishError

_log = logging.getLogger(APP_LOGGER)

BATCH = 100

_CURSOR = text(
    "SELECT txid::text AS txid, id FROM event_relay_cursor WHERE singleton FOR UPDATE SKIP LOCKED"
)
# One statement, so the horizon and the read agree. txid travels as text: asyncpg has no xid8 codec.
_EVENTS = text(
    """
    SELECT id, txid::text AS txid, doctor_id, event_type, from_starts_at, to_starts_at,
           local_date, from_local_date, occurred_at
    FROM appointment_events
    WHERE txid < pg_snapshot_xmin(pg_current_snapshot())
      AND (txid, id) > (CAST(:txid AS text)::xid8, CAST(:id AS bigint))
    ORDER BY txid, id
    LIMIT :limit
    """
)
_ADVANCE = text(
    "UPDATE event_relay_cursor SET txid = CAST(:txid AS text)::xid8, id = :id, updated_at = :now "
    "WHERE singleton"
)
_HORIZON = text("SELECT pg_snapshot_xmin(pg_current_snapshot())::text")


async def horizon_cursor(session: AsyncSession) -> str:
    """``"<xmin>.0"``: every event of a finished-before-now transaction sorts at or before it."""
    return f"{(await session.execute(_HORIZON)).scalar_one()}.0"


def _event(row: object) -> tuple[OutboxEvent, datetime]:
    r = row._mapping  # type: ignore[attr-defined]  # SQLAlchemy Row
    return (
        OutboxEvent(
            txid=int(r["txid"]),
            id=int(r["id"]),
            doctor_id=uuid.UUID(str(r["doctor_id"])),
            event_type=r["event_type"],
            from_starts_at=r["from_starts_at"],
            to_starts_at=r["to_starts_at"],
            local_date=r["local_date"],
            from_local_date=r["from_local_date"],
        ),
        r["occurred_at"],
    )


async def relay_once(
    sessionmaker: async_sessionmaker[AsyncSession],
    publisher: EventPublisher,
    budget: PublishBudget,
    clock: Clock,
    *,
    max_age: timedelta,
    limit: int = BATCH,
) -> int:
    """Relay one batch. Returns the number of messages published (0 if none or not published)."""
    if not publisher.enabled:
        return 0
    async with sessionmaker() as session, session.begin():
        cursor = (await session.execute(_CURSOR)).first()
        if cursor is None:
            return 0  # another relay holds the cursor row
        rows = (
            await session.execute(_EVENTS, {"txid": cursor.txid, "id": cursor.id, "limit": limit})
        ).all()
        if not rows:
            return 0
        now = clock.now()
        parsed = [_event(r) for r in rows]
        last = parsed[-1][0]
        fresh = [e for e, occurred in parsed if now - occurred <= max_age]
        messages: list[OutboundMessage] = [m for e in fresh for m in messages_for(e)]
        published = 0
        if messages:
            if not await budget.debit(len(messages), now):
                messages = []  # budget spent: drop them, the safety-net poll covers the UI
            else:
                try:
                    await publisher.publish(messages)
                except PublishError as exc:
                    if not exc.sent:
                        await budget.refund(len(messages), now)
                    _log.warning("realtime publish failed, will retry on the next trigger: %s", exc)
                    return 0  # the cursor stays: leaving the block rolls nothing forward
                published = len(messages)
        await session.execute(_ADVANCE, {"txid": str(last.txid), "id": last.id, "now": now})
    return published


class Relay:
    """What a router calls after a committing write. Never raises, never takes long."""

    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        publisher: EventPublisher,
        budget: PublishBudget,
        settings: Settings,
    ) -> None:
        self.sessionmaker = sessionmaker
        self.publisher = publisher
        self.budget = budget
        self._timeout = settings.REALTIME_RELAY_TIMEOUT_SECONDS
        self._max_age = timedelta(seconds=settings.REALTIME_MAX_EVENT_AGE_SECONDS)

    async def run(self, clock: Clock) -> int:
        if not self.publisher.enabled:
            return 0
        try:
            return await asyncio.wait_for(
                relay_once(
                    self.sessionmaker, self.publisher, self.budget, clock, max_age=self._max_age
                ),
                timeout=self._timeout,
            )
        except Exception:  # noqa: BLE001  # a push problem must never fail the booking response
            _log.warning("realtime relay failed; the next trigger retries", exc_info=True)
            return 0
