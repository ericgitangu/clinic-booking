"""The outbox relay: hand committed events to the push service, at least once, in order.

``relay_once`` runs inside one transaction:

1. take the single cursor row ``FOR UPDATE SKIP LOCKED`` (a second relay returns at once);
2. read events after the cursor whose writing transaction is older than the snapshot's ``xmin``
   (every such transaction has finished, so no earlier event can still appear), at most 100;
3. drop events too old to matter; count the events not yet counted against the monthly budget
   (past ``debited_through``) and debit them in this same transaction; publish the batch with
   deterministic ids ``<txid>.<id>`` (``...<part>`` for patient messages);
4. advance the cursor only after the push service accepted the batch.

A failure leaves the cursor where it was, so the next trigger retries; the debit and
``debited_through`` are committed with it, so retrying the same events during an outage costs
nothing more. A batch that provably never left this process (nothing was sent) rolls back,
debit included. A repeat inside the push service's duplicate window is dropped by id, and
consumers also order by ``seq``.

It is called synchronously right after each committing write, with a short timeout, before the
response is sent. It is never a background task: Cloud Run throttles CPU once the response is out.
There is no always-on worker, so an event stuck behind a concurrent open transaction waits for
the next trigger; the clients' safety-net poll covers that gap. After three failed publishes in a
row the relay stops trying for a minute (a circuit breaker, logged once when it opens).
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass
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
    """
    SELECT txid::text AS txid, id, debited_txid::text AS debited_txid, debited_id
    FROM event_relay_cursor WHERE singleton FOR UPDATE SKIP LOCKED
    """
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
    """
    UPDATE event_relay_cursor
    SET txid = CAST(:txid AS text)::xid8, id = :id,
        debited_txid = CAST(:txid AS text)::xid8, debited_id = :id, updated_at = :now
    WHERE singleton
    """
)
_MARK_DEBITED = text(
    """
    UPDATE event_relay_cursor
    SET debited_txid = CAST(:txid AS text)::xid8, debited_id = :id, updated_at = :now
    WHERE singleton
    """
)
_HORIZON = text("SELECT pg_snapshot_xmin(pg_current_snapshot())::text")

BREAKER_FAILURES = 3
BREAKER_PAUSE = timedelta(seconds=60)


@dataclass(frozen=True)
class RelayResult:
    published: int = 0
    failed: bool = False


class _NothingSent(Exception):
    """Internal: roll the transaction back (debit included) because no request left this process."""


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


async def _relay_in(
    session: AsyncSession,
    publisher: EventPublisher,
    budget: PublishBudget,
    clock: Clock,
    *,
    max_age: timedelta,
    limit: int,
) -> RelayResult:
    cursor = (await session.execute(_CURSOR)).first()
    if cursor is None:
        return RelayResult()  # another relay holds the cursor row
    rows = (
        await session.execute(_EVENTS, {"txid": cursor.txid, "id": cursor.id, "limit": limit})
    ).all()
    if not rows:
        return RelayResult()
    now = clock.now()
    parsed = [_event(r) for r in rows]
    last = parsed[-1][0]
    fresh = [e for e, occurred in parsed if now - occurred <= max_age]
    paid_through = (int(cursor.debited_txid), int(cursor.debited_id))
    unpaid = [m for e in fresh if (e.txid, e.id) > paid_through for m in messages_for(e)]
    messages: list[OutboundMessage] = [m for e in fresh for m in messages_for(e)]

    spent = bool(unpaid) and (
        await budget.exhausted(now) or not await budget.debit(len(unpaid), now, session=session)
    )
    if spent or not messages:
        # Nothing to send (all too old) or no budget left: move past them, push is off.
        messages = []
    elif unpaid:
        await session.execute(_MARK_DEBITED, {"txid": str(last.txid), "id": last.id, "now": now})
    published = 0
    if messages:
        try:
            await publisher.publish(messages)
        except PublishError as exc:
            if not exc.sent:
                raise _NothingSent from exc
            # The service answered (and may have counted it): keep the debit, retry later.
            _log.warning("realtime publish failed, retrying on a later trigger: %s", exc)
            return RelayResult(failed=True)
        published = len(messages)
    await session.execute(_ADVANCE, {"txid": str(last.txid), "id": last.id, "now": now})
    return RelayResult(published=published)


async def relay_once(
    sessionmaker: async_sessionmaker[AsyncSession],
    publisher: EventPublisher,
    budget: PublishBudget,
    clock: Clock,
    *,
    max_age: timedelta,
    limit: int = BATCH,
) -> RelayResult:
    """Relay one batch; how many messages went out, and whether the push failed."""
    if not publisher.enabled:
        return RelayResult()
    async with sessionmaker() as session:
        await session.begin()
        try:
            result = await _relay_in(
                session, publisher, budget, clock, max_age=max_age, limit=limit
            )
            await session.commit()
            return result
        except _NothingSent:
            await session.rollback()  # nothing left this process: debit and mark undone too
            _log.warning("realtime push service unreachable, retrying on a later trigger")
            return RelayResult(failed=True)
        except asyncio.CancelledError:
            # The caller's time ran out, possibly with the batch already accepted over there: keep
            # what was debited (the cursor itself was not moved) rather than count it twice later.
            await asyncio.shield(session.commit())
            raise
        except BaseException:
            await session.rollback()
            raise


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
        self._failures = 0
        self._paused_until: datetime | None = None

    async def run(self, clock: Clock) -> int:
        if not self.publisher.enabled:
            return 0
        now = clock.now()
        if self._paused_until is not None and now < self._paused_until:
            return 0  # breaker open: skip the attempt, the clients' poll covers the gap
        try:
            result = await asyncio.wait_for(
                relay_once(
                    self.sessionmaker, self.publisher, self.budget, clock, max_age=self._max_age
                ),
                timeout=self._timeout,
            )
        except Exception:  # noqa: BLE001  # a push problem must never fail the booking response
            _log.warning("realtime relay failed; a later trigger retries", exc_info=True)
            result = RelayResult(failed=True)
        if not result.failed:
            self._failures = 0
            self._paused_until = None
            return result.published
        self._failures += 1
        if self._failures >= BREAKER_FAILURES and self._paused_until is None:
            self._paused_until = now + BREAKER_PAUSE
            _log.warning(
                "realtime push failed %s times in a row: not trying again for %s seconds",
                self._failures,
                int(BREAKER_PAUSE.total_seconds()),
            )
        elif self._failures >= BREAKER_FAILURES:
            self._paused_until = now + BREAKER_PAUSE  # a failed probe after the pause: pause again
        return 0
