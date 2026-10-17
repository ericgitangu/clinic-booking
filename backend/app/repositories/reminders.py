"""Reminder claims and the daily email counter."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

# One statement claims the due rows. A row is due when it is booked, has not been reminded, belongs
# to a patient with a linked, verified Google account, starts inside the window and in the future,
# and is not under a live lease. The email is the one that account was linked with: an address typed
# into the public API is never emailed. A link exists only for a verified email (the link route
# refuses anything else). FOR UPDATE SKIP LOCKED means two runs at the same moment get different
# rows, never the same one. The lease is the claim time: a claim older than the cutoff can be taken
# again.
_CLAIM = text(
    """
    WITH due AS (
      SELECT a.id
      FROM appointments a
      JOIN patient_accounts pa ON pa.patient_id = a.patient_id
      WHERE a.status = 'booked'
        AND a.reminder_sent_at IS NULL
        AND (a.reminder_claimed_at IS NULL OR a.reminder_claimed_at < :lease_cutoff)
        AND a.starts_at >= :day_start AND a.starts_at < :day_end
        AND a.starts_at > :now
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
           CAST(:now AS timestamptz) AS claimed_at
    FROM claimed c
    JOIN doctors d ON d.id = c.doctor_id
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

_COUNT_UP = text(
    """
    INSERT INTO email_counter (day, sent) VALUES (:day, 1)
    ON CONFLICT (day) DO UPDATE SET sent = email_counter.sent + 1
    RETURNING sent
    """
)


async def claim(
    session: AsyncSession,
    *,
    now: datetime,
    lease_cutoff: datetime,
    day_start: datetime,
    day_end: datetime,
    limit: int,
) -> list[dict[str, Any]]:
    rows = await session.execute(
        _CLAIM,
        {
            "now": now,
            "lease_cutoff": lease_cutoff,
            "day_start": day_start,
            "day_end": day_end,
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


async def count_one(session: AsyncSession, day: date) -> int:
    return int((await session.execute(_COUNT_UP, {"day": day})).scalar_one())
