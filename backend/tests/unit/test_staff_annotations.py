"""Staff annotations on the event stream reach only the admin channel and never raise."""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime

import pytest

from app.domain.realtime import ADMIN_CHANNEL, STAFF_ANNOTATIONS, OutboxEvent, messages_for

START = datetime(2026, 10, 27, 7, 0, tzinfo=UTC)


def event(kind: str, *, synthetic: bool = False) -> OutboxEvent:
    return OutboxEvent(
        txid=10,
        id=5,
        doctor_id=uuid.uuid4(),
        event_type=kind,
        from_starts_at=None,
        to_starts_at=START,
        local_date=date(2026, 10, 27),
        from_local_date=None,
        synthetic=synthetic,
    )


@pytest.mark.parametrize("kind", sorted(STAFF_ANNOTATIONS))
def test_an_annotation_is_only_an_admin_message(kind: str) -> None:
    messages = messages_for(event(kind))
    assert [m.channel for m in messages] == [ADMIN_CHANNEL]
    assert messages[0].name == kind and messages[0].data["event_type"] == kind
    # ids, dates and times only
    assert set(messages[0].data) == {
        "event_type",
        "doctor_id",
        "local_date",
        "from_local_date",
        "from_starts_at",
        "to_starts_at",
        "seq",
    }


@pytest.mark.parametrize("kind", sorted(STAFF_ANNOTATIONS))
def test_an_annotation_on_a_synthetic_appointment_is_silent(kind: str) -> None:
    assert messages_for(event(kind, synthetic=True)) == []


def test_the_set_is_what_the_migration_allows() -> None:
    assert STAFF_ANNOTATIONS == {"vetoed", "unlocked", "arrived", "no_show"}


def test_a_truly_unknown_type_still_raises() -> None:
    from app.domain.realtime import UnknownEventType

    with pytest.raises(UnknownEventType):
        messages_for(event("mystery"))
