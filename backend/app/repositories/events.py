from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.events import EventFields
from app.models.appointment_event import AppointmentEvent


async def insert_event(
    session: AsyncSession,
    *,
    appointment_id: uuid.UUID,
    doctor_id: uuid.UUID,
    fields: EventFields,
    actor: str | None = None,
) -> None:
    session.add(
        AppointmentEvent(
            appointment_id=appointment_id,
            doctor_id=doctor_id,
            event_type=fields.event_type,
            from_starts_at=fields.from_starts_at,
            to_starts_at=fields.to_starts_at,
            local_date=fields.local_date,
            from_local_date=fields.from_local_date,
            actor=actor,
        )
    )
    await session.flush()


_LATEST = text(
    """
    SELECT id, event_type, from_starts_at, to_starts_at, actor
    FROM appointment_events WHERE appointment_id = :id ORDER BY id DESC LIMIT 1
    """
)


async def latest_event(session: AsyncSession, appointment_id: uuid.UUID) -> dict[str, Any] | None:
    row = (await session.execute(_LATEST, {"id": appointment_id})).mappings().first()
    return dict(row) if row else None
