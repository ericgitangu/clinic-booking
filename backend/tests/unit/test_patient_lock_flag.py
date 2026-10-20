"""A patient sees whether staff locked a visit (a flag only), never the staff reason."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest

from app.models.appointment import Appointment as AppointmentRow
from app.schemas.appointment import Appointment

NOW = datetime(2026, 10, 20, 10, 0, tzinfo=UTC)


def row(locked_at: datetime | None) -> AppointmentRow:
    return AppointmentRow(
        id=uuid.uuid4(),
        doctor_id=uuid.uuid4(),
        patient_id=uuid.uuid4(),
        starts_at=NOW,
        ends_at=NOW,
        status="booked",
        cancellation_reason=None,
        cancelled_at=None,
        created_at=NOW,
        updated_at=NOW,
        staff_locked_at=locked_at,
    )


@pytest.mark.parametrize(("locked_at", "expected"), [(None, False), (NOW, True)])
def test_the_row_reports_locked_from_staff_locked_at(
    locked_at: datetime | None, expected: bool
) -> None:
    assert row(locked_at).locked is expected


def test_only_the_flag_is_exposed() -> None:
    fields = set(Appointment.model_fields)
    assert "locked" in fields
    assert not {"staff_locked_at", "veto_reason", "staff_reason"} & fields
