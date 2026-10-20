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

A trigger that finds nothing to send is not always "nothing to send". Another relay may hold the
cursor row (``SKIP LOCKED`` makes the loser return at once), and the holder may have read its batch
before the loser's event committed; the event would then wait for the next trigger. So the
roles are fixed: a LOSER returns immediately (no sleep, no retry, so a booking never pays for
someone else's slow publish), and the HOLDER drains: after each pass it takes a fresh snapshot and
reads again, until a pass finds nothing new (at most ``MAX_PASSES`` passes, inside the time budget).
Events committed by other writers while it was publishing are above its earlier snapshot and are
picked up by the next pass. A failed publish ends the loop (the breaker handles it). Every pass
starts from the cursor, which only moves in the transaction that publishes, so an event goes out
once however many passes there are; the publish budget is debited in that same transaction
(``debited_through`` guards a repeat), and the ``xmin`` guard is untouched: nothing is published
before its transaction is visible. An event held back by an older open transaction is waited for
by the holder for at most ``HORIZON_WAIT``: that transaction may end in a rollback (a lost booking
race), which triggers no relay, so nothing else would send the event. The token mints run the same
relay (holder or loser the same way), so an open page asking for a new token also flushes what is
stranded; the clients' poll stays as the last safety net.

It is called synchronously right after each committing write, with a short timeout, before the
response is sent. It is never a background task: Cloud Run throttles CPU once the response is out.
A trigger that stopped for lack of time leaves the rest for the next trigger, and the availability
read (an open page's poll) is one: ``flush_if_owed`` does a lock-free EXISTS and runs the relay only
when a visible event is owed. There is no always-on worker, so an event stuck behind a transaction
that stays open past ``HORIZON_WAIT`` waits for the next trigger; the clients' safety-net poll
covers that gap. After
three failed publishes in a row the relay stops trying for a minute (a circuit breaker, logged
once when it opens).
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
    SELECT e.id, e.txid::text AS txid, e.doctor_id, e.event_type, e.from_starts_at,
           e.to_starts_at, e.local_date, e.from_local_date, e.occurred_at,
           COALESCE(p.synthetic, false) AS synthetic
    FROM appointment_events e
    LEFT JOIN appointments a ON a.id = e.appointment_id
    LEFT JOIN patients p ON p.id = a.patient_id
    WHERE e.txid < pg_snapshot_xmin(pg_current_snapshot())
      AND (e.txid, e.id) > (CAST(:txid AS text)::xid8, CAST(:id AS bigint))
    ORDER BY e.txid, e.id
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
# The cursor row WITHOUT the lock, and whether any visible event sorts after it: the holder's last
# look, taken after it released the cursor row (see ``_pending_after_release``).
_PENDING = text(
    """
    SELECT EXISTS (
        SELECT 1 FROM appointment_events e, event_relay_cursor c
        WHERE c.singleton
          AND e.txid < pg_snapshot_xmin(pg_current_snapshot())
          AND (e.txid, e.id) > (c.txid, c.id)
    )
    """
)
# Committed events past the cursor that the ``xmin`` guard still hides (an OLDER transaction is
# open).
_HELD_BACK = text(
    """
    SELECT EXISTS (
        SELECT 1 FROM appointment_events e, event_relay_cursor c
        WHERE c.singleton
          AND e.txid >= pg_snapshot_xmin(pg_current_snapshot())
          AND (e.txid, e.id) > (c.txid, c.id)
    )
    """
)
# How long a holder waits for an older open transaction to end, when a committed event is owed.
# A lost booking race ends in a rollback and triggers no relay, so without this the event waits for
# some later trigger. Short on purpose: transactions here last milliseconds.
HORIZON_WAIT = 0.25
HORIZON_STEP = 0.025
_HORIZON = text("SELECT pg_snapshot_xmin(pg_current_snapshot())::text")
# A holder starts another pass only when the time left covers the slowest pass so far with this
# margin, and never less than the floor. A pass is never started to be cancelled mid-publish.
PASS_MARGIN = 1.25
PASS_FLOOR = 0.05

# Passes a holder makes in one trigger: each re-reads from a fresh snapshot, and the loop ends as
# soon as a pass finds nothing. Bounded so a steady stream of writers cannot keep one request busy;
# the relay's time budget bounds it in seconds as well.
MAX_PASSES = 8

BREAKER_FAILURES = 3
BREAKER_PAUSE = timedelta(seconds=60)


@dataclass
class _Progress:
    """What one trigger has done so far: kept outside the drain so a failure or the time limit in a
    later pass cannot hide the messages an earlier pass sent."""

    published: int = 0
    failed: bool = False
    passes: int = 0
    # Why a trigger ended with events still owed (None when it left nothing behind): "held_back"
    # (an older open transaction hid them for the whole bounded wait) or "time" (too little of the
    # budget was left for another pass). Both leave the event to the next trigger or the poll.
    left: str | None = None


@dataclass(frozen=True)
class RelayResult:
    published: int = 0
    failed: bool = False
    # Another relay held the cursor row: this one is a loser and returns at once.
    contended: bool = False
    # Rows the pass moved the cursor past (sent, or skipped as too old or unpaid for): the holder
    # reads again after a pass that consumed any.
    consumed: int = 0


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
            synthetic=bool(r["synthetic"]),
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
        return RelayResult(contended=True)  # another relay holds the cursor row
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
    return RelayResult(published=published, consumed=len(rows))


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
        progress = _Progress()
        try:
            # The drain stops itself before the budget; this is the backstop for a pass that hangs.
            await asyncio.wait_for(self._drain(clock, progress), timeout=self._timeout)
        except Exception:  # noqa: BLE001  # a push problem must never fail the booking response
            _log.warning("realtime relay failed; a later trigger retries", exc_info=True)
            progress.failed = True
        self._report(progress)
        if not progress.failed:
            self._failures = 0
            self._paused_until = None
            return progress.published
        # A failure counts once toward the breaker, even when earlier passes of the same trigger
        # published (those messages are returned and are not undone: the cursor moved with them).
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
        return progress.published

    async def flush_if_owed(self, clock: Clock) -> int:
        """The follow-up for a trigger that ended with events left over (out of time, or lost the
        cursor to a holder that had already read): called from a read path that exists anyway.
        One lightweight EXISTS (``_PENDING``: a visible event past the cursor, no lock, no wait);
        only when it says something is owed does this run the relay. Never raises. An event held
        back by an older open transaction is not chased here (that would make a read wait)."""
        if not self.publisher.enabled:
            return 0
        if self._paused_until is not None and clock.now() < self._paused_until:
            return 0
        try:
            if not await self._pending_after_release():
                return 0
        except Exception:  # noqa: BLE001  # a read must never fail because the check did
            _log.warning("realtime relay: could not check for owed events", exc_info=True)
            return 0
        return await self.run(clock)

    @staticmethod
    def _report(progress: _Progress) -> None:
        """One line per trigger that sent something or left something behind (nothing for the common
        empty trigger or a loser). Without it a push that never arrived cannot be told from one that
        was never sent: the per-pass line below is debug-level and the API runs at info."""
        if progress.left is not None:
            _log.warning(
                "realtime relay left events unsent (%s): published=%s passes=%s",
                progress.left,
                progress.published,
                progress.passes,
            )
        elif progress.published:
            _log.info(
                "realtime relay published %s messages in %s passes",
                progress.published,
                progress.passes,
            )

    async def _pending_after_release(self) -> bool:
        """The holder's last look. A loser that was refused the cursor row while the holder's empty
        pass held it committed its event BEFORE the holder released the row, so a fresh snapshot
        taken after the release sees it (the ``xmin`` guard aside). The look takes no lock, so it
        opens no new window of its own, and it works whichever process the loser ran in. A pass that
        found something is followed by another pass anyway; only an empty pass needs the look."""
        async with self.sessionmaker() as session:
            return bool((await session.execute(_PENDING)).scalar_one())

    async def _held_back(self) -> bool:
        """A committed event is owed but an older open transaction hides it (see ``_HELD_BACK``)."""
        async with self.sessionmaker() as session:
            return bool((await session.execute(_HELD_BACK)).scalar_one())

    async def _drain(self, clock: Clock, progress: _Progress) -> None:
        """One trigger. A loser returns at once. A holder passes again from a fresh snapshot after
        every pass that moved the cursor, until a pass finds nothing, ``MAX_PASSES``, or too little
        time is left for another pass of the length seen so far: it never starts a publish the
        time budget would cancel in flight (a cancelled publish may be accepted over there with the
        cursor not moved, so the next trigger would send it again). A failed publish ends it.
        ``progress`` collects what was sent, so a later failure or timeout cannot hide it."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._timeout
        slowest = 0.0
        waited = 0.0
        for attempt in range(MAX_PASSES):
            begun = loop.time()
            if attempt > 0 and deadline - begun < max(slowest * PASS_MARGIN, PASS_FLOOR):
                progress.left = "time"
                return  # the remainder goes out with the next trigger (see the module docstring)
            result = await relay_once(
                self.sessionmaker, self.publisher, self.budget, clock, max_age=self._max_age
            )
            slowest = max(slowest, loop.time() - begun)
            progress.published += result.published
            progress.passes += 1
            _log.debug(
                "realtime relay pass %s: contended=%s consumed=%s published=%s failed=%s",
                attempt,
                result.contended,
                result.consumed,
                result.published,
                result.failed,
            )
            if result.failed:
                progress.failed = True
                return
            if result.contended:
                return
            if result.consumed == 0 and not await self._pending_after_release():
                # Nothing visible. An older open transaction may still be hiding a committed event;
                # that transaction can end without triggering any relay, so wait for it, bounded.
                held = await self._held_back()
                if waited >= HORIZON_WAIT or not held:
                    if held:
                        progress.left = "held_back"  # waited the whole bound, still hidden
                    return
                while waited < HORIZON_WAIT and await self._held_back():
                    await asyncio.sleep(HORIZON_STEP)
                    waited += HORIZON_STEP
