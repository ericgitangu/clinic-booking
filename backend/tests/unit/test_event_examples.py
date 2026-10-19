"""The shared event examples: ``contracts/events/examples.v1.json``.

Each case is an outbox row and the two messages it must become. This file pins the Python relay's
admin message (``messages_for``) to the viewer shape, validates both shapes against their JSON
Schemas and Pydantic models, and shows that the viewer message is the staff message with the three
personal fields removed. The Go gateway runs the same cases (``internal/events``): it must produce
exactly these bytes' worth of data from the same row, so the two producers cannot drift.
"""

from __future__ import annotations

import json
import pathlib
import uuid
from datetime import date, datetime
from typing import Any

import pytest

from app.domain.realtime import ADMIN_CHANNEL, OutboxEvent, messages_for
from app.schemas.events import AdminActionEvent, AdminEvent, StaffActionEvent, StaffEvent

ROOT = pathlib.Path(__file__).resolve().parents[3] / "contracts" / "events"
DOC: dict[str, Any] = json.loads((ROOT / "examples.v1.json").read_text())
VIEWER_SCHEMA = json.loads((ROOT / "admin-event.v1.schema.json").read_text())
STAFF_SCHEMA = json.loads((ROOT / "staff-event.v1.schema.json").read_text())
ACTIONS: dict[str, Any] = json.loads((ROOT / "action-examples.v1.json").read_text())
VIEWER_ACTION_SCHEMA = json.loads((ROOT / "admin-action.v1.schema.json").read_text())
STAFF_ACTION_SCHEMA = json.loads((ROOT / "staff-action.v1.schema.json").read_text())
STAFF_ONLY = (
    "appointment_id",
    "patient_name",
    "cancellation_reason",
    "actor_email",
    "actor_role",
    "staff_reason",
)
ACTION_STAFF_ONLY = (
    "appointment_id",
    "patient_name",
    "actor_email",
    "actor_role",
    "reason",
    "invite_email",
    "invite_role",
)


def _outbox(row: dict[str, Any]) -> OutboxEvent:
    def moment(value: object) -> datetime | None:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")) if value else None

    return OutboxEvent(
        txid=int(str(row["txid"])),
        id=int(str(row["id"])),
        doctor_id=uuid.UUID(str(row["doctor_id"])),
        event_type=str(row["event_type"]),
        from_starts_at=moment(row["from_starts_at"]),
        to_starts_at=moment(row["to_starts_at"]),
        local_date=date.fromisoformat(str(row["local_date"])),
        from_local_date=date.fromisoformat(str(row["from_local_date"]))
        if row["from_local_date"]
        else None,
        synthetic=bool(row["synthetic"]),
    )


@pytest.mark.parametrize("case", DOC["cases"], ids=lambda c: c["name"])
def test_python_relay_produces_the_viewer_shape(case: dict[str, Any]) -> None:
    admin = [m for m in messages_for(_outbox(case["row"])) if m.channel == ADMIN_CHANNEL]
    assert len(admin) == 1
    assert admin[0].data == case["viewer"]
    assert admin[0].name == case["row"]["event_type"]


@pytest.mark.parametrize("case", DOC["cases"], ids=lambda c: c["name"])
def test_both_shapes_validate_and_staff_extends_viewer(case: dict[str, Any]) -> None:
    # The JSON Schemas are exported from these models and a test pins the files to them; the Go
    # gateway validates the same cases against the files with a JSON Schema library.
    AdminEvent.model_validate(case["viewer"])
    StaffEvent.model_validate(case["staff"])
    staff = dict(case["staff"])
    for extra in STAFF_ONLY:
        staff.pop(extra)
    assert staff == case["viewer"]


def test_viewer_schema_names_no_person_and_staff_schema_does() -> None:
    banned = ("appointment", "patient", "reason", "name", "phone", "email")
    assert not any(w in " ".join(VIEWER_SCHEMA["properties"]) for w in banned)
    assert set(STAFF_ONLY) <= set(STAFF_SCHEMA["properties"])


def test_a_viewer_message_with_a_personal_field_is_rejected() -> None:
    case = DOC["cases"][0]
    assert VIEWER_SCHEMA["additionalProperties"] is False
    with pytest.raises(ValueError, match="patient_name"):
        AdminEvent.model_validate({**case["viewer"], "patient_name": "x"})


def test_only_cancellations_carry_a_reason() -> None:
    reasons = {c["row"]["event_type"]: c["staff"]["cancellation_reason"] for c in DOC["cases"]}
    assert reasons["cancelled"] == "Family emergency"
    assert reasons["booked"] is None and reasons["rescheduled"] is None


def test_staff_annotations_carry_who_and_why_for_staff_only() -> None:
    by_type = {c["row"]["event_type"]: c for c in DOC["cases"]}
    veto = by_type["vetoed"]
    assert veto["staff"]["actor_email"] and veto["staff"]["staff_reason"]
    assert "actor_email" not in veto["viewer"] and "staff_reason" not in veto["viewer"]
    assert by_type["booked"]["staff"]["actor_email"] is None


@pytest.mark.parametrize("case", ACTIONS["cases"], ids=lambda c: c["name"])
def test_action_shapes_validate_and_staff_extends_viewer(case: dict[str, Any]) -> None:
    AdminActionEvent.model_validate(case["viewer"])
    StaffActionEvent.model_validate(case["staff"])
    staff = dict(case["staff"])
    for extra in ACTION_STAFF_ONLY:
        staff.pop(extra)
    assert staff == case["viewer"]


def test_action_viewer_schema_names_no_person() -> None:
    banned = ("appointment", "patient", "reason", "name", "phone", "email", "actor")
    assert not any(w in " ".join(VIEWER_ACTION_SCHEMA["properties"]) for w in banned)
    assert VIEWER_ACTION_SCHEMA["additionalProperties"] is False
    assert set(ACTION_STAFF_ONLY) <= set(STAFF_ACTION_SCHEMA["properties"])
