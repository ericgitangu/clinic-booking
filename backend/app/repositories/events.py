from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.events import EventFields
from app.models.appointment_event import AppointmentEvent


async def insert_event(
    session: AsyncSession,
    *,
    appointment_id: uuid.UUID,
    doctor_id: uuid.UUID,
    fields: EventFields,
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
        )
    )
    await session.flush()
