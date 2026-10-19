"""RFC 9457 problem+json schema and the exhaustive ProblemCode enum.

ProblemCode is explicit (type-safe, gives the generated client an exhaustive union) and a
test asserts it matches the catalogue so the two never drift.
"""

from __future__ import annotations

import enum
import uuid
from typing import Any

from pydantic import BaseModel


class ProblemCode(enum.StrEnum):
    UNAUTHENTICATED = "UNAUTHENTICATED"
    FORBIDDEN = "FORBIDDEN"
    ROLE_ESCALATION = "ROLE_ESCALATION"
    CLIENT_ADDRESS_UNKNOWN = "CLIENT_ADDRESS_UNKNOWN"
    VALIDATION_ERROR = "VALIDATION_ERROR"
    TIMEZONE_REQUIRED = "TIMEZONE_REQUIRED"
    UNKNOWN_DOCTOR = "UNKNOWN_DOCTOR"
    UNKNOWN_PATIENT = "UNKNOWN_PATIENT"
    SLOT_IN_PAST = "SLOT_IN_PAST"
    BOOKING_TOO_SOON = "BOOKING_TOO_SOON"
    DATE_OUT_OF_RANGE = "DATE_OUT_OF_RANGE"
    SLOT_MISALIGNED = "SLOT_MISALIGNED"
    OUTSIDE_WORKING_HOURS = "OUTSIDE_WORKING_HOURS"
    IDEMPOTENCY_KEY_REUSED = "IDEMPOTENCY_KEY_REUSED"
    SLOT_TAKEN = "SLOT_TAKEN"
    PATIENT_DOUBLE_BOOKED = "PATIENT_DOUBLE_BOOKED"
    APPOINTMENT_ALREADY_CANCELLED = "APPOINTMENT_ALREADY_CANCELLED"
    CHANGE_TOO_LATE = "CHANGE_TOO_LATE"
    APPOINTMENT_ALREADY_STARTED = "APPOINTMENT_ALREADY_STARTED"
    PATIENT_PHONE_EXISTS = "PATIENT_PHONE_EXISTS"
    CONCURRENT_UPDATE = "CONCURRENT_UPDATE"
    RATE_LIMITED = "RATE_LIMITED"
    IDEMPOTENCY_KEY_CONSUMED = "IDEMPOTENCY_KEY_CONSUMED"
    APPOINTMENT_LOCKED = "APPOINTMENT_LOCKED"
    ATTENDANCE_WINDOW_CLOSED = "ATTENDANCE_WINDOW_CLOSED"
    NOTHING_TO_VETO = "NOTHING_TO_VETO"
    ACCESS_EXISTS = "ACCESS_EXISTS"
    OWNER_PROTECTED = "OWNER_PROTECTED"
    INVITE_INVALID = "INVITE_INVALID"
    ACCESS_NOT_FOUND = "ACCESS_NOT_FOUND"
    DOCTOR_NOT_FOUND = "DOCTOR_NOT_FOUND"
    PATIENT_NOT_FOUND = "PATIENT_NOT_FOUND"
    APPOINTMENT_NOT_FOUND = "APPOINTMENT_NOT_FOUND"
    PROBLEM_NOT_FOUND = "PROBLEM_NOT_FOUND"
    NOT_FOUND = "NOT_FOUND"
    METHOD_NOT_ALLOWED = "METHOD_NOT_ALLOWED"
    REALTIME_UNAVAILABLE = "REALTIME_UNAVAILABLE"
    DB_UNAVAILABLE = "DB_UNAVAILABLE"
    INTERNAL_ERROR = "INTERNAL_ERROR"


class ErrorItem(BaseModel):
    loc: list[str | int]
    msg: str
    type: str


class Problem(BaseModel):
    type: str
    title: str
    status: int
    detail: str
    instance: str
    code: ProblemCode
    request_id: uuid.UUID
    errors: list[ErrorItem] | None = None


class ProblemEntry(BaseModel):
    code: ProblemCode
    slug: str
    title: str
    status: int
    description: str


def problem_responses(*statuses: int) -> dict[int | str, dict[str, object]]:
    """Declare error responses with the real media type. The ``{"model": ...}`` shortcut is
    hard-wired to application/json in FastAPI, but the handler emits
    application/problem+json, so the content type is set explicitly here."""
    return {
        status: {
            "model": Problem,
            "description": "Problem (RFC 9457)",
            "content": {"application/problem+json": {}},
        }
        for status in statuses
    }


CATALOGUE_EXAMPLE_MARK = "x-from-catalogue"


