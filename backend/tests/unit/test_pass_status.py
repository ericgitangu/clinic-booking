"""The status of a reviewer pass: the first thing that ended it wins."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.services.passes import status_of

NOW = datetime(2026, 10, 21, 9, 0, tzinfo=UTC)


def row(
    *, expires_in: timedelta = timedelta(days=1), revoked: bool = False, max_uses: int = 3
) -> dict[str, Any]:
    return {
        "expires_at": NOW + expires_in,
        "revoked_at": NOW - timedelta(hours=1) if revoked else None,
        "max_uses": max_uses,
    }


@pytest.mark.parametrize(
    ("fields", "used", "expected"),
    [
        ({}, 0, "active"),
        ({}, 2, "active"),
        ({}, 3, "used_up"),
        ({"expires_in": timedelta(seconds=1)}, 0, "active"),
        ({"expires_in": timedelta(0)}, 0, "expired"),
        ({"expires_in": -timedelta(days=1)}, 1, "expired"),
        ({"expires_in": -timedelta(days=1)}, 3, "expired"),
        ({"revoked": True}, 0, "revoked"),
        ({"revoked": True, "expires_in": -timedelta(days=1)}, 3, "revoked"),
        ({"max_uses": 1}, 1, "used_up"),
    ],
)
def test_status(fields: dict[str, Any], used: int, expected: str) -> None:
    assert status_of(row(**fields), used, NOW) == expected
