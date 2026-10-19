from __future__ import annotations

import json
import pathlib
import uuid
from datetime import UTC, date, datetime

import pytest

from app.domain.realtime import (
    ADMIN_CHANNEL,
    BadCursor,
    OutboxEvent,
    UnknownEventType,
    format_cursor,
    messages_for,
    parse_cursor,
    patient_channel,
)
from app.schemas.events import AdminEvent, SlotEvent, event_json_schemas

DOCTOR = uuid.UUID("11111111-1111-4111-8111-111111111111")
NINE = datetime(2026, 10, 26, 6, 0, tzinfo=UTC)
TEN = datetime(2026, 10, 26, 7, 0, tzinfo=UTC)
D26, D27 = date(2026, 10, 26), date(2026, 10, 27)
BANNED = ("appointment", "patient", "phone", "email", "reason", "name", "occurred", "txid")


def _event(kind: str, **kw: object) -> OutboxEvent:
    base: dict[str, object] = {
        "txid": 770,
        "id": 41,
        "doctor_id": DOCTOR,
        "event_type": kind,
        "from_starts_at": None,
        "to_starts_at": None,
        "local_date": D26,
        "from_local_date": None,
    }
    base.update(kw)
    return OutboxEvent(**base)  # type: ignore[arg-type]  # test helper over a dataclass


@pytest.mark.parametrize("text", ["0.0", "1.2", "770.41", "18446744073709551615.1"])
def test_cursor_round_trip(text: str) -> None:
    txid, event_id = parse_cursor(text)
    assert format_cursor(txid, event_id) == text


@pytest.mark.parametrize(
    "text",
    ["", "1", "1.", ".1", "1.2.3", "-1.2", "+1.2", "01.2", "1.02", " 1.2", "1.2 ", "a.b", "1,2"]
    + ["18446744073709551616.0", "1.18446744073709551616"],
)
def test_cursor_rejects_anything_else(text: str) -> None:
    with pytest.raises(BadCursor):
        parse_cursor(text)


def test_book_pushes_slot_taken_on_the_slots_channel_and_an_admin_message() -> None:
    patient, admin = messages_for(_event("booked", to_starts_at=NINE))
    assert patient.channel == f"slots:{DOCTOR}:2026-10-26"
    assert patient.name == "slot_taken" and patient.id == "770.41.1"
    assert patient.data == {
        "doctor_id": str(DOCTOR),
        "local_date": "2026-10-26",
        "starts_at": "2026-10-26T06:00:00.000000Z",
        "kind": "slot_taken",
        "seq": "770.41.1",
    }
    assert admin.channel == ADMIN_CHANNEL and admin.id == "770.41" and admin.name == "booked"
    assert admin.data["seq"] == "770.41" and admin.data["from_starts_at"] is None


def test_cancel_pushes_slot_freed_for_the_old_start() -> None:
    patient, admin = messages_for(_event("cancelled", from_starts_at=NINE))
    assert patient.name == "slot_freed" and patient.id == "770.41.0"
    assert patient.data["starts_at"] == "2026-10-26T06:00:00.000000Z"
    assert admin.name == "cancelled" and admin.data["to_starts_at"] is None


def test_same_day_reschedule_is_freed_then_taken_on_one_channel() -> None:
    freed, taken, admin = messages_for(_event("rescheduled", from_starts_at=NINE, to_starts_at=TEN))
    assert freed.channel == taken.channel == f"slots:{DOCTOR}:2026-10-26"
    assert (freed.name, taken.name) == ("slot_freed", "slot_taken")
    assert freed.id != taken.id  # two messages of one event stay distinct and ordered
    assert freed.id < taken.id
    assert admin.name == "rescheduled"


def test_cross_day_reschedule_frees_on_the_old_day_and_takes_on_the_new_one() -> None:
    freed, taken, admin = messages_for(
        _event(
            "rescheduled",
            from_starts_at=NINE,
            to_starts_at=TEN.replace(day=27),
            local_date=D27,
            from_local_date=D26,
        )
    )
    assert freed.channel == patient_channel(DOCTOR, D26)
    assert taken.channel == patient_channel(DOCTOR, D27)
    assert admin.data["from_local_date"] == "2026-10-26"


@pytest.mark.parametrize(
    "event",
    [
        _event("booked"),  # no start to take
        _event("cancelled"),
        _event("rescheduled", from_starts_at=NINE),
        _event("moved"),
    ],
)
def test_an_event_that_cannot_be_pushed_is_an_error_not_a_skip(event: OutboxEvent) -> None:
    with pytest.raises(UnknownEventType):
        messages_for(event)


@pytest.mark.parametrize(
    "event",
    [
        _event("booked", to_starts_at=NINE),
        _event("cancelled", from_starts_at=NINE),
        _event("rescheduled", from_starts_at=NINE, to_starts_at=TEN),
    ],
)
def test_every_message_validates_against_its_contract_and_carries_no_personal_data(
    event: OutboxEvent,
) -> None:
    for message in messages_for(event):
        model = AdminEvent if message.channel == ADMIN_CHANNEL else SlotEvent
        model.model_validate(message.data)  # extra fields are forbidden by the model
        keys = " ".join(message.data).lower()
        assert not any(word in keys for word in BANNED), keys


def test_a_slot_event_with_an_appointment_id_is_rejected() -> None:
    good = messages_for(_event("booked", to_starts_at=NINE))[0].data
    with pytest.raises(ValueError, match="appointment_id"):
        SlotEvent.model_validate({**good, "appointment_id": str(uuid.uuid4())})


def test_the_json_schemas_under_contracts_are_the_models_schemas() -> None:
    root = pathlib.Path(__file__).resolve().parents[3] / "contracts" / "events"
    for stem, schema in event_json_schemas().items():
        on_disk = json.loads((root / f"{stem}.schema.json").read_text())
        assert on_disk == schema, f"{stem}: run `make openapi` to regenerate contracts/events"
        assert on_disk["additionalProperties"] is False
        # the staff shapes name the appointment, the patient and the actor on purpose
        if stem not in ("staff-event.v1", "staff-action.v1"):
            assert not any(w in " ".join(on_disk["properties"]).lower() for w in BANNED)
