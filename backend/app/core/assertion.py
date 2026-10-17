"""The signed assertion that the web apps' server side sends on every ``/internal/*`` call.

Wire format, header ``X-Internal-Assertion``: ``v1.<payload>.<mac>`` where ``payload`` is the
base64url (no padding) of the canonical JSON (sorted keys, no whitespace) of
``{aud, sub, email, role, iat, exp, m, p, bh}`` and ``mac`` is the base64url HMAC-SHA256 of the
payload string with ``INTERNAL_SIGNING_KEY``.

``m`` is the HTTP method, ``p`` the path with query string exactly as sent, and ``bh`` the
lowercase hex SHA-256 of the request body, so a captured assertion cannot be reused for another
method, path, query or body. ``iat``/``exp`` are epoch seconds; the lifetime (``exp - iat``) may
not exceed 60 seconds and 5 seconds of clock skew are tolerated on both ends.

There is no replay store, on purpose: within its lifetime only a byte-identical request can be
replayed, and the endpoints behind this check are read-only. An in-process cache would not span
Cloud Run instances, so it would give a false sense of protection.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
from dataclasses import dataclass
from datetime import datetime

AUDIENCE = "clinic-api/internal"
HEADER = "X-Internal-Assertion"
VERSION = "v1"
MAX_TTL_SECONDS = 60
SKEW_SECONDS = 5


class InvalidAssertion(Exception):
    """The assertion was rejected. ``reason`` is for logs only, never for the response."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class Principal:
    sub: str
    email: str
    role: str


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    try:
        return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except (binascii.Error, ValueError) as exc:
        raise InvalidAssertion("bad base64") from exc


def body_hash(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def canonical(claims: dict[str, object]) -> str:
    return json.dumps(claims, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sign(claims: dict[str, object], key: bytes) -> str:
    """Build a header value. The API only verifies; this exists for tests and tooling."""
    payload = _b64(canonical(claims).encode("utf-8"))
    mac = _b64(hmac.new(key, payload.encode("ascii"), hashlib.sha256).digest())
    return f"{VERSION}.{payload}.{mac}"


def verify(
    header: str | None,
    *,
    key: bytes,
    method: str,
    path_with_query: str,
    body: bytes,
    now: datetime,
) -> Principal:
    if not header:
        raise InvalidAssertion("missing header")
    parts = header.split(".")
    if len(parts) != 3 or parts[0] != VERSION:
        raise InvalidAssertion("bad format")
    _, payload, mac = parts

    expected = _b64(hmac.new(key, payload.encode("ascii", "replace"), hashlib.sha256).digest())
    if not hmac.compare_digest(expected.encode("ascii"), mac.encode("ascii", "replace")):
        raise InvalidAssertion("bad signature")

    try:
        claims = json.loads(_unb64(payload))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise InvalidAssertion("bad payload") from exc
    if not isinstance(claims, dict):
        raise InvalidAssertion("bad payload")

    if claims.get("aud") != AUDIENCE:
        raise InvalidAssertion("wrong audience")
    iat, exp = claims.get("iat"), claims.get("exp")
    if not isinstance(iat, int) or isinstance(iat, bool):
        raise InvalidAssertion("bad times")
    if not isinstance(exp, int) or isinstance(exp, bool):
        raise InvalidAssertion("bad times")
    if exp - iat > MAX_TTL_SECONDS or exp < iat:
        raise InvalidAssertion("lifetime too long")
    now_s = int(now.timestamp())
    if iat > now_s + SKEW_SECONDS:
        raise InvalidAssertion("issued in the future")
    if now_s > exp + SKEW_SECONDS:
        raise InvalidAssertion("expired")

    if claims.get("m") != method.upper():
        raise InvalidAssertion("method mismatch")
    if claims.get("p") != path_with_query:
        raise InvalidAssertion("path mismatch")
    bh = claims.get("bh")
    if not isinstance(bh, str) or not hmac.compare_digest(
        bh.encode("ascii", "replace"), body_hash(body).encode("ascii")
    ):
        raise InvalidAssertion("body mismatch")

    sub, email, role = claims.get("sub"), claims.get("email"), claims.get("role")
    if not (isinstance(sub, str) and isinstance(email, str) and isinstance(role, str)):
        raise InvalidAssertion("missing identity")
    return Principal(sub=sub, email=email, role=role)
