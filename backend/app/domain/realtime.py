"""Realtime event rules. Pure: no I/O, no clock reads.

An outbox row (``appointment_events``) becomes pushed messages here. The patient channel
``slots:{doctor_id}:{local_date}`` carries only that a time was taken or freed; nothing that names
a person or an appointment. A reschedule is a ``slot_freed`` plus a ``slot_taken``. The admin
channel ``admin:events`` carries the event type and times, again without personal data.

Ordering: every event has a cursor ``"<txid>.<id>"`` (the transaction that wrote it and its row id,
both integers). A patient message's ``seq`` adds a third part, ``"<txid>.<id>.<n>"`` (n = 0 for
the freed half of a reschedule, 1 for the taken half; a plain book or cancel uses 1 and 0), so two
messages from one event still order. A consumer applies a message only when it sorts after the last
one it applied and after the cursor of the availability response it started from.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime

from app.domain.errors import DomainError

PATIENT_CHANNEL = "slots:{doctor_id}:{local_date}"
ADMIN_CHANNEL = "admin:events"

_CURSOR_RE = re.compile(r"^(0|[1-9][0-9]{0,19})\.(0|[1-9][0-9]{0,19})$")
_MAX_U64 = 2**64 - 1


class BadCursor(DomainError):
    """A cursor that is not ``<txid>.<id>``; reported as VALIDATION_ERROR (422)."""

    code = "VALIDATION_ERROR"


def format_cursor(txid: int, event_id: int) -> str:
    return f"{txid}.{event_id}"


def parse_cursor(text: str) -> tuple[int, int]:
    """``"<txid>.<id>"`` to integers. No sign, space, leading zero or extra part is accepted."""
    match = _CURSOR_RE.fullmatch(text)
    if match is None:
        raise BadCursor("cursor must look like <txid>.<id>")
    txid, event_id = int(match.group(1)), int(match.group(2))
    if txid > _MAX_U64 or event_id > _MAX_U64:
        raise BadCursor("cursor is out of range")
    return txid, event_id


def patient_channel(doctor_id: uuid.UUID, local_date: date) -> str:
    return PATIENT_CHANNEL.format(doctor_id=doctor_id, local_date=local_date.isoformat())


@dataclass(frozen=True)
class OutboxEvent:
    """The columns of one ``appointment_events`` row that the relay reads."""

    txid: int
    id: int
    doctor_id: uuid.UUID
    event_type: str
    from_starts_at: datetime | None
    to_starts_at: datetime | None
    local_date: date
    from_local_date: date | None
    # The appointment belongs to a synthetic (release smoke) patient. Its slot still changes for
    # patients, so the patient messages go out; the admin feed does not hear about it.
    synthetic: bool = False

    @property
    def cursor(self) -> str:
        return format_cursor(self.txid, self.id)


@dataclass(frozen=True)
class OutboundMessage:
    channel: str
    id: str  # deterministic across retries: the push service drops a repeat inside its window
    name: str
    data: dict[str, object]


def _utc(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _slot_message(
    event: OutboxEvent, kind: str, starts_at: datetime, local_date: date, part: int
) -> OutboundMessage:
    seq = f"{event.cursor}.{part}"
    return OutboundMessage(
        channel=patient_channel(event.doctor_id, local_date),
        id=seq,
        name=kind,
        data={
            "doctor_id": str(event.doctor_id),
            "local_date": local_date.isoformat(),
            "starts_at": _utc(starts_at),
            "kind": kind,
            "seq": seq,
        },
    )


# Events staff add to the stream. They carry no slot change, so they only reach the admin channel.
STAFF_ANNOTATIONS = frozenset({"vetoed", "unlocked", "arrived", "no_show"})


class UnknownEventType(DomainError):
    code = "INTERNAL_ERROR"


def messages_for(event: OutboxEvent) -> list[OutboundMessage]:
    """All messages one outbox row produces: patient slot messages, then the admin message (none for
    a synthetic patient's appointment)."""
    out: list[OutboundMessage] = []
    if event.event_type == "booked" and event.to_starts_at is not None:
        out.append(_slot_message(event, "slot_taken", event.to_starts_at, event.local_date, 1))
    elif event.event_type == "cancelled" and event.from_starts_at is not None:
        out.append(_slot_message(event, "slot_freed", event.from_starts_at, event.local_date, 0))
    elif (
        event.event_type == "rescheduled"
        and event.from_starts_at is not None
        and event.to_starts_at is not None
    ):
        freed_on = event.from_local_date or event.local_date
        out.append(_slot_message(event, "slot_freed", event.from_starts_at, freed_on, 0))
        out.append(_slot_message(event, "slot_taken", event.to_starts_at, event.local_date, 1))
    elif event.event_type in STAFF_ANNOTATIONS:
        pass  # no slot changed (any move is its own event): patients hear nothing
    else:
        raise UnknownEventType(f"cannot push event {event.cursor} of type {event.event_type!r}")
    if event.synthetic:
        return out
    out.append(
        OutboundMessage(
            channel=ADMIN_CHANNEL,
            id=event.cursor,
            name=event.event_type,
            data={
                "event_type": event.event_type,
                "doctor_id": str(event.doctor_id),
                "local_date": event.local_date.isoformat(),
                "from_local_date": event.from_local_date.isoformat()
                if event.from_local_date
                else None,
                "from_starts_at": _utc(event.from_starts_at) if event.from_starts_at else None,
                "to_starts_at": _utc(event.to_starts_at) if event.to_starts_at else None,
                "seq": event.cursor,
            },
        )
    )
    return out
