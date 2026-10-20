"""Guards on staff writes: a signed assertion works once, and one person cannot write without limit.

Both run in one transaction before the handler, after the caller's role has been checked, so a
refused caller (403) never touches them and a throttled request does not use up its assertion.

Replay: each signed assertion carries a random ``jti``. Its SHA-256 is inserted into
``assertion_replay`` with an expiry of the assertion's last valid second (``exp`` plus the clock
skew, read from the assertion itself) plus a margin; the primary key makes the first use win across
instances and a second use is ``ASSERTION_REPLAYED``. Rows are deleted only once past that expiry,
in small batches, by the same call (``FOR UPDATE SKIP LOCKED``, so concurrent writes never wait on
each other's clean-up). Two legitimate writes that are identical in every other way carry
different ``jti`` values and both pass.

Throttle: a fixed window per person (``STAFF_WRITE_WINDOW_SECONDS``, default 10 minutes) with at
most ``STAFF_WRITE_LIMIT`` (default 60) writes in it, counted whether or not the write succeeds
(a 422 counts). Beyond that: 429 ``RATE_LIMITED`` with ``Retry-After`` to the end of the window. A
caller whose clock is behind another instance's never moves the window backwards. Both use the
injected clock.

The guard COMMITS before the handler runs. A handler that then fails (a 4xx, a 5xx, a dropped
connection) has still used up its assertion and one throttle unit. That is deliberate and safe
today: the web apps sign a fresh assertion for every fetch (the signer adds a new ``jti`` each
time), so a retry is a new request, and counting a failed attempt is what a throttle is for. If a
client ever retried with the same assertion it would get ``ASSERTION_REPLAYED`` and need to sign
again.

If the guard's own database work fails, the error propagates and the request is answered by the
usual handlers (``DB_UNAVAILABLE`` for an outage, ``INTERNAL_ERROR`` otherwise): it fails closed,
and the handler never runs.
"""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.domain.emailnorm import normalize_email
from app.domain.errors import AssertionReplayed, RateLimited

# Kept this long past the assertion's last valid second, so a row is never gone while the
# assertion could still verify.
REPLAY_MARGIN = timedelta(seconds=10)
CLEANUP_BATCH = 50

_CLEANUP = text(
    """
    DELETE FROM assertion_replay WHERE replay_key IN (
      SELECT replay_key FROM assertion_replay
      WHERE expires_at < :now LIMIT :batch FOR UPDATE SKIP LOCKED
    )
    """
)
_REMEMBER = text(
    """
    INSERT INTO assertion_replay (replay_key, expires_at) VALUES (:key, :expires)
    ON CONFLICT (replay_key) DO NOTHING RETURNING 1
    """
)
# A later window starts the count again; the same window adds one until the cap; an EARLIER window
# (a request from an instance whose clock lags) is counted in the window already recorded and never
# moves it backwards.
_THROTTLE = text(
    """
    INSERT INTO staff_write_throttle AS t (actor_key, window_id, n) VALUES (:k, :w, 1)
    ON CONFLICT (actor_key) DO UPDATE
      SET n = CASE WHEN EXCLUDED.window_id > t.window_id THEN 1 ELSE t.n + 1 END,
          window_id = GREATEST(t.window_id, EXCLUDED.window_id)
      WHERE EXCLUDED.window_id > t.window_id OR t.n < :cap
    RETURNING n
    """
)


def replay_key(jti: str) -> str:
    return hashlib.sha256(jti.encode("utf-8")).hexdigest()


def actor_key(email: str) -> str:
    return hashlib.sha256(normalize_email(email).encode("utf-8")).hexdigest()


async def guard(
    session: AsyncSession,
    settings: Settings,
    now: datetime,
    *,
    jti: str,
    valid_until: int,
    email: str,
    throttle: bool,
) -> None:
    """Record the assertion as used and count the write; raise if either is refused."""
    window = settings.STAFF_WRITE_WINDOW_SECONDS
    async with session.begin():
        await session.execute(_CLEANUP, {"now": now, "batch": CLEANUP_BATCH})
        fresh = await session.execute(
            _REMEMBER,
            {
                "key": replay_key(jti),
                "expires": datetime.fromtimestamp(valid_until, tz=UTC) + REPLAY_MARGIN,
            },
        )
        if fresh.first() is None:
            raise AssertionReplayed()
        if throttle:
            epoch = int(now.timestamp())
            window_id = epoch // window
            counted = await session.execute(
                _THROTTLE,
                {"k": actor_key(email), "w": window_id, "cap": settings.STAFF_WRITE_LIMIT},
            )
            if counted.first() is None:
                wait = (window_id + 1) * window - epoch
                raise RateLimited(
                    max(wait, 1),
                    f"At most {settings.STAFF_WRITE_LIMIT} changes every "
                    f"{window // 60} minutes. Wait and try again.",
                )
