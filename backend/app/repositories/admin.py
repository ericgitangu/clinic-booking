"""Read-only aggregate queries for the admin dashboard.

Two time axes on purpose: *activity* is bucketed by ``appointment_events.occurred_at`` (when
someone booked, rescheduled or cancelled), *load* by ``appointments.starts_at`` (when the visit
happens). The aggregates are plain SQL with bound parameters; the filtered list is built with
SQLAlchemy Core.

Every query here leaves out the appointments (and their events) of synthetic patients: the release
pipeline's smoke test books and cancels real rows on every release, and those are not clinic
activity. Each statement carries ``NOT p.synthetic`` through a join on the appointment's patient;
``tests/integration/test_synthetic.py`` fails when the series, upcoming, visits, cancel-action or
list filter is dropped on its own; the lineage query's filter is covered only together with the
existence check in front of it, not alone. Patient-facing
availability is a different code path and still counts a synthetic booking as holding its slot.
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, time, timedelta
from typing import Any

from sqlalchemy import column, func, null, select, table, text, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.appointment import Appointment
from app.models.attendance import AppointmentAttendance
from app.models.clinic import Clinic
from app.models.doctor import Doctor
from app.models.patient import Patient

# The latest attendance mark of the appointment, as a column of the same SELECT.
_LATEST_ATTENDANCE = (
    select(AppointmentAttendance.kind)
    .where(AppointmentAttendance.appointment_id == Appointment.id)
    .order_by(AppointmentAttendance.id.desc())
    .limit(1)
    .scalar_subquery()
)
# patient_accounts has no ORM model; only the two columns the admin views read are named here.
PatientAccountRow = table("patient_accounts", column("patient_id"), column("image_url"))

_SERIES = text(
    """
    SELECT date_trunc(CAST(:bucket AS text), e.occurred_at AT TIME ZONE c.timezone) AS bucket_start,
           count(*) FILTER (WHERE e.event_type = 'booked')      AS booked,
           count(*) FILTER (WHERE e.event_type = 'rescheduled') AS rescheduled,
           count(*) FILTER (WHERE e.event_type = 'cancelled')   AS cancelled
    FROM appointment_events e
    JOIN appointments a ON a.id = e.appointment_id
    JOIN patients p ON p.id = a.patient_id
    JOIN doctors d ON d.id = e.doctor_id
    JOIN clinics c ON c.id = d.clinic_id
    WHERE NOT p.synthetic
      AND e.occurred_at >= :coarse_from AND e.occurred_at < :coarse_to
      AND (e.occurred_at AT TIME ZONE c.timezone) >= CAST(:from_day AS timestamp)
      AND (e.occurred_at AT TIME ZONE c.timezone) < CAST(:to_day AS timestamp)
    GROUP BY 1
    ORDER BY 1
    """
)

_UPCOMING = text(
    """
    SELECT count(*)
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    WHERE NOT p.synthetic AND a.status = 'booked' AND a.starts_at >= :now
    """
)

_VISITS = text(
    """
    SELECT a.doctor_id, count(*) FILTER (WHERE a.status = 'booked') AS booked_visits
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    JOIN doctors d ON d.id = a.doctor_id
    JOIN clinics c ON c.id = d.clinic_id
    WHERE NOT p.synthetic
      AND a.starts_at >= :coarse_from AND a.starts_at < :coarse_to
      AND (a.starts_at AT TIME ZONE c.timezone) >= CAST(:from_day AS timestamp)
      AND (a.starts_at AT TIME ZONE c.timezone) < CAST(:to_day AS timestamp)
    GROUP BY a.doctor_id
    """
)

_CANCEL_ACTIONS = text(
    """
    SELECT e.doctor_id, count(*) AS cancelled_actions
    FROM appointment_events e
    JOIN appointments a ON a.id = e.appointment_id
    JOIN patients p ON p.id = a.patient_id
    JOIN doctors d ON d.id = e.doctor_id
    JOIN clinics c ON c.id = d.clinic_id
    WHERE NOT p.synthetic
      AND e.event_type = 'cancelled'
      AND e.occurred_at >= :coarse_from AND e.occurred_at < :coarse_to
      AND (e.occurred_at AT TIME ZONE c.timezone) >= CAST(:from_day AS timestamp)
      AND (e.occurred_at AT TIME ZONE c.timezone) < CAST(:to_day AS timestamp)
    GROUP BY e.doctor_id
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

