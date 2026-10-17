"""Read-only aggregate queries for the admin dashboard.

Two time axes on purpose: *activity* is bucketed by ``appointment_events.occurred_at`` (when
someone booked, rescheduled or cancelled), *load* by ``appointments.starts_at`` (when the visit
happens). The aggregates are plain SQL with bound parameters; the filtered list is built with
SQLAlchemy Core.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import select, text, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.appointment import Appointment
from app.models.doctor import Doctor
from app.models.patient import Patient

_SERIES = text(
    """
    SELECT date_trunc(CAST(:bucket AS text), e.occurred_at AT TIME ZONE c.timezone) AS bucket_start,
           count(*) FILTER (WHERE e.event_type = 'booked')      AS booked,
           count(*) FILTER (WHERE e.event_type = 'rescheduled') AS rescheduled,
           count(*) FILTER (WHERE e.event_type = 'cancelled')   AS cancelled
    FROM appointment_events e
    JOIN doctors d ON d.id = e.doctor_id
    JOIN clinics c ON c.id = d.clinic_id
    WHERE e.occurred_at >= :from_ts AND e.occurred_at < :to_ts
    GROUP BY 1
    ORDER BY 1
    """
)

_UPCOMING = text("SELECT count(*) FROM appointments WHERE status = 'booked' AND starts_at >= :now")

_VISITS = text(
    """
    SELECT doctor_id, count(*) FILTER (WHERE status = 'booked') AS booked_visits
    FROM appointments
    WHERE starts_at >= :from_ts AND starts_at < :to_ts
    GROUP BY doctor_id
    """
)

_CANCEL_ACTIONS = text(
    """
    SELECT doctor_id, count(*) AS cancelled_actions
    FROM appointment_events
    WHERE event_type = 'cancelled' AND occurred_at >= :from_ts AND occurred_at < :to_ts
    GROUP BY doctor_id
    """
)

# 30-minute slots per doctor over the clinic-local dates [from, to): for every date, the working
# windows whose ISO weekday matches.
_CAPACITY = text(
    """
    SELECT w.doctor_id,
           sum(extract(epoch FROM (w.end_time - w.start_time)) / 1800)::int AS capacity
    FROM generate_series(
           CAST(:from_date AS date), CAST(:to_date AS date) - 1, interval '1 day'
         ) AS g(day)
    JOIN working_hours w ON w.weekday = extract(isodow FROM g.day)::int
    GROUP BY w.doctor_id
    """
)

_DOCTORS = text(
    """
    SELECT d.id AS doctor_id, d.full_name AS name, d.is_active
    FROM doctors d
    ORDER BY d.full_name, d.id
    """
)

_CLINIC_TZ = text("SELECT timezone FROM clinics ORDER BY created_at, id LIMIT 1")

_LINEAGE = text(
    """
    SELECT id, event_type, from_starts_at, to_starts_at, occurred_at
    FROM appointment_events
    WHERE appointment_id = :id
    ORDER BY id
    """
)

_APPT_EXISTS = text("SELECT 1 FROM appointments WHERE id = :id")


async def clinic_timezone(session: AsyncSession) -> str | None:
    return (await session.execute(_CLINIC_TZ)).scalar_one_or_none()


async def series(
    session: AsyncSession, *, bucket: str, from_ts: datetime, to_ts: datetime
) -> list[dict[str, Any]]:
    rows = await session.execute(_SERIES, {"bucket": bucket, "from_ts": from_ts, "to_ts": to_ts})
    return [dict(r) for r in rows.mappings()]


async def upcoming_active(session: AsyncSession, *, now: datetime) -> int:
    return int((await session.execute(_UPCOMING, {"now": now})).scalar_one())


async def doctors(session: AsyncSession) -> list[dict[str, Any]]:
    return [dict(r) for r in (await session.execute(_DOCTORS)).mappings()]


async def visits_by_doctor(
    session: AsyncSession, *, from_ts: datetime, to_ts: datetime
) -> dict[uuid.UUID, int]:
    rows = await session.execute(_VISITS, {"from_ts": from_ts, "to_ts": to_ts})
    return {r["doctor_id"]: int(r["booked_visits"]) for r in rows.mappings()}


async def cancel_actions_by_doctor(
    session: AsyncSession, *, from_ts: datetime, to_ts: datetime
) -> dict[uuid.UUID, int]:
    rows = await session.execute(_CANCEL_ACTIONS, {"from_ts": from_ts, "to_ts": to_ts})
    return {r["doctor_id"]: int(r["cancelled_actions"]) for r in rows.mappings()}


async def capacity_by_doctor(
    session: AsyncSession, *, from_date: date, to_date: date
) -> dict[uuid.UUID, int]:
    rows = await session.execute(_CAPACITY, {"from_date": from_date, "to_date": to_date})
    return {r["doctor_id"]: int(r["capacity"]) for r in rows.mappings()}


async def appointment_exists(session: AsyncSession, appointment_id: uuid.UUID) -> bool:
    return (await session.execute(_APPT_EXISTS, {"id": appointment_id})).first() is not None


async def lineage(session: AsyncSession, appointment_id: uuid.UUID) -> list[dict[str, Any]]:
    rows = await session.execute(_LINEAGE, {"id": appointment_id})
    return [dict(r) for r in rows.mappings()]


async def appointments_page(
    session: AsyncSession,
    *,
    status: str,
    doctor_id: uuid.UUID | None,
    from_ts: datetime | None,
    to_ts: datetime | None,
    after: tuple[datetime, uuid.UUID] | None,
    limit: int,
) -> list[dict[str, Any]]:
    """One page plus one extra row (the caller trims it and derives ``next_cursor``)."""
    stmt = (
        select(
            Appointment.id,
            Appointment.doctor_id,
            Doctor.full_name.label("doctor_name"),
            Appointment.patient_id,
            Patient.full_name.label("patient_name"),
            Appointment.starts_at,
            Appointment.ends_at,
            Appointment.status,
            Appointment.cancellation_reason,
            Appointment.created_at,
        )
        .join(Doctor, Doctor.id == Appointment.doctor_id)
        .join(Patient, Patient.id == Appointment.patient_id)
        .order_by(Appointment.starts_at.desc(), Appointment.id.desc())
        .limit(limit + 1)
    )
    if status != "all":
        stmt = stmt.where(Appointment.status == status)
    if doctor_id is not None:
        stmt = stmt.where(Appointment.doctor_id == doctor_id)
    if from_ts is not None:
        stmt = stmt.where(Appointment.starts_at >= from_ts)
    if to_ts is not None:
        stmt = stmt.where(Appointment.starts_at < to_ts)
    if after is not None:
        # Keyset paging on the same (starts_at DESC, id DESC) order the index serves.
        stmt = stmt.where(tuple_(Appointment.starts_at, Appointment.id) < tuple_(*after))
    rows = await session.execute(stmt)
    return [dict(r) for r in rows.mappings()]
