"""Closed error hierarchy and catalogue (ADR-0006).

Every non-2xx maps to one ``DomainError`` subclass or a catalogue entry. ``code`` is
UPPER_SNAKE; ``slug`` is its kebab-case form and the path segment under ``/problems``.
``docs/api-errors.md`` is generated to match this catalogue and tested against it
(``test_error_catalogue``).
"""

from __future__ import annotations

from dataclasses import dataclass


def _slug(code: str) -> str:
    return code.lower().replace("_", "-")


@dataclass(frozen=True)
class ErrorSpec:
    code: str
    status: int
    title: str
    description: str

    @property
    def slug(self) -> str:
        return _slug(self.code)


# The lean-core catalogue. T2 codes (IDEMPOTENCY_KEY_*) are added by WP-14; stretch codes
# by their owning WP. Order: 422, 409, 404, 405, 503, 500.
CATALOGUE: tuple[ErrorSpec, ...] = (
    ErrorSpec(
        "VALIDATION_ERROR",
        422,
        "Validation error",
        "Schema or type errors, extra fields, bad UUID/date, non-string datetime.",
    ),
    ErrorSpec(
        "TIMEZONE_REQUIRED",
        422,
        "Timezone required",
        "The datetime is naive (and nothing else is wrong).",
    ),
    ErrorSpec(
        "UNKNOWN_DOCTOR",
        422,
        "Unknown doctor",
        "The body references a non-existent or inactive doctor.",
    ),
    ErrorSpec(
        "UNKNOWN_PATIENT", 422, "Unknown patient", "The body references a non-existent patient."
    ),
    ErrorSpec("SLOT_IN_PAST", 422, "Slot in the past", "starts_at is at or before now."),
    ErrorSpec(
        "BOOKING_TOO_SOON",
        422,
        "Booking too soon",
        "starts_at is less than the minimum lead time ahead of now.",
    ),
    ErrorSpec(
        "DATE_OUT_OF_RANGE",
        422,
        "Date out of range",
        "The clinic-local date is beyond the booking horizon.",
    ),
    ErrorSpec(
        "SLOT_MISALIGNED",
        422,
        "Slot misaligned",
        "Off the 30-minute grid of a window, or seconds/microseconds are non-zero.",
    ),
    ErrorSpec(
        "OUTSIDE_WORKING_HOURS",
        422,
        "Outside working hours",
        "[start, start + 30 min) is not inside a working window.",
    ),
    ErrorSpec(
        "SLOT_TAKEN",
        409,
        "Slot taken",
        "Another booking already holds this doctor slot.",
    ),
    ErrorSpec(
        "PATIENT_DOUBLE_BOOKED",
        409,
        "Patient double-booked",
        "The patient already has a booking at this time.",
    ),
    ErrorSpec(
        "APPOINTMENT_ALREADY_CANCELLED",
        409,
        "Appointment already cancelled",
        "Cancel or reschedule of an already-cancelled appointment.",
    ),
    ErrorSpec(
        "APPOINTMENT_ALREADY_STARTED",
        409,
        "Appointment already started",
        "Cancel or reschedule when starts_at is at or before now.",
    ),
    ErrorSpec(
        "PATIENT_PHONE_EXISTS",
        409,
        "Patient phone exists",
        "Another patient already uses this phone.",
    ),
    ErrorSpec(
        "CONCURRENT_UPDATE",
        409,
        "Concurrent update",
        "A deadlock or serialization failure persisted after one retry.",
    ),
    ErrorSpec("DOCTOR_NOT_FOUND", 404, "Doctor not found", "No such doctor (including inactive)."),
    ErrorSpec("PATIENT_NOT_FOUND", 404, "Patient not found", "No such patient."),
    ErrorSpec("APPOINTMENT_NOT_FOUND", 404, "Appointment not found", "No such appointment."),
    ErrorSpec("PROBLEM_NOT_FOUND", 404, "Problem not found", "No such problem slug."),
    ErrorSpec("NOT_FOUND", 404, "Not found", "The path resource does not exist."),
    ErrorSpec(
        "METHOD_NOT_ALLOWED", 405, "Method not allowed", "The method is not allowed on this path."
    ),
    ErrorSpec(
        "DB_UNAVAILABLE",
        503,
        "Database unavailable",
        "Connection failure or pool timeout. Retry after a short delay.",
    ),
    ErrorSpec(
        "INTERNAL_ERROR",
        500,
        "Internal error",
        "An unexpected error occurred; it was logged under the request id.",
    ),
)

CATALOGUE_BY_CODE: dict[str, ErrorSpec] = {spec.code: spec for spec in CATALOGUE}


class DomainError(Exception):
    """Base for domain errors. Subclasses set ``code``; status/title/slug come from the
    catalogue."""

    code: str = "INTERNAL_ERROR"

    def __init__(self, detail: str | None = None) -> None:
        spec = CATALOGUE_BY_CODE[self.code]
        self.status = spec.status
        self.title = spec.title
        self.slug = spec.slug
        self.detail = detail or spec.description
        super().__init__(self.detail)


# Domain-raised errors (slots / booking rules). Repository/service layers raise the rest.
class SlotInPast(DomainError):
    code = "SLOT_IN_PAST"


class BookingTooSoon(DomainError):
    code = "BOOKING_TOO_SOON"


class DateOutOfRange(DomainError):
    code = "DATE_OUT_OF_RANGE"


class SlotMisaligned(DomainError):
    code = "SLOT_MISALIGNED"


class OutsideWorkingHours(DomainError):
    code = "OUTSIDE_WORKING_HOURS"


# Service / repository-raised errors (WP-07). Additive to the closed hierarchy.
class UnknownDoctor(DomainError):
    code = "UNKNOWN_DOCTOR"


class UnknownPatient(DomainError):
    code = "UNKNOWN_PATIENT"


class SlotTaken(DomainError):
    code = "SLOT_TAKEN"


class PatientDoubleBooked(DomainError):
    code = "PATIENT_DOUBLE_BOOKED"


class PatientPhoneExists(DomainError):
    code = "PATIENT_PHONE_EXISTS"


class ConcurrentUpdate(DomainError):
    code = "CONCURRENT_UPDATE"


class AppointmentAlreadyCancelled(DomainError):
    code = "APPOINTMENT_ALREADY_CANCELLED"


class AppointmentAlreadyStarted(DomainError):
    code = "APPOINTMENT_ALREADY_STARTED"


class DoctorNotFound(DomainError):
    code = "DOCTOR_NOT_FOUND"


class PatientNotFound(DomainError):
    code = "PATIENT_NOT_FOUND"


class AppointmentNotFound(DomainError):
    code = "APPOINTMENT_NOT_FOUND"


class DbUnavailable(DomainError):
    code = "DB_UNAVAILABLE"
