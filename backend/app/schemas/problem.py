"""RFC 9457 problem+json schema and the exhaustive ProblemCode enum.

ProblemCode is explicit (type-safe, gives the generated client an exhaustive union) and a
test asserts it matches the catalogue so the two never drift.
"""

from __future__ import annotations

import enum
import uuid

from pydantic import BaseModel


class ProblemCode(enum.StrEnum):
    UNAUTHENTICATED = "UNAUTHENTICATED"
    FORBIDDEN = "FORBIDDEN"
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
    ACCESS_EXISTS = "ACCESS_EXISTS"
    OWNER_PROTECTED = "OWNER_PROTECTED"
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


def problem_with_example(
    status: int, code: str, title: str, detail: str, instance: str
) -> dict[int | str, dict[str, object]]:
    """One error response that carries a worked ``application/problem+json`` example, so the
    generated documentation shows the exact body a client will see for ``code``."""
    slug = code.lower().replace("_", "-")
    return {
        status: {
            "model": Problem,
            "description": f"Problem (RFC 9457), including {code}",
            "content": {
                "application/problem+json": {
                    "examples": {
                        code: {
                            "summary": code,
                            "value": {
                                "type": f"/problems/{slug}",
                                "title": title,
                                "status": status,
                                "detail": detail,
                                "instance": instance,
                                "code": code,
                                "request_id": "00000000-0000-4000-8000-000000000000",
                            },
                        }
                    }
                }
            },
        }
    }


def change_too_late_responses(instance: str) -> dict[int | str, dict[str, object]]:
    """404/422 plus a 409 that documents CHANGE_TOO_LATE with a worked example (cancel and
    reschedule, public and internal)."""
    return {
        **problem_responses(404, 422),
        **problem_with_example(
            409,
            "CHANGE_TOO_LATE",
            "Change too late",
            "Cancel, or reschedule from or to, a time less than the minimum lead time "
            "(60 minutes) away.",
            instance,
        ),
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