def problem_with_example(status: int, *codes: str) -> dict[int | str, dict[str, object]]:
    """One error response that carries worked ``application/problem+json`` examples.

    Only the codes are named here. The example bodies are written when the OpenAPI document is
    built (``fill_problem_examples``), from the error catalogue and the configured public base URL,
    so an example is built the way the handler builds its body and cannot drift from it.
    """
    return {
        status: {
            "model": Problem,
            "description": "Problem (RFC 9457), including " + ", ".join(codes),
            "content": {
                "application/problem+json": {
                    "examples": {
                        code: {"summary": code, "value": {CATALOGUE_EXAMPLE_MARK: code}}
                        for code in codes
                    }
                }
            },
        }
    }


def change_too_late_responses(*, new_start: bool = False) -> dict[int | str, dict[str, object]]:
    """404, a 409 documenting CHANGE_TOO_LATE, and a 422 that documents BOOKING_TOO_SOON when the
    operation also takes a new start (reschedule). Cancel and reschedule, public and internal."""
    return {
        **problem_responses(404),
        **(problem_with_example(422, "BOOKING_TOO_SOON") if new_start else problem_responses(422)),
        **problem_with_example(409, "CHANGE_TOO_LATE"),
    }


def fill_lead_time(node: Any, minutes: int) -> None:
    """In place: replace the lead-time token in every string of the document with the configured
    value, so the contract states what this deployment enforces."""
    from app.domain.booking_rules import LEAD_TOKEN

    items = (
        node.items()
        if isinstance(node, dict)
        else enumerate(node)
        if isinstance(node, list)
        else ()
    )
    for key, value in list(items):
        if isinstance(value, str):
            node[key] = value.replace(LEAD_TOKEN, str(minutes))
        else:
            fill_lead_time(value, minutes)


def fill_problem_examples(spec: dict[str, Any], public_base_url: str) -> None:
    """Write each marked example from ``CATALOGUE_BY_CODE`` and ``public_base_url``: the same
    fields, built the same way, as ``app.core.problems.build_problem``. Two differences, both
    because an example is not a request: ``instance`` is the operation's path template (the handler
    sends the concrete request path) and ``request_id`` is a fixed placeholder."""
    from app.domain.errors import CATALOGUE_BY_CODE

    base = public_base_url.rstrip("/")
    for path, operations in spec.get("paths", {}).items():
        for operation in operations.values():
            if not isinstance(operation, dict):
                continue
            for response in operation.get("responses", {}).values():
                content = response.get("content", {}).get("application/problem+json", {})
                for example in content.get("examples", {}).values():
                    code = example.get("value", {}).get(CATALOGUE_EXAMPLE_MARK)
                    if code is None:
                        continue
                    entry = CATALOGUE_BY_CODE[code]
                    example["value"] = {
                        "type": f"{base}/problems/{entry.slug}",
                        "title": entry.title,
                        "status": entry.status,
                        "detail": entry.description,
                        "instance": path,
                        "code": code,
                        "request_id": "00000000-0000-4000-8000-000000000000",
                        "errors": None,
                    }


def strip_json_from_error_responses(spec: dict[str, object]) -> None:
    """Error responses carry only application/problem+json. FastAPI's {"model": ...} shortcut
    also adds an application/json entry the server never emits; drop it so the contract is
    honest (the problem+json entry keeps the Problem schema referenced in components)."""
    paths = spec.get("paths", {})
    if not isinstance(paths, dict):
        raise TypeError(f"OpenAPI 'paths' must be a mapping, got {type(paths).__name__}")
    for operations in paths.values():
        for operation in operations.values():
            if not isinstance(operation, dict):
                continue
            for status, response in operation.get("responses", {}).items():
                if status[:1] not in ("4", "5"):
                    continue
                # Every error the API emits is application/problem+json; drop FastAPI's
                # auto-added application/json (incl. the spurious HTTPValidationError on
                # routes whose only param cannot fail validation).
                content = response.get("content", {})
                content.pop("application/json", None)
                if not content:
                    response.pop("content", None)


REPLAYED_HEADER = "Idempotent-Replayed"

# Documents the header on the 201 of a keyed POST. The model is the operation's own response_model,
# so only the header is added here.
REPLAY_HEADER: dict[int | str, dict[str, object]] = {
    201: {
        "description": "Created, or the earlier booking replayed for the same Idempotency-Key",
        "headers": {
            REPLAYED_HEADER: {
                "description": "`true` when this response replays an earlier booking.",
                "schema": {"type": "string", "enum": ["true"]},
            }
        },
    }
}
