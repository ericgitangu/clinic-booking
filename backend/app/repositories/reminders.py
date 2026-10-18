"""Reminder claims and the daily email counter."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import TextClause, text
from sqlalchemy.ext.asyncio import AsyncSession

# One statement claims the due rows. A row is due when it is booked, has not been reminded, belongs
# to a patient with a linked, verified Google account, starts inside the window and in the future,
# and is not under a live lease. The email is the one that account was linked with: an address typed
# into the public API is never emailed. A link exists only for a verified email (the link route
# refuses anything else). FOR UPDATE SKIP LOCKED means two runs at the same moment get different
# rows, never the same one. The lease is the claim time: a claim older than the cutoff can be taken
# again.
#
# "Tomorrow" is each appointment's own clinic's tomorrow: the target date is worked out in the zone
# of the clinic the doctor works at (or is ``:on_date`` when a rehearsal names one), and the window
# is that local day. Without ``:on_date`` the window starts now, so a reminder that could not be
# sent earlier is picked up again while the appointment is still ahead.
_CLAIM = text(
    """
    WITH due AS (
      SELECT a.id
      FROM appointments a
      JOIN patient_accounts pa ON pa.patient_id = a.patient_id
      JOIN doctors dr ON dr.id = a.doctor_id
      JOIN clinics cl ON cl.id = dr.clinic_id
      CROSS JOIN LATERAL (
        SELECT COALESCE(
          CAST(:on_date AS date),
          CAST(CAST(:now AS timestamptz) AT TIME ZONE cl.timezone AS date) + 1
        ) AS target
      ) t
      WHERE a.status = 'booked'
        AND a.reminder_sent_at IS NULL
        AND (a.reminder_claimed_at IS NULL OR a.reminder_claimed_at < :lease_cutoff)
        AND a.starts_at > :now
        AND a.starts_at >= CASE
              WHEN CAST(:on_date AS date) IS NULL THEN CAST(:now AS timestamptz)
              ELSE CAST(t.target AS timestamp) AT TIME ZONE cl.timezone
            END
        AND a.starts_at < CAST(t.target + 1 AS timestamp) AT TIME ZONE cl.timezone
      ORDER BY a.starts_at, a.id
      LIMIT :n
      FOR UPDATE OF a SKIP LOCKED
    ), claimed AS (
      UPDATE appointments a SET reminder_claimed_at = :now
      FROM due WHERE a.id = due.id
      RETURNING a.id, a.starts_at, a.doctor_id, a.patient_id
    )
    SELECT c.id AS appointment_id, c.starts_at, d.full_name AS doctor_name, d.specialty,
           p.full_name AS patient_name, pa.email AS patient_email,
           cl.timezone AS timezone,
           CAST(:now AS timestamptz) AS claimed_at
    FROM claimed c
    JOIN doctors d ON d.id = c.doctor_id
    JOIN clinics cl ON cl.id = d.clinic_id
    JOIN patients p ON p.id = c.patient_id
    JOIN patient_accounts pa ON pa.patient_id = c.patient_id
    ORDER BY c.starts_at, c.id
    """
)

# Marked sent only for the claim it was sent under: the claim time and the start time must still be
# the ones that were claimed. A reschedule clears the claim and moves the start, so a late "sent"
# for the old time can never suppress the reminder for the new one.
_MARK_SENT = text(
    """
    UPDATE appointments SET reminder_sent_at = :now
    WHERE id = :id
      AND status = 'booked'
      AND reminder_sent_at IS NULL
      AND reminder_claimed_at = :claimed_at
      AND starts_at = :starts_at
    RETURNING reminder_sent_at
    """
)

_COUNT_TODAY = text("SELECT sent FROM email_counter WHERE day = :day")

_COUNT_MONTH = text("SELECT sent FROM email_month_counter WHERE month = :month")

# Reserving one email is an atomic conditional upsert per counter: the row is created at 1, or moved
# up by one only while the result stays within the cap, so concurrent senders (on any number of API
# instances) can never take more than the cap. No row back means the cap was reached.
_DAY_UP = text(
    """
    INSERT INTO email_counter (day, sent) VALUES (:day, 1)
    ON CONFLICT (day) DO UPDATE SET sent = email_counter.sent + 1
    WHERE email_counter.sent + 1 <= :cap
    RETURNING sent
    """
)
_MONTH_UP = text(
    """
    INSERT INTO email_month_counter (month, sent) VALUES (:month, 1)
    ON CONFLICT (month) DO UPDATE SET sent = email_month_counter.sent + 1
    WHERE email_month_counter.sent + 1 <= :cap
    RETURNING sent
    """
)
_DAY_DOWN = text(
    "UPDATE email_counter SET sent = GREATEST(sent - 1, 0) WHERE day = :day RETURNING sent"
)
_MONTH_DOWN = text(
    "UPDATE email_month_counter SET sent = GREATEST(sent - 1, 0) WHERE month = :month "
    "RETURNING sent"
)


class _Refused(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


async def claim(
    session: AsyncSession,
    *,
    now: datetime,
    lease_cutoff: datetime,
    on_date: date | None,
    limit: int,
) -> list[dict[str, Any]]:
    rows = await session.execute(
        _CLAIM,
        {
            "now": now,
            "lease_cutoff": lease_cutoff,
            "on_date": on_date,
            "n": limit,
        },
    )
    return [dict(r) for r in rows.mappings().all()]


async def mark_sent(
    session: AsyncSession,
    *,
    appointment_id: uuid.UUID,
    claimed_at: datetime,
    starts_at: datetime,
    now: datetime,
) -> datetime | None:
    return (
        await session.execute(
            _MARK_SENT,
            {"id": appointment_id, "claimed_at": claimed_at, "starts_at": starts_at, "now": now},
        )
    ).scalar_one_or_none()


async def sent_today(session: AsyncSession, day: date) -> int:
    return int((await session.execute(_COUNT_TODAY, {"day": day})).scalar_one_or_none() or 0)


async def sent_month(session: AsyncSession, month: date) -> int:
    return int((await session.execute(_COUNT_MONTH, {"month": month})).scalar_one_or_none() or 0)


async def _between_counters(session: AsyncSession) -> None:
    """No-op seam between the two counter writes. The race test replaces it with a ``pg_sleep`` so
    the window in which one transaction holds the first row and wants the second is wide, as the
    booking service's ``_after_write`` does."""
    return None


