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


def _serve(monkeypatch: pytest.MonkeyPatch, seen: list[tuple[str, str]]) -> None:
    import httpx

    real = httpx.Client

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/api")
        seen.append((request.method, path))
        if path == "/doctors":
            return httpx.Response(200, json={"items": [{"id": "d1"}]})
        if path == "/doctors/d1/availability":
            return httpx.Response(
                200, json={"slots": [{"starts_at": "2026-10-21T09:00:00+03:00"}] * 2}
            )
        if path.startswith("/appointments/"):
            return httpx.Response(
                404, json={}, headers={"content-type": "application/problem+json"}
            )
        return httpx.Response(200, json={"info": {"title": "Clinic Booking API"}})

    monkeypatch.setattr(
        httpx, "Client", lambda **kw: real(transport=httpx.MockTransport(handler), **kw)
    )


def test_read_only_sends_only_gets(monkeypatch: pytest.MonkeyPatch) -> None:
    """The public smoke has no signing key; it must never create a patient."""
    seen: list[tuple[str, str]] = []
    _serve(monkeypatch, seen)
    verify_claims.RESULTS.clear()
    verify_claims.run_read_only("https://h.example/api", {})
    assert seen and {m for m, _ in seen} == {"GET"}
    assert all(ok for ok, _ in verify_claims.RESULTS)


def test_ci_without_the_key_refuses_to_write(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    seen: list[tuple[str, str]] = []
    _serve(monkeypatch, seen)
    monkeypatch.setenv("CI", "true")
    monkeypatch.delenv("SMOKE_SIGNING_KEY", raising=False)
    monkeypatch.setattr("sys.argv", ["verify_claims.py", "--base-url", "https://h.example/api"])
    assert verify_claims.main() == 2
    assert seen == []  # refused before any request
    assert "SMOKE_SIGNING_KEY" in capsys.readouterr().err


def test_the_public_smoke_script_runs_read_only() -> None:
    script = SCRIPT.parent / "ci" / "public_smoke.sh"
    calls = [ln for ln in script.read_text().splitlines() if "verify_claims.py" in ln]
    assert calls and all("--read-only" in ln for ln in calls)
