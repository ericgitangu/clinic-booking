"""RFC 9457 problem+json schema and the exhaustive ProblemCode enum (ADR-0006, §6).

ProblemCode is explicit (type-safe, gives the generated client an exhaustive union) and a
test asserts it matches the catalogue so the two never drift.
"""

from __future__ import annotations

import enum
import uuid

from pydantic import BaseModel


class ProblemCode(enum.StrEnum):
    VALIDATION_ERROR = "VALIDATION_ERROR"
    TIMEZONE_REQUIRED = "TIMEZONE_REQUIRED"
    UNKNOWN_DOCTOR = "UNKNOWN_DOCTOR"
    UNKNOWN_PATIENT = "UNKNOWN_PATIENT"
    SLOT_IN_PAST = "SLOT_IN_PAST"
    BOOKING_TOO_SOON = "BOOKING_TOO_SOON"
    DATE_OUT_OF_RANGE = "DATE_OUT_OF_RANGE"
    SLOT_MISALIGNED = "SLOT_MISALIGNED"
    OUTSIDE_WORKING_HOURS = "OUTSIDE_WORKING_HOURS"
    SLOT_TAKEN = "SLOT_TAKEN"
    PATIENT_DOUBLE_BOOKED = "PATIENT_DOUBLE_BOOKED"
    APPOINTMENT_ALREADY_CANCELLED = "APPOINTMENT_ALREADY_CANCELLED"
    APPOINTMENT_ALREADY_STARTED = "APPOINTMENT_ALREADY_STARTED"
    PATIENT_PHONE_EXISTS = "PATIENT_PHONE_EXISTS"
    CONCURRENT_UPDATE = "CONCURRENT_UPDATE"
    DOCTOR_NOT_FOUND = "DOCTOR_NOT_FOUND"
    PATIENT_NOT_FOUND = "PATIENT_NOT_FOUND"
    APPOINTMENT_NOT_FOUND = "APPOINTMENT_NOT_FOUND"
    PROBLEM_NOT_FOUND = "PROBLEM_NOT_FOUND"
    NOT_FOUND = "NOT_FOUND"
    METHOD_NOT_ALLOWED = "METHOD_NOT_ALLOWED"
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
    """Declare problem+json responses for the given statuses, so the OpenAPI spec lists
    every status a route can return (schemathesis status-code conformance)."""
    return {
        status: {"model": Problem, "description": "Problem (application/problem+json)"}
        for status in statuses
    }