async def _month_then_day(
    session: AsyncSession,
    month_sql: TextClause,
    month_params: dict[str, Any],
    day_sql: TextClause,
    day_params: dict[str, Any],
    *,
    stop_if_month_missing: bool,
) -> tuple[Any, Any]:
    """Write the month counter, then the day counter: the one lock order for every writer.

    Each write takes a row lock that is held until the transaction ends. If one path locked month
    then day and another day then month, two concurrent transactions (a reserve and a release)
    would each hold one row and wait for the other, and Postgres would abort one with a deadlock
    (40P01). Every path goes through here, so the order is month, then day, always. Returns the row
    each statement returned (None for a statement that matched nothing or did not run).
    """
    month_row = (await session.execute(month_sql, month_params)).first()
    if month_row is None and stop_if_month_missing:
        return None, None
    await _between_counters(session)
    day_row = (await session.execute(day_sql, day_params)).first()
    return month_row, day_row


async def reserve(
    session: AsyncSession, *, day: date, month: date, day_cap: int, month_cap: int
) -> str | None:
    """Take one email from the day and the month, together or not at all. Returns None when it was
    taken, else which cap refused it ("month" or "day"). Run inside ``session.begin()``: a refusal
    by the second counter is undone by the savepoint, so no counter is left moved."""
    if month_cap < 1:
        return "month"
    if day_cap < 1:
        return "day"
    try:
        async with session.begin_nested():
            month_row, day_row = await _month_then_day(
                session,
                _MONTH_UP,
                {"month": month, "cap": month_cap},
                _DAY_UP,
                {"day": day, "cap": day_cap},
                stop_if_month_missing=True,
            )
            if month_row is None:
                raise _Refused("month")
            if day_row is None:
                raise _Refused("day")  # the savepoint rolls the month's increment back too
    except _Refused as refused:
        return refused.reason
    return None


async def release(session: AsyncSession, *, day: date, month: date) -> None:
    """Give back one reserved email whose send failed, to the day and month it was taken from.
    Same lock order as ``reserve`` (month, then day)."""
    await _month_then_day(
        session,
        _MONTH_DOWN,
        {"month": month},
        _DAY_DOWN,
        {"day": day},
        stop_if_month_missing=False,
    )
