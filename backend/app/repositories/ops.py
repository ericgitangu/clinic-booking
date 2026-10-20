"""Read queries behind the operations dashboard.

Like ``repositories.admin``, everything that is shown or counted leaves out synthetic patients
(``NOT p.synthetic``); demo patients are ordinary rows and are included. The one deliberate
exception is slot occupancy for gaps, which counts every booked appointment: a slot a synthetic
booking holds is not free for anyone.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.repositories.admin import range_params

_DOCTORS = text(
    """
    SELECT d.id, d.full_name, d.specialty, c.timezone
    FROM doctors d JOIN clinics c ON c.id = d.clinic_id
    WHERE d.is_active
    ORDER BY d.full_name, d.id
    """
)

_BOARD = text(
    """
    SELECT a.id, a.doctor_id, a.starts_at, a.ends_at, a.status, p.full_name, p.phone,
           pa.image_url,
           (a.staff_locked_at IS NOT NULL) AS locked,
           (SELECT t.kind FROM appointment_attendance t
             WHERE t.appointment_id = a.id ORDER BY t.id DESC LIMIT 1) AS attendance,
           le.event_type AS latest_event_type, le.actor AS latest_actor,
           EXISTS (SELECT 1 FROM appointments s WHERE s.predecessor_id = a.id) AS has_successor
    FROM appointments a JOIN patients p ON p.id = a.patient_id
    LEFT JOIN LATERAL (
      SELECT e.event_type, e.actor FROM appointment_events e
      WHERE e.appointment_id = a.id ORDER BY e.id DESC LIMIT 1
    ) le ON true
    LEFT JOIN patient_accounts pa ON pa.patient_id = p.id
    WHERE NOT p.synthetic AND a.starts_at >= :lo AND a.starts_at < :hi
    ORDER BY a.starts_at, a.id
    """
)

# The change events of one kind whose clinic-local day of occurrence is in [from, to): the same
# basis and joins as the metrics series, so a count here is that series' point. ``:ids`` narrows to
# the events of a cancellation-reason category (decided in Python by the shared classifier).
_CHANGES_COUNT = text(
    """
    SELECT count(*)
    FROM appointment_events e
    JOIN appointments a ON a.id = e.appointment_id
    JOIN patients p ON p.id = a.patient_id
    JOIN doctors d ON d.id = e.doctor_id
    JOIN clinics c ON c.id = d.clinic_id
    WHERE NOT p.synthetic AND e.event_type = :kind
      AND e.occurred_at >= :coarse_from AND e.occurred_at < :coarse_to
      AND (e.occurred_at AT TIME ZONE c.timezone) >= CAST(:from_day AS timestamp)
      AND (e.occurred_at AT TIME ZONE c.timezone) < CAST(:to_day AS timestamp)
      AND (CAST(:doctor_id AS uuid) IS NULL OR e.doctor_id = CAST(:doctor_id AS uuid))
      AND (CAST(:ids AS bigint[]) IS NULL OR e.id = ANY(CAST(:ids AS bigint[])))
    """
)

_CHANGES_PAGE = text(
    """
    SELECT e.id, e.appointment_id, e.doctor_id, d.full_name AS doctor_name,
           p.full_name AS patient_name, e.event_type AS kind, e.occurred_at, e.actor,
           e.from_starts_at, e.to_starts_at, a.starts_at, a.status, a.cancellation_reason,
           c.timezone,
           (SELECT t.kind FROM appointment_attendance t
             WHERE t.appointment_id = a.id ORDER BY t.id DESC LIMIT 1) AS attendance
    FROM appointment_events e
    JOIN appointments a ON a.id = e.appointment_id
    JOIN patients p ON p.id = a.patient_id
    JOIN doctors d ON d.id = e.doctor_id
    JOIN clinics c ON c.id = d.clinic_id
    WHERE NOT p.synthetic AND e.event_type = :kind
      AND e.occurred_at >= :coarse_from AND e.occurred_at < :coarse_to
      AND (e.occurred_at AT TIME ZONE c.timezone) >= CAST(:from_day AS timestamp)
      AND (e.occurred_at AT TIME ZONE c.timezone) < CAST(:to_day AS timestamp)
      AND (CAST(:doctor_id AS uuid) IS NULL OR e.doctor_id = CAST(:doctor_id AS uuid))
      AND (CAST(:ids AS bigint[]) IS NULL OR e.id = ANY(CAST(:ids AS bigint[])))
      AND (CAST(:after_at AS timestamptz) IS NULL
           OR (e.occurred_at, e.id) < (CAST(:after_at AS timestamptz), CAST(:after_id AS bigint)))
    ORDER BY e.occurred_at DESC, e.id DESC
    LIMIT :limit
    """
)

# Every cancelled event of the range with its reason text, to group them with the classifier.
_CHANGES_REASONS = text(
    """
    SELECT e.id, a.cancellation_reason
    FROM appointment_events e
    JOIN appointments a ON a.id = e.appointment_id
    JOIN patients p ON p.id = a.patient_id
    JOIN doctors d ON d.id = e.doctor_id
    JOIN clinics c ON c.id = d.clinic_id
    WHERE NOT p.synthetic AND e.event_type = 'cancelled'
      AND e.occurred_at >= :coarse_from AND e.occurred_at < :coarse_to
      AND (e.occurred_at AT TIME ZONE c.timezone) >= CAST(:from_day AS timestamp)
      AND (e.occurred_at AT TIME ZONE c.timezone) < CAST(:to_day AS timestamp)
      AND (CAST(:doctor_id AS uuid) IS NULL OR e.doctor_id = CAST(:doctor_id AS uuid))
    """
)

_OCCUPIED = text(
    """
    SELECT doctor_id, starts_at, ends_at FROM appointments
    WHERE status = 'booked' AND starts_at < :hi AND ends_at > :lo
    """
)

# Appointments whose start falls in the clinic-local day range, with the latest attendance mark.
_COHORT = text(
    """
    SELECT count(*) FILTER (WHERE a.status = 'booked') AS booked,
           count(*) FILTER (WHERE a.status = 'cancelled') AS cancelled,
           count(*) FILTER (WHERE a.status = 'booked' AND att.kind = 'arrived') AS arrived,
           count(*) FILTER (WHERE a.status = 'booked' AND att.kind = 'no_show') AS no_show,
           percentile_cont(0.5) WITHIN GROUP (
             ORDER BY extract(epoch FROM (a.starts_at - a.created_at)) / 60
           ) FILTER (WHERE a.status = 'booked') AS median_lead_minutes
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    JOIN doctors d ON d.id = a.doctor_id
    JOIN clinics c ON c.id = d.clinic_id
    LEFT JOIN LATERAL (
      SELECT t.kind FROM appointment_attendance t
      WHERE t.appointment_id = a.id ORDER BY t.id DESC LIMIT 1
    ) att ON true
    WHERE NOT p.synthetic
      AND a.starts_at >= :coarse_from AND a.starts_at < :coarse_to
      AND (a.starts_at AT TIME ZONE c.timezone) >= CAST(:from_day AS timestamp)
      AND (a.starts_at AT TIME ZONE c.timezone) < CAST(:to_day AS timestamp)
    """
)

_RESCHEDULES = text(
    """
    SELECT count(*) FROM appointment_events e
    JOIN appointments a ON a.id = e.appointment_id
    JOIN patients p ON p.id = a.patient_id
    JOIN doctors d ON d.id = e.doctor_id
    JOIN clinics c ON c.id = d.clinic_id
    WHERE NOT p.synthetic AND e.event_type = 'rescheduled'
      AND e.occurred_at >= :coarse_from AND e.occurred_at < :coarse_to
      AND (e.occurred_at AT TIME ZONE c.timezone) >= CAST(:from_day AS timestamp)
      AND (e.occurred_at AT TIME ZONE c.timezone) < CAST(:to_day AS timestamp)
    """
)

_REASONS = text(
    """
    SELECT a.cancellation_reason
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    JOIN doctors d ON d.id = a.doctor_id
    JOIN clinics c ON c.id = d.clinic_id
    WHERE NOT p.synthetic AND a.status = 'cancelled'
      AND a.cancelled_at >= :coarse_from AND a.cancelled_at < :coarse_to
      AND (a.cancelled_at AT TIME ZONE c.timezone) >= CAST(:from_day AS timestamp)
      AND (a.cancelled_at AT TIME ZONE c.timezone) < CAST(:to_day AS timestamp)
    """
)

_HEATMAP = text(
    """
    SELECT extract(isodow FROM (a.starts_at AT TIME ZONE c.timezone))::int AS weekday,
           extract(hour FROM (a.starts_at AT TIME ZONE c.timezone))::int AS hour,
           count(*) AS n
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    JOIN doctors d ON d.id = a.doctor_id
    JOIN clinics c ON c.id = d.clinic_id
    WHERE NOT p.synthetic AND a.status = 'booked'
      AND (CAST(:doctor_id AS uuid) IS NULL OR a.doctor_id = CAST(:doctor_id AS uuid))
      AND a.starts_at >= :coarse_from AND a.starts_at < :coarse_to
      AND (a.starts_at AT TIME ZONE c.timezone) >= CAST(:from_day AS timestamp)
      AND (a.starts_at AT TIME ZONE c.timezone) < CAST(:to_day AS timestamp)
    GROUP BY 1, 2
    ORDER BY 1, 2
    """
)

_REMAINING = text(
    """
    SELECT a.id, a.starts_at, p.full_name, p.email
    FROM appointments a JOIN patients p ON p.id = a.patient_id
    WHERE NOT p.synthetic AND a.doctor_id = :doctor_id AND a.status = 'booked'
      AND a.starts_at >= :now AND a.starts_at < :day_end
      AND NOT EXISTS (SELECT 1 FROM appointment_attendance t WHERE t.appointment_id = a.id)
    ORDER BY a.starts_at, a.id
    LIMIT :limit
    """
)

_DAY_SHEET = text(
    """
    SELECT a.id, a.doctor_id, d.full_name AS doctor_name, a.starts_at, a.status,
           p.full_name, p.phone, p.email, a.cancellation_reason, c.timezone,
           (SELECT t.kind FROM appointment_attendance t
             WHERE t.appointment_id = a.id ORDER BY t.id DESC LIMIT 1) AS attendance
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    JOIN doctors d ON d.id = a.doctor_id
    JOIN clinics c ON c.id = d.clinic_id
    WHERE NOT p.synthetic
      AND a.starts_at >= :coarse_from AND a.starts_at < :coarse_to
      AND (a.starts_at AT TIME ZONE c.timezone) >= CAST(:from_day AS timestamp)
      AND (a.starts_at AT TIME ZONE c.timezone) < CAST(:to_day AS timestamp)
      AND (CAST(:doctor_id AS uuid) IS NULL OR a.doctor_id = CAST(:doctor_id AS uuid))
    ORDER BY d.full_name, a.starts_at, a.id
    """
)


async def doctors(session: AsyncSession) -> list[dict[str, Any]]:
    return [dict(r) for r in (await session.execute(_DOCTORS)).mappings()]


async def board_appointments(
    session: AsyncSession, *, lo: datetime, hi: datetime
) -> list[dict[str, Any]]:
    rows = await session.execute(_BOARD, {"lo": lo, "hi": hi})
    return [dict(r) for r in rows.mappings()]


async def occupied(session: AsyncSession, *, lo: datetime, hi: datetime) -> list[dict[str, Any]]:
    rows = await session.execute(_OCCUPIED, {"lo": lo, "hi": hi})
    return [dict(r) for r in rows.mappings()]


async def cohort(session: AsyncSession, *, from_day: date, to_day: date) -> dict[str, Any]:
    row = await session.execute(_COHORT, range_params(from_day, to_day))
    return dict(row.mappings().one())


async def reschedules(session: AsyncSession, *, from_day: date, to_day: date) -> int:
    return int((await session.execute(_RESCHEDULES, range_params(from_day, to_day))).scalar_one())


async def cancellation_reasons(
    session: AsyncSession, *, from_day: date, to_day: date
) -> list[str | None]:
    rows = await session.execute(_REASONS, range_params(from_day, to_day))
    return [r[0] for r in rows.all()]


async def heatmap(
    session: AsyncSession, *, from_day: date, to_day: date, doctor_id: uuid.UUID | None
) -> list[dict[str, Any]]:
    params = {**range_params(from_day, to_day), "doctor_id": doctor_id}
    return [dict(r) for r in (await session.execute(_HEATMAP, params)).mappings()]


async def day_sheet(
    session: AsyncSession, *, day: date, next_day: date, doctor_id: uuid.UUID | None
) -> list[dict[str, Any]]:
    params = {**range_params(day, next_day), "doctor_id": doctor_id}
    return [dict(r) for r in (await session.execute(_DAY_SHEET, params)).mappings()]


async def remaining_for_doctor(
    session: AsyncSession, *, doctor_id: uuid.UUID, now: datetime, day_end: datetime, limit: int
) -> list[dict[str, Any]]:
    """The doctor's booked, unmarked, non-synthetic appointments from now to the end of the day."""
    params = {"doctor_id": doctor_id, "now": now, "day_end": day_end, "limit": limit}
    return [dict(r) for r in (await session.execute(_REMAINING, params)).mappings()]


