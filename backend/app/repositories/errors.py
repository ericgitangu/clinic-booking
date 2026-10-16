"""DB error mapping (§5).

The asyncpg exception is chained under the SQLAlchemy ``DBAPIError`` at ``exc.orig.__cause__``
with ``.sqlstate`` and ``.constraint_name``. WP-07's ``test_constraint_name_path`` pins this
path before anything relies on it.
"""

from __future__ import annotations

from app.domain.errors import (
    DomainError,
    PatientDoubleBooked,
    PatientPhoneExists,
    SlotTaken,
)

SERIALIZATION_FAILURE = "40001"
DEADLOCK_DETECTED = "40P01"
UNIQUE_VIOLATION = "23505"

_UNIQUE_MAP: dict[str, type[DomainError]] = {
    "uq_appt_doctor_slot_booked": SlotTaken,
    "uq_appt_patient_slot_booked": PatientDoubleBooked,
    "uq_patients_phone": PatientPhoneExists,
}


def extract_sqlstate_constraint(exc: BaseException) -> tuple[str | None, str | None]:
    orig = getattr(exc, "orig", None)
    cause = getattr(orig, "__cause__", None)
    sqlstate = getattr(cause, "sqlstate", None)
    constraint = getattr(cause, "constraint_name", None)
    return sqlstate, constraint


def is_retryable_conflict(exc: BaseException) -> bool:
    sqlstate, _ = extract_sqlstate_constraint(exc)
    return sqlstate in (SERIALIZATION_FAILURE, DEADLOCK_DETECTED)


def map_integrity_error(exc: BaseException) -> DomainError:
    """Map a known unique violation to its DomainError, else re-raise (→ 500)."""
    sqlstate, constraint = extract_sqlstate_constraint(exc)
    if sqlstate == UNIQUE_VIOLATION and constraint in _UNIQUE_MAP:
        return _UNIQUE_MAP[constraint]()
    raise exc
