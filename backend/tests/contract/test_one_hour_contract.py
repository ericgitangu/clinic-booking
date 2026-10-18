"""The one-hour rule is part of the generated contract, so the documentation cannot drift."""

from __future__ import annotations

from typing import Any

from app.core.config import Settings
from app.domain.booking_rules import RULE_AVAILABILITY
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
    assert (
        op["description"]
        == RULE_AVAILABILITY
        == ("Slots starting within 60 minutes are never offered.")
    )


def test_the_problem_code_enum_in_the_contract_includes_change_too_late() -> None:
    enum = _spec()["components"]["schemas"]["ProblemCode"]["enum"]
    assert "CHANGE_TOO_LATE" in enum
