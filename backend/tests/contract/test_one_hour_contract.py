"""The one-hour rule is part of the generated contract, so the documentation cannot drift."""

from __future__ import annotations

from typing import Any

import pytest

from app.core.config import Settings
from app.main import create_app


def _spec() -> dict[str, Any]:
    app = create_app(Settings(DATABASE_URL="postgresql+asyncpg://u:p@localhost/db"))
    spec: dict[str, Any] = app.openapi()
    return spec


def _example(op: dict[str, Any], status: str, code: str) -> dict[str, Any]:
    content = op["responses"][status]["content"]["application/problem+json"]
    value: dict[str, Any] = content["examples"][code]["value"]
    return value


def test_cancel_and_reschedule_declare_409_change_too_late_with_an_example() -> None:
    paths = _spec()["paths"]
    for path in (
        "/appointments/{appointment_id}/cancel",
        "/appointments/{appointment_id}/reschedule",
        "/internal/me/appointments/{appointment_id}/cancel",
        "/internal/me/appointments/{appointment_id}/reschedule",
    ):
        op = paths[path]["patch"]
        assert "409 CHANGE_TOO_LATE" in op["description"], path
        assert "60 minutes" in op["description"] and "BOOKING_MIN_LEAD_MINUTES" in op["description"]
        ex = _example(op, "409", "CHANGE_TOO_LATE")
        assert (ex["status"], ex["code"]) == (409, "CHANGE_TOO_LATE")


def test_422_for_a_too_soon_slot_409_for_changing_a_visit_within_the_hour() -> None:
    """422 for a too-soon slot (booking, or a reschedule's new start); 409 for changing a visit that
    starts within the hour (cancel, or a reschedule's current start)."""
    paths = _spec()["paths"]
    book = paths["/appointments"]["post"]["description"]
    assert "422 BOOKING_TOO_SOON" in book and "409" not in book
    cancel = paths["/appointments/{appointment_id}/cancel"]["patch"]["description"]
    assert "409 CHANGE_TOO_LATE" in cancel and "422" not in cancel
    resched = paths["/appointments/{appointment_id}/reschedule"]["patch"]["description"]
    assert "409 CHANGE_TOO_LATE" in resched and "current start" in resched
    assert "422 BOOKING_TOO_SOON" in resched and "new start" in resched


def test_booking_declares_422_booking_too_soon_with_an_example() -> None:
    op = _spec()["paths"]["/appointments"]["post"]
    assert "422 BOOKING_TOO_SOON" in op["description"] and "60 minutes" in op["description"]
    assert _example(op, "422", "BOOKING_TOO_SOON")["code"] == "BOOKING_TOO_SOON"
    assert "409" in op["responses"]  # SLOT_TAKEN and friends are still declared


def test_availability_states_the_rule() -> None:
    op = _spec()["paths"]["/doctors/{doctor_id}/availability"]["get"]
    assert op["description"] == "Slots starting within 60 minutes are never offered."


def test_the_problem_code_enum_in_the_contract_includes_change_too_late() -> None:
    enum = _spec()["components"]["schemas"]["ProblemCode"]["enum"]
    assert "CHANGE_TOO_LATE" in enum


CHANGE_OPS = [
    ("/appointments/{appointment_id}/cancel", False),
    ("/appointments/{appointment_id}/reschedule", True),
    ("/internal/me/appointments/{appointment_id}/cancel", False),
    ("/internal/me/appointments/{appointment_id}/reschedule", True),
    ("/internal/admin/appointments/{appointment_id}/cancel", False),
    ("/internal/admin/appointments/{appointment_id}/reschedule", True),
]


def _expected(code: str, instance: str, base: str) -> dict[str, Any]:
    from app.domain.errors import CATALOGUE_BY_CODE

    entry = CATALOGUE_BY_CODE[code]
    return {
        "type": f"{base}/problems/{entry.slug}",
        "title": entry.title,
        "status": entry.status,
        "detail": entry.description,
        "instance": instance,
        "code": code,
        "request_id": "00000000-0000-4000-8000-000000000000",
        "errors": None,
    }


def test_every_change_operation_has_its_examples_built_from_the_catalogue() -> None:
    settings = Settings(DATABASE_URL="postgresql+asyncpg://u:p@localhost/db")
    base = str(settings.PUBLIC_BASE_URL).rstrip("/")
    paths = create_app(settings).openapi()["paths"]
    for path, new_start in CHANGE_OPS:
        op = paths[path]["patch"]
        assert _example(op, "409", "CHANGE_TOO_LATE") == _expected("CHANGE_TOO_LATE", path, base)
        if new_start:
            assert _example(op, "422", "BOOKING_TOO_SOON") == _expected(
                "BOOKING_TOO_SOON", path, base
            ), path
    book = paths["/appointments"]["post"]
    assert _example(book, "422", "BOOKING_TOO_SOON") == _expected(
        "BOOKING_TOO_SOON", "/appointments", base
    )


def test_changing_the_catalogue_or_the_base_url_changes_the_examples(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from dataclasses import replace

    from app.domain.errors import CATALOGUE_BY_CODE

    spec = CATALOGUE_BY_CODE["CHANGE_TOO_LATE"]
    monkeypatch.setitem(
        CATALOGUE_BY_CODE, "CHANGE_TOO_LATE", replace(spec, description="A different sentence.")
    )
    settings = Settings(
        DATABASE_URL="postgresql+asyncpg://u:p@localhost/db",
        PUBLIC_BASE_URL="https://other.test/api",
    )
    paths = create_app(settings).openapi()["paths"]
    ex = _example(paths["/appointments/{appointment_id}/cancel"]["patch"], "409", "CHANGE_TOO_LATE")
    assert ex["detail"] == "A different sentence."
    assert ex["type"] == "https://other.test/api/problems/change-too-late"


def test_the_lead_time_text_follows_the_configured_setting() -> None:
    """The contract says what this deployment enforces: a different BOOKING_MIN_LEAD_MINUTES
    changes every description, and no placeholder is left over."""
    for minutes in (60, 45):
        settings = Settings(
            DATABASE_URL="postgresql+asyncpg://u:p@localhost/db", BOOKING_MIN_LEAD_MINUTES=minutes
        )
        paths = create_app(settings).openapi()["paths"]
        texts = [
            paths["/appointments"]["post"]["description"],
            paths["/internal/me/appointments"]["post"]["description"],
            paths["/appointments/{appointment_id}/cancel"]["patch"]["description"],
            paths["/appointments/{appointment_id}/reschedule"]["patch"]["description"],
            paths["/doctors/{doctor_id}/availability"]["get"]["description"],
        ]
        for text in texts:
            assert f"{minutes} minutes" in text and "{lead}" not in text, text
            other = 45 if minutes == 60 else 60
            assert f"{other} minutes" not in text, text


def test_the_signed_in_booking_path_states_the_rule_and_carries_the_example() -> None:
    op = _spec()["paths"]["/internal/me/appointments"]["post"]
    assert "422 BOOKING_TOO_SOON" in op["description"]
    assert _example(op, "422", "BOOKING_TOO_SOON")["code"] == "BOOKING_TOO_SOON"
