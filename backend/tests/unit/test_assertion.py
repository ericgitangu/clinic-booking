"""The BFF to API assertion: every claim is bound to the request and to a short lifetime."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.core import assertion
from app.core.assertion import AUDIENCE, InvalidAssertion, body_hash, sign, verify

KEY = b"k" * 32
NOW = datetime(2026, 10, 19, 4, 0, tzinfo=UTC)
PATH = "/internal/admin/metrics?from=2026-10-01&to=2026-10-08"


def _claims(**over: object) -> dict[str, object]:
    base: dict[str, object] = {
        "aud": AUDIENCE,
        "sub": "google-sub-1",
        "email": "admin@example.com",
        "role": "admin",
        "iat": int(NOW.timestamp()),
        "exp": int(NOW.timestamp()) + 60,
        "m": "GET",
        "p": PATH,
        "bh": body_hash(b""),
    }
    base.update(over)
    return base


def _verify(header: str | None, **over: object) -> assertion.Principal:
    args: dict[str, object] = {
        "key": KEY,
        "method": "GET",
        "path_with_query": PATH,
        "body": b"",
        "now": NOW,
    }
    args.update(over)
    return verify(header, **args)  # type: ignore[arg-type]  # kwargs built from a typed dict above


def test_valid_assertion_returns_the_principal() -> None:
    principal = _verify(sign(_claims(), KEY))
    assert (principal.sub, principal.email, principal.role) == (
        "google-sub-1",
        "admin@example.com",
        "admin",
    )


def test_payload_is_canonical_json() -> None:
    header = sign(_claims(), KEY)
    version, payload, _ = header.split(".")
    assert version == "v1"
    assert "=" not in payload
    assert assertion.canonical({"b": 1, "a": 2}) == '{"a":2,"b":1}'


@pytest.mark.parametrize("header", [None, "", "v1.only-two", "v2.a.b", "a.b.c.d"])
def test_malformed_header_is_rejected(header: str | None) -> None:
    with pytest.raises(InvalidAssertion):
        _verify(header)


def test_signature_from_another_key_is_rejected() -> None:
    with pytest.raises(InvalidAssertion, match="bad signature"):
        _verify(sign(_claims(), b"x" * 32))


def test_tampered_payload_is_rejected() -> None:
    version, payload, mac = sign(_claims(), KEY).split(".")
    forged = sign(_claims(role="admin", sub="someone-else"), b"x" * 32).split(".")[1]
    assert forged != payload
    with pytest.raises(InvalidAssertion, match="bad signature"):
        _verify(f"{version}.{forged}.{mac}")


def test_wrong_audience_is_rejected() -> None:
    with pytest.raises(InvalidAssertion, match="audience"):
        _verify(sign(_claims(aud="somebody-else"), KEY))


@pytest.mark.parametrize(
    ("over", "reason"),
    [
        ({"m": "POST"}, "method"),
        ({"p": "/internal/admin/metrics?from=2026-10-01&to=2026-12-31"}, "path"),
        ({"bh": body_hash(b"{}")}, "body"),
    ],
)
def test_assertion_is_bound_to_the_request(over: dict[str, object], reason: str) -> None:
    with pytest.raises(InvalidAssertion, match=reason):
        _verify(sign(_claims(**over), KEY))


def test_body_must_match_the_hash() -> None:
    with pytest.raises(InvalidAssertion, match="body"):
        _verify(sign(_claims(), KEY), body=b"extra")


def test_expiry_allows_five_seconds_of_skew() -> None:
    header = sign(_claims(), KEY)
    exp = NOW + timedelta(seconds=60)
    assert _verify(header, now=exp + timedelta(seconds=5)).role == "admin"
    with pytest.raises(InvalidAssertion, match="expired"):
        _verify(header, now=exp + timedelta(seconds=6))


def test_future_issue_time_allows_five_seconds_of_skew() -> None:
    header = sign(_claims(), KEY)
    assert _verify(header, now=NOW - timedelta(seconds=5)).role == "admin"
    with pytest.raises(InvalidAssertion, match="future"):
        _verify(header, now=NOW - timedelta(seconds=6))


def test_lifetime_is_capped_at_sixty_seconds() -> None:
    iat = int(NOW.timestamp())
    with pytest.raises(InvalidAssertion, match="lifetime"):
        _verify(sign(_claims(exp=iat + 61), KEY))
    with pytest.raises(InvalidAssertion, match="lifetime"):
        _verify(sign(_claims(exp=iat - 1), KEY))


@pytest.mark.parametrize("bad", ["12", 1.5, True, None])
def test_times_must_be_integers(bad: object) -> None:
    with pytest.raises(InvalidAssertion, match="times"):
        _verify(sign(_claims(iat=bad), KEY))


def test_identity_claims_are_required() -> None:
    with pytest.raises(InvalidAssertion, match="identity"):
        _verify(sign(_claims(role=None), KEY))
