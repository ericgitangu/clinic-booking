"""Idempotency-key rules. Pure: no database, no clock.

A key is bound to the request it first arrived with by a fingerprint, the sha256 of the
canonical JSON ``{"doctor_id", "starts_at_utc"}``. The patient is part of the uniqueness scope
(``UNIQUE (patient_id, idempotency_key)``), not of the fingerprint.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import UTC, datetime

from app.domain.errors import IdempotencyKeyConsumed, IdempotencyKeyReused

# 1-255 visible ASCII characters (0x21-0x7E). The database check ck_appt_idempotency_key and the
# header validation at the API boundary use the same rule.
KEY_PATTERN = r"^[\x21-\x7e]{1,255}$"
_KEY_RE = re.compile(KEY_PATTERN)


def is_valid_key(key: str) -> bool:
    return _KEY_RE.fullmatch(key) is not None


def request_fingerprint(doctor_id: uuid.UUID, starts_at: datetime) -> str:
    """Stable across offsets: the same instant written as +03:00 or Z fingerprints the same."""
    canonical = json.dumps(
        {
            "doctor_id": str(doctor_id),
            "starts_at_utc": starts_at.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def check_replay(*, stored_fingerprint: str, stored_status: str, fingerprint: str) -> None:
    """Decide what a request carrying an already-used key means.

    Returns normally when the stored appointment should be replayed. A different payload is
    ``IDEMPOTENCY_KEY_REUSED`` (checked first: it can never succeed). The same payload for an
    appointment that has left ``booked`` is ``IDEMPOTENCY_KEY_CONSUMED``.
    """
    if stored_fingerprint != fingerprint:
        raise IdempotencyKeyReused()
    if stored_status != "booked":
        raise IdempotencyKeyConsumed()
