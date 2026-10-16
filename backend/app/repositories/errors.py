"""DB error mapping.

The asyncpg exception is chained under the SQLAlchemy ``DBAPIError`` at ``exc.orig.__cause__``
with ``.sqlstate`` and ``.constraint_name``. ``test_constraint_name_path`` pins this
path before anything relies on it. Retry and outage classification lives in ``app.db.errors``.
"""

from __future__ import annotations

from app.db.errors import extract_sqlstate_constraint
from app.domain.errors import (
    DomainError,
    PatientDoubleBooked,
    PatientPhoneExists,
    SlotTaken,
)

UNIQUE_VIOLATION = "23505"

_UNIQUE_MAP: dict[str, type[DomainError]] = {
    "uq_appt_doctor_slot_booked": SlotTaken,
    "uq_appt_patient_slot_booked": PatientDoubleBooked,
    "uq_patients_phone": PatientPhoneExists,
}


def map_integrity_error(exc: BaseException) -> DomainError:
    """Map a known unique violation to its DomainError, else re-raise (-> 500)."""
    sqlstate, constraint = extract_sqlstate_constraint(exc)
    if sqlstate == UNIQUE_VIOLATION and constraint in _UNIQUE_MAP:
        return _UNIQUE_MAP[constraint]()
    raise exc
