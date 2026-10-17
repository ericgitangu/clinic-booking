from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta, timezone

import pytest

from app.domain.errors import IdempotencyKeyConsumed, IdempotencyKeyReused
from app.domain.idempotency import check_replay, is_valid_key, request_fingerprint

DOCTOR = uuid.UUID("11111111-1111-1111-1111-111111111111")
OTHER = uuid.UUID("22222222-2222-2222-2222-222222222222")
AT = datetime(2026, 10, 26, 6, 0, tzinfo=UTC)


def test_fingerprint_is_stable_across_offsets() -> None:
    nairobi = timezone(timedelta(hours=3))
    assert request_fingerprint(DOCTOR, AT) == request_fingerprint(DOCTOR, AT.astimezone(nairobi))
    assert len(request_fingerprint(DOCTOR, AT)) == 64


def test_fingerprint_changes_with_doctor_or_time() -> None:
    base = request_fingerprint(DOCTOR, AT)
    assert request_fingerprint(OTHER, AT) != base
    assert request_fingerprint(DOCTOR, AT + timedelta(minutes=30)) != base


@pytest.mark.parametrize(
    "key", ["a", "k-1", "x" * 255, "!~", "550e8400-e29b-41d4-a716-446655440000"]
)
def test_valid_keys(key: str) -> None:
    assert is_valid_key(key)


@pytest.mark.parametrize("key", ["", "x" * 256, "a b", "a\tb", "a\nb", "é", "a\x7f"])
def test_invalid_keys(key: str) -> None:
    assert not is_valid_key(key)


def test_same_payload_still_booked_is_a_replay() -> None:
    check_replay(stored_fingerprint="f", stored_status="booked", fingerprint="f")


def test_different_payload_is_reused_even_if_cancelled() -> None:
    with pytest.raises(IdempotencyKeyReused):
        check_replay(stored_fingerprint="f", stored_status="booked", fingerprint="g")
    with pytest.raises(IdempotencyKeyReused):
        check_replay(stored_fingerprint="f", stored_status="cancelled", fingerprint="g")


def test_same_payload_after_cancel_is_consumed() -> None:
    with pytest.raises(IdempotencyKeyConsumed):
        check_replay(stored_fingerprint="f", stored_status="cancelled", fingerprint="f")
