"""Short-lived, subscribe-only credentials for the push service, signed here with the API key.

The browser never sees the key: it gets a JWT (HS256, signed with the key's secret) whose
``x-ably-capability`` claim grants ``subscribe`` on exactly one channel, valid for five minutes.
A patient token is for one doctor and one day; the admin token is for ``admin:events``.

Abuse bounds for the anonymous patient endpoint: a per-address rate limit in memory (per process,
best effort) and a durable daily cap per address (IPv6 by /64) in the database, shared by every
instance. There is deliberately no reCAPTCHA here: a token costs nothing, and an assessment would
open a metered path.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
from collections import defaultdict, deque
from datetime import date, datetime, timedelta

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.domain.realtime import ADMIN_CHANNEL, patient_channel
from app.schemas.events import RealtimeToken

TOKEN_TTL = timedelta(minutes=5)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def sign_jwt(key: str, channel: str, now: datetime) -> RealtimeToken:
    """A subscribe-only JWT for one channel; ``key`` is ``<keyName>:<secret>``."""
    key_name, _, secret = key.partition(":")
    if not key_name or not secret:
        raise ValueError("the push key is not in <name>:<secret> form")
    expires = now + TOKEN_TTL
    header = {"typ": "JWT", "alg": "HS256", "kid": key_name}
    claims = {
        "iat": int(now.timestamp()),
        "exp": int(expires.timestamp()),
        "x-ably-capability": json.dumps({channel: ["subscribe"]}, separators=(",", ":")),
    }
    signing_input = (
        _b64(json.dumps(header, separators=(",", ":")).encode())
        + "."
        + _b64(json.dumps(claims, separators=(",", ":")).encode())
    )
    signature = hmac.new(secret.encode(), signing_input.encode(), hashlib.sha256).digest()
    return RealtimeToken(
        token=f"{signing_input}.{_b64(signature)}",
        channel=channel,
        stream_url="",
        expires_at=expires,
        ttl_seconds=int(TOKEN_TTL.total_seconds()),
    )


def patient_token(
    key: str, stream_url: str, doctor_id: object, day: date, now: datetime
) -> RealtimeToken:
    channel = patient_channel(doctor_id, day)  # type: ignore[arg-type]  # uuid.UUID
    token = sign_jwt(key, channel, now)
    return token.model_copy(update={"stream_url": _stream_url(stream_url, channel)})


def admin_token(key: str, stream_url: str, now: datetime) -> RealtimeToken:
    token = sign_jwt(key, ADMIN_CHANNEL, now)
    return token.model_copy(update={"stream_url": _stream_url(stream_url, ADMIN_CHANNEL)})


def _stream_url(base: str, channel: str) -> str:
    from urllib.parse import quote

    return f"{base}?channels={quote(channel, safe='')}&v=1.2"


def address_key(ip: str) -> str:
    """The key an address is limited by: the address itself, or the /64 for IPv6."""
    try:
        addr = ipaddress.ip_address(ip.strip())
    except ValueError:
        return "invalid"
    if isinstance(addr, ipaddress.IPv6Address):
        return "v6:" + str(ipaddress.ip_network(f"{addr}/64", strict=False).network_address)
    return "v4:" + str(addr)


class MinuteLimiter:
    """At most ``limit`` hits per key in any sliding minute. In memory, so per process."""

    def __init__(self, limit: int) -> None:
        self._limit = limit
        self._hits: dict[str, deque[datetime]] = defaultdict(deque)

    def allow(self, key: str, now: datetime) -> bool:
        hits = self._hits[key]
        while hits and now - hits[0] >= timedelta(minutes=1):
            hits.popleft()
        if len(hits) >= self._limit:
            return False
        hits.append(now)
        return True


# One row per address; the day resets in place, so nothing is ever deleted. A hit is refused (no
# row returned) once the address has used its cap for the day.
_DAILY = text(
    """
    INSERT INTO realtime_token_cap AS t (ip_key, day, n) VALUES (:k, :d, 1)
    ON CONFLICT (ip_key) DO UPDATE
      SET n = CASE WHEN t.day = EXCLUDED.day THEN t.n + 1 ELSE 1 END, day = EXCLUDED.day
      WHERE t.day <> EXCLUDED.day OR t.n < :cap
    RETURNING n
    """
)


async def take_daily(
    sessionmaker: async_sessionmaker[AsyncSession], ip: str, day: date, cap: int
) -> bool:
    async with sessionmaker() as session, session.begin():
        row = (await session.execute(_DAILY, {"k": address_key(ip), "d": day, "cap": cap})).first()
    return row is not None