async def change_reason_texts(
    session: AsyncSession, *, from_day: date, to_day: date, doctor_id: uuid.UUID | None
) -> list[tuple[int, str | None]]:
    params = {**range_params(from_day, to_day), "doctor_id": doctor_id}
    rows = await session.execute(_CHANGES_REASONS, params)
    return [(int(r[0]), r[1]) for r in rows.all()]


async def changes_count(
    session: AsyncSession,
    *,
    kind: str,
    from_day: date,
    to_day: date,
    doctor_id: uuid.UUID | None,
    ids: list[int] | None,
) -> int:
    params = {**range_params(from_day, to_day), "kind": kind, "doctor_id": doctor_id, "ids": ids}
    return int((await session.execute(_CHANGES_COUNT, params)).scalar_one())


async def changes_page(
    session: AsyncSession,
    *,
    kind: str,
    from_day: date,
    to_day: date,
    doctor_id: uuid.UUID | None,
    ids: list[int] | None,
    after: tuple[datetime, int] | None,
    limit: int,
) -> list[dict[str, Any]]:
    """``limit`` rows, newest change first; the caller asks for one more than it shows."""
    params = {
        **range_params(from_day, to_day),
        "kind": kind,
        "doctor_id": doctor_id,
        "ids": ids,
        "after_at": after[0] if after else None,
        "after_id": after[1] if after else None,
        "limit": limit,
    }
    return [dict(r) for r in (await session.execute(_CHANGES_PAGE, params)).mappings()]