_LINEAGE = text(
    """
    SELECT e.id, e.event_type, e.from_starts_at, e.to_starts_at, e.occurred_at, e.actor,
           c.timezone AS timezone
    FROM appointment_events e
    JOIN appointments a ON a.id = e.appointment_id
    JOIN patients p ON p.id = a.patient_id
    JOIN doctors d ON d.id = e.doctor_id
    JOIN clinics c ON c.id = d.clinic_id
    WHERE NOT p.synthetic AND e.appointment_id = :id
      AND e.event_type IN ('booked', 'rescheduled', 'cancelled')
    ORDER BY e.id
    """
)

# The appointment's patient for the lineage header, with the Google picture only when allowed.
_APPT_PATIENT = text(
    """
    SELECT p.id AS patient_id, p.full_name AS patient_name,
           CASE WHEN :show THEN pa.image_url END AS avatar_url
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    LEFT JOIN patient_accounts pa ON pa.patient_id = p.id
    WHERE NOT p.synthetic AND a.id = :id
    """
)


def _range_params(from_day: date, to_day: date) -> dict[str, Any]:
    """Bind values for a clinic-local day range ``[from_day, to_day)``.

    The exact test compares each row's instant, converted to the zone of that row's own clinic,
    with the two local midnights. The coarse UTC bounds (a day of slack either side, wider than any
    UTC offset) let Postgres use the time index before that per-row test runs.
    """
    return {
        "from_day": datetime.combine(from_day, time.min),
        "to_day": datetime.combine(to_day, time.min),
        "coarse_from": datetime.combine(from_day - timedelta(days=1), time.min, UTC),
        "coarse_to": datetime.combine(to_day + timedelta(days=1), time.min, UTC),
    }


async def series(
    session: AsyncSession, *, bucket: str, from_day: date, to_day: date
) -> list[dict[str, Any]]:
    rows = await session.execute(_SERIES, {"bucket": bucket, **_range_params(from_day, to_day)})
    return [dict(r) for r in rows.mappings()]


async def upcoming_active(session: AsyncSession, *, now: datetime) -> int:
    return int((await session.execute(_UPCOMING, {"now": now})).scalar_one())


async def doctors(session: AsyncSession) -> list[dict[str, Any]]:
    return [dict(r) for r in (await session.execute(_DOCTORS)).mappings()]


async def visits_by_doctor(
    session: AsyncSession, *, from_day: date, to_day: date
) -> dict[uuid.UUID, int]:
    rows = await session.execute(_VISITS, _range_params(from_day, to_day))
    return {r["doctor_id"]: int(r["booked_visits"]) for r in rows.mappings()}


async def cancel_actions_by_doctor(
    session: AsyncSession, *, from_day: date, to_day: date
) -> dict[uuid.UUID, int]:
    rows = await session.execute(_CANCEL_ACTIONS, _range_params(from_day, to_day))
    return {r["doctor_id"]: int(r["cancelled_actions"]) for r in rows.mappings()}


async def capacity_by_doctor(
    session: AsyncSession, *, from_date: date, to_date: date
) -> dict[uuid.UUID, int]:
    rows = await session.execute(_CAPACITY, {"from_date": from_date, "to_date": to_date})
    return {r["doctor_id"]: int(r["capacity"]) for r in rows.mappings()}


async def appointment_patient(
    session: AsyncSession, appointment_id: uuid.UUID, *, show_avatars: bool
) -> dict[str, Any] | None:
    """The patient of a non-synthetic appointment, or None when there is no such appointment."""
    row = (
        (await session.execute(_APPT_PATIENT, {"id": appointment_id, "show": show_avatars}))
        .mappings()
        .first()
    )
    return dict(row) if row is not None else None


