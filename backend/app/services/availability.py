from __future__ import annotations

import uuid
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import Clock
from app.core.config import Settings
from app.domain.errors import DateOutOfRange, DoctorNotFound
from app.domain.slots import generate_slots, taken_starts
from app.repositories.appointments import booked_intervals_for_doctor
from app.repositories.doctors import get_active_doctor, get_clinic, working_hours_for
from app.schemas.availability import Availability, Slot
from app.services.relay import horizon_cursor


async def get_availability(
    session: AsyncSession,
    clock: Clock,
    settings: Settings,
    doctor_id: uuid.UUID,
    on_date: date,
) -> Availability:
    # First, so the cursor can only be older than the data read below, never newer.
    cursor = await horizon_cursor(session)
    doctor = await get_active_doctor(session, doctor_id)
    if doctor is None:
        raise DoctorNotFound()
    clinic = await get_clinic(session, doctor.clinic_id)
    if clinic is None:  # referential integrity guarantees this, but keep mypy and reality honest
        raise DoctorNotFound()

    tz = ZoneInfo(clinic.timezone)
    now = clock.now()
    today_local = now.astimezone(tz).date()
    if on_date > today_local + timedelta(days=settings.BOOKING_HORIZON_DAYS):
        raise DateOutOfRange()

    weekday = on_date.isoweekday()
    windows = [
        (wh.start_time, wh.end_time)
        for wh in await working_hours_for(session, doctor_id)
        if wh.weekday == weekday
    ]

    day_start = datetime.combine(on_date, time.min, tzinfo=tz).astimezone(UTC)
    next_day_start = datetime.combine(on_date + timedelta(days=1), time.min, tzinfo=tz).astimezone(
        UTC
    )
    booked = await booked_intervals_for_doctor(session, doctor_id, day_start, next_day_start)

    lead = timedelta(minutes=settings.BOOKING_MIN_LEAD_MINUTES)
    slots = generate_slots(windows, booked, tz, on_date, now, lead)
    return Availability(
        doctor_id=doctor_id,
        date=on_date.isoformat(),
        timezone=clinic.timezone,
        cursor=cursor,
        slots=[
            Slot(starts_at=s.starts_at.astimezone(tz), ends_at=s.ends_at.astimezone(tz))
            for s in slots
        ],
        taken=[t.astimezone(tz) for t in taken_starts(windows, booked, tz, on_date)],
    )
