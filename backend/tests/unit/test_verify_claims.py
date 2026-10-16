"""verify_claims resolves a Location header correctly at both the API origin and the web proxy."""

from __future__ import annotations

import importlib.util
import pathlib
from types import ModuleType

import pytest

SCRIPT = pathlib.Path(__file__).resolve().parents[3] / "scripts" / "verify_claims.py"


def _load() -> ModuleType:
    spec = importlib.util.spec_from_file_location("verify_claims", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


verify_claims = _load()


@pytest.mark.parametrize(
    ("base", "location", "expected"),
    [
        # Through the web proxy: it rewrites /appointments/x to /api/appointments/x and the
        # base already carries /api. The prefix must not be doubled.
        ("https://h.example/api", "/api/appointments/x", "https://h.example/api/appointments/x"),
        ("https://h.example/api/", "/api/appointments/x", "https://h.example/api/appointments/x"),
        # Straight at the API (tag URL, local compose): no prefix on either side.
        ("https://run.example", "/appointments/x", "https://run.example/appointments/x"),
        ("http://localhost:8080", "/patients/abc", "http://localhost:8080/patients/abc"),
        # An absolute Location is left alone.
        ("https://h.example/api", "https://other.example/x", "https://other.example/x"),
    ],
)
def test_location_url(base: str, location: str, expected: str) -> None:
    assert verify_claims.location_url(base, location) == expected


def test_the_old_join_was_wrong_under_a_prefix() -> None:
    """Documents the bug: stripping the slash and appending doubles the /api prefix."""
    from urllib.parse import urljoin

    old = urljoin("https://h.example/api" + "/", "/api/appointments/x".lstrip("/"))
    assert old == "https://h.example/api/api/appointments/x"
    assert verify_claims.location_url("https://h.example/api", "/api/appointments/x") != old
