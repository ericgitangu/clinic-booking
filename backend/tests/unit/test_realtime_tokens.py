from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest

from app.core.config import REALTIME_PUBLISH_CAP_CEILING, Settings
from app.services.realtime_tokens import (
    MinuteLimiter,
    address_key,
    admin_token,
    patient_token,
    sign_jwt,
)

NOW = datetime(2026, 10, 19, 4, 0, tzinfo=UTC)
SECRET = secrets.token_urlsafe(24)
KEY = f"app123.key456:{SECRET}"
DOCTOR = uuid.UUID("11111111-1111-4111-8111-111111111111")


def _decode(token: str) -> tuple[dict[str, object], dict[str, object], bytes, str]:
    head, body, sig = token.split(".")

    def part(p: str) -> dict[str, object]:
        decoded: dict[str, object] = json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))
        return decoded

    return (
        part(head),
        part(body),
        base64.urlsafe_b64decode(sig + "=" * (-len(sig) % 4)),
        f"{head}.{body}",
    )


def test_patient_token_is_a_signed_subscribe_only_grant_for_one_channel() -> None:
    tok = patient_token(KEY, "https://push.example/event-stream", DOCTOR, date(2026, 10, 26), NOW)
    header, claims, signature, signing_input = _decode(tok.token)
    assert header == {"typ": "JWT", "alg": "HS256", "kid": "app123.key456"}
    expected = hmac.new(SECRET.encode(), signing_input.encode(), hashlib.sha256).digest()
    assert hmac.compare_digest(signature, expected)
    channel = f"slots:{DOCTOR}:2026-10-26"
    assert json.loads(str(claims["x-ably-capability"])) == {channel: ["subscribe"]}
    assert claims["exp"] == int(NOW.timestamp()) + 300 and claims["iat"] == int(NOW.timestamp())
    assert tok.channel == channel and tok.ttl_seconds == 300
    assert tok.expires_at == NOW + timedelta(minutes=5)
    assert tok.stream_url.startswith("https://push.example/event-stream?channels=")
    assert SECRET not in tok.model_dump_json()  # the secret is never echoed


def test_a_patient_token_does_not_cover_the_admin_channel() -> None:
    tok = patient_token(KEY, "https://push.example/s", DOCTOR, date(2026, 10, 26), NOW)
    _, claims, _, _ = _decode(tok.token)
    capability = json.loads(str(claims["x-ably-capability"]))
    assert list(capability) == [tok.channel]
    assert "admin:events" not in capability and "*" not in capability
    assert capability[tok.channel] == ["subscribe"]  # no publish, no presence, no history


def test_admin_token_covers_only_the_admin_channel() -> None:
    tok = admin_token(KEY, "https://push.example/s", NOW)
    _, claims, _, _ = _decode(tok.token)
    assert json.loads(str(claims["x-ably-capability"])) == {"admin:events": ["subscribe"]}


def test_a_key_without_a_secret_is_refused() -> None:
    for bad in ("", "nocolon", ":secret", "name:"):
        with pytest.raises(ValueError, match="name"):
            sign_jwt(bad, "c", NOW)


def test_address_key_groups_ipv6_by_slash_64_and_keeps_ipv4_whole() -> None:
    assert address_key("203.0.113.9") == "v4:203.0.113.9"
    a = address_key("2001:db8:1:2:aaaa:bbbb:cccc:dddd")
    b = address_key("2001:db8:1:2:1::1")
    assert a == b == "v6:2001:db8:1:2::"
    assert address_key("2001:db8:1:3::1") != a
    assert address_key("not an ip") == "invalid"


def test_minute_limiter_allows_the_limit_then_refuses_then_recovers() -> None:
    limiter = MinuteLimiter(3)
    assert [limiter.allow("k", NOW) for _ in range(4)] == [True, True, True, False]
    assert limiter.allow("other", NOW)  # keys are independent
    assert not limiter.allow("k", NOW + timedelta(seconds=59))
    assert limiter.allow("k", NOW + timedelta(seconds=60))


def _settings(**kw: Any) -> Settings:
    return Settings(DATABASE_URL="postgresql+asyncpg://x@localhost/x", **kw)


def test_publish_cap_defaults_to_the_ceiling_and_cannot_exceed_it() -> None:
    assert _settings().REALTIME_PUBLISH_CAP_PER_MONTH == REALTIME_PUBLISH_CAP_CEILING == 25_000
    assert _settings(REALTIME_PUBLISH_CAP_PER_MONTH=100).REALTIME_PUBLISH_CAP_PER_MONTH == 100
    for bad in (REALTIME_PUBLISH_CAP_CEILING + 1, -1):
        with pytest.raises(ValueError, match="REALTIME_PUBLISH_CAP_PER_MONTH"):
            _settings(REALTIME_PUBLISH_CAP_PER_MONTH=bad)


def test_the_cap_times_the_connection_ceiling_stays_under_the_free_tier() -> None:
    from app.core.config import ABLY_FREE_CONNECTIONS, ABLY_FREE_MONTHLY_MESSAGES

    assert REALTIME_PUBLISH_CAP_CEILING * (1 + ABLY_FREE_CONNECTIONS) < ABLY_FREE_MONTHLY_MESSAGES


def test_an_empty_key_means_push_is_disabled_and_a_set_key_is_secret() -> None:
    assert _settings(ABLY_API_KEY="").ABLY_API_KEY is None
    assert _settings(ABLY_API_KEY="   ").ABLY_API_KEY is None
    assert _settings().ABLY_API_KEY is None
    keyed = _settings(ABLY_API_KEY=KEY)
    assert SECRET not in repr(keyed) and SECRET not in str(keyed.model_dump())