async def lineage(session: AsyncSession, appointment_id: uuid.UUID) -> list[dict[str, Any]]:
    rows = await session.execute(_LINEAGE, {"id": appointment_id})
    return [dict(r) for r in rows.mappings()]


def _appointment_select(
    *, show_avatars: bool = False
) -> Any:  # a Core Select whose column tuple is too long to spell
    """An admin appointment row: doctor, patient, clinic zone, lock and latest attendance.
    Synthetic patients are left out here, so the list and the single read share the filter."""
    return (
        select(
            Appointment.id,
            Appointment.doctor_id,
            Doctor.full_name.label("doctor_name"),
            Appointment.patient_id,
            Patient.full_name.label("patient_name"),
            Patient.phone.label("patient_phone"),
            Patient.email.label("patient_email"),
            Appointment.starts_at,
            Appointment.ends_at,
            Appointment.status,
            Appointment.cancellation_reason,
            (Appointment.staff_locked_at.is_not(None)).label("staff_locked"),
            _LATEST_ATTENDANCE.label("attendance"),
            Appointment.created_at,
            Clinic.timezone.label("timezone"),
            (PatientAccountRow.c.image_url if show_avatars else null()).label("avatar_url"),
        )
        .join(Doctor, Doctor.id == Appointment.doctor_id)
        .join(Clinic, Clinic.id == Doctor.clinic_id)
        .join(Patient, Patient.id == Appointment.patient_id)
        .outerjoin(PatientAccountRow, PatientAccountRow.c.patient_id == Patient.id)
        .where(Patient.synthetic.is_(False))
    )


async def appointment_row(
    session: AsyncSession, appointment_id: uuid.UUID, *, show_avatars: bool = False
) -> dict[str, Any] | None:
    stmt = _appointment_select(show_avatars=show_avatars).where(Appointment.id == appointment_id)
    row = (await session.execute(stmt)).mappings().first()
    return dict(row) if row else None


async def appointments_page(
    session: AsyncSession,
    *,
    status: str,
    doctor_id: uuid.UUID | None,
    from_day: date | None,
    to_day: date | None,
    after: tuple[datetime, uuid.UUID] | None,
    limit: int,
    show_avatars: bool = False,
) -> list[dict[str, Any]]:
    """One page plus one extra row (the caller trims it and derives ``next_cursor``)."""
    stmt = (
        _appointment_select(show_avatars=show_avatars)
        .order_by(Appointment.starts_at.desc(), Appointment.id.desc())
        .limit(limit + 1)
    )
    if status != "all":
        stmt = stmt.where(Appointment.status == status)
    if doctor_id is not None:
        stmt = stmt.where(Appointment.doctor_id == doctor_id)
    # Dates are clinic-local days: compare each row's start, in the zone of its own clinic, with
    # the local midnight. The coarse UTC bound lets the starts_at index narrow the scan first.
    local_start = func.timezone(Clinic.timezone, Appointment.starts_at)
    if from_day is not None:
        stmt = stmt.where(
            Appointment.starts_at >= datetime.combine(from_day - timedelta(days=1), time.min, UTC),
            local_start >= datetime.combine(from_day, time.min),
        )
    if to_day is not None:
        stmt = stmt.where(
            Appointment.starts_at < datetime.combine(to_day + timedelta(days=1), time.min, UTC),
            local_start < datetime.combine(to_day, time.min),
        )
    if after is not None:
        # Keyset paging on the same (starts_at DESC, id DESC) order the index serves.
        stmt = stmt.where(tuple_(Appointment.starts_at, Appointment.id) < tuple_(*after))
    rows = await session.execute(stmt)
    return [dict(r) for r in rows.mappings()]


# The clinic-local day range, as bind values, for the other read-model repositories.
range_params = _range_params
