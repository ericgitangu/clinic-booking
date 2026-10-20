"""``doctor_notification``: the record of telling a doctor that a patient arrived, and the
doctor's address (``doctors.email``)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

# The unique key (appointment, kind) makes a second mark, a double click and a retry write nothing
# new: the first row stays as it is.
_INSERT = text(
    """
    INSERT INTO doctor_notification
      (appointment_id, doctor_id, kind, status, reason, updated_at)
    VALUES (:appointment_id, :doctor_id, 'patient_arrived', :status, :reason, :now)
    ON CONFLICT (appointment_id, kind) DO NOTHING
    RETURNING id, status, reason
    """
)

_BY_APPOINTMENT = text(
    """
    SELECT id, appointment_id, doctor_id, status, reason, attempts, sent_at, last_error,
           leased_at, updated_at
    FROM doctor_notification
    WHERE appointment_id = :appointment_id AND kind = 'patient_arrived'
    """
)

_BY_ID = text("SELECT id, status FROM doctor_notification WHERE id = :id")

# A claim moves a row that is still to send (pending, or failed with attempts left) and not held by
# another sender to "held now", and counts the attempt. The facts the email needs come back with it.
_CLAIM = text(
    """
    WITH c AS (
      UPDATE doctor_notification n
      SET leased_at = :now, attempts = n.attempts + 1, updated_at = :now
      WHERE n.id = :id
        AND n.status IN ('pending', 'failed')
        AND n.attempts < :max_attempts
        AND (n.leased_at IS NULL OR n.leased_at < :lease_cutoff)
      RETURNING n.id, n.appointment_id, n.doctor_id, n.attempts
    )
    SELECT c.id, c.appointment_id, c.attempts, d.email AS doctor_email, d.full_name AS doctor_name,
           p.full_name AS patient_name, a.starts_at, cl.timezone
    FROM c
    JOIN doctors d ON d.id = c.doctor_id
    JOIN appointments a ON a.id = c.appointment_id
    JOIN patients p ON p.id = a.patient_id
    JOIN clinics cl ON cl.id = d.clinic_id
    """
)

_SENT = text(
    """
    UPDATE doctor_notification
    SET status = 'sent', sent_at = :now, provider_id = :provider_id, leased_at = NULL,
        last_error = NULL, updated_at = :now
    WHERE id = :id AND status IN ('pending', 'failed') AND leased_at IS NOT NULL
      AND attempts = :attempt
    RETURNING id
    """
)

_FAILED = text(
    """
    UPDATE doctor_notification
    SET status = 'failed', last_error = :error, leased_at = NULL, updated_at = :now
    WHERE id = :id AND status IN ('pending', 'failed') AND leased_at IS NOT NULL
      AND attempts = :attempt
    RETURNING id
    """
)

_SKIPPED = text(
    """
    UPDATE doctor_notification
    SET status = 'skipped', reason = :reason, leased_at = NULL, updated_at = :now
    WHERE id = :id AND status IN ('pending', 'failed') AND leased_at IS NOT NULL
      AND attempts = :attempt
    RETURNING id
    """
)

_DOCTOR_FOR_UPDATE = text("SELECT id, email FROM doctors WHERE id = :id FOR UPDATE")
_SET_EMAIL = text("UPDATE doctors SET email = :email WHERE id = :id")
_DOCTOR_EMAIL = text("SELECT email FROM doctors WHERE id = :id")


async def insert_for_arrival(
    session: AsyncSession,
    *,
    appointment_id: uuid.UUID,
    doctor_id: uuid.UUID,
    status: str,
    reason: str | None,
    now: datetime,
) -> dict[str, Any] | None:
    """The new row, or None when this appointment already has one."""
    row = (
        (
            await session.execute(
                _INSERT,
                {
                    "appointment_id": appointment_id,
                    "doctor_id": doctor_id,
                    "status": status,
                    "reason": reason,
                    "now": now,
                },
            )
        )
        .mappings()
        .first()
    )
    return dict(row) if row else None


async def for_appointment(
    session: AsyncSession, appointment_id: uuid.UUID
) -> dict[str, Any] | None:
    row = (
        (await session.execute(_BY_APPOINTMENT, {"appointment_id": appointment_id}))
        .mappings()
        .first()
    )
    return dict(row) if row else None


async def by_id(session: AsyncSession, notification_id: uuid.UUID) -> dict[str, Any] | None:
    row = (await session.execute(_BY_ID, {"id": notification_id})).mappings().first()
    return dict(row) if row else None


async def doctor_email(session: AsyncSession, doctor_id: uuid.UUID) -> str | None:
    value = (await session.execute(_DOCTOR_EMAIL, {"id": doctor_id})).scalar_one_or_none()
    return str(value) if value else None


async def claim(
    session: AsyncSession,
    notification_id: uuid.UUID,
    *,
    now: datetime,
    lease_cutoff: datetime,
    max_attempts: int,
) -> dict[str, Any] | None:
    row = (
        (
            await session.execute(
                _CLAIM,
                {
                    "id": notification_id,
                    "now": now,
                    "lease_cutoff": lease_cutoff,
                    "max_attempts": max_attempts,
                },
            )
        )
        .mappings()
        .first()
    )
    return dict(row) if row else None


async def finish_sent(
    session: AsyncSession,
    notification_id: uuid.UUID,
    *,
    attempt: int,
    provider_id: str | None,
    now: datetime,
) -> bool:
    res = await session.execute(
        _SENT, {"id": notification_id, "attempt": attempt, "provider_id": provider_id, "now": now}
    )
    return res.first() is not None


async def finish_failed(
    session: AsyncSession, notification_id: uuid.UUID, *, attempt: int, error: str, now: datetime
) -> bool:
    res = await session.execute(
        _FAILED, {"id": notification_id, "attempt": attempt, "error": error[:300], "now": now}
    )
    return res.first() is not None


async def finish_skipped(
    session: AsyncSession, notification_id: uuid.UUID, *, attempt: int, reason: str, now: datetime
) -> bool:
    res = await session.execute(
        _SKIPPED, {"id": notification_id, "attempt": attempt, "reason": reason, "now": now}
    )
    return res.first() is not None


async def lock_doctor(session: AsyncSession, doctor_id: uuid.UUID) -> dict[str, Any] | None:
    row = (await session.execute(_DOCTOR_FOR_UPDATE, {"id": doctor_id})).mappings().first()
    return dict(row) if row else None


async def set_email(session: AsyncSession, doctor_id: uuid.UUID, email: str | None) -> None:
    await session.execute(_SET_EMAIL, {"id": doctor_id, "email": email})
