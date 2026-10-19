"""Audit rows and the send/no-send decision for "remind now" and "doctor running late".

The email itself is sent by the web app. This service decides who may be emailed, writes one audit
row per patient in the transaction, and hands back what the web app needs. A demo recipient (a
reserved example domain) is recorded as "demo, not sent", with ``notified`` left false, and the web
app is told not to send, so the email provider is never called for one.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.assertion import Principal
from app.core.clock import Clock
from app.domain.emailnorm import normalize_email
from app.domain.errors import (
    AppointmentAlreadyCancelled,
    AppointmentAlreadyStarted,
    AppointmentNotFound,
    DoctorNotFound,
)
from app.domain.notify import outcome_for
from app.repositories import appointments as appt_repo
from app.repositories import doctors as doctor_repo
from app.repositories import ops as ops_repo
from app.repositories import patients as patient_repo
from app.repositories import staff as staff_repo
from app.schemas.staff import NotifyItem, NotifyResult

MAX_RECIPIENTS = 50
# The audit actions that email the patient, and the outcomes that mean nothing was sent.
EMAILING_ACTIONS = frozenset(
    {"book", "reschedule", "cancel", "veto", "reminder_now", "running_late", "invite_create"}
)
NOT_SENT = frozenset({"demo, not sent", "no email on file"})


def _item(
    audit_id: uuid.UUID,
    appointment_id: uuid.UUID,
    starts_at: datetime,
    name: str,
    email: str | None,
    outcome: str,
) -> NotifyItem:
    deliver = outcome == "to send"
    return NotifyItem(
        audit_id=audit_id,
        appointment_id=appointment_id,
        starts_at=starts_at,
        patient_name=name,
        email=email if deliver else None,
        deliver=deliver,
        outcome=outcome,
    )


async def remind_now(
    session: AsyncSession,
    clock: Clock,
    *,
    actor: Principal,
    appointment_id: uuid.UUID,
    reason: str | None,
) -> NotifyResult:
    now = clock.now()
    appt = await appt_repo.get_appointment(session, appointment_id)
    if appt is None:
        raise AppointmentNotFound()
    patient = await patient_repo.get_patient(session, appt.patient_id)
    doctor = await doctor_repo.get_doctor(session, appt.doctor_id)
    if patient is None or doctor is None or patient.synthetic:
        raise AppointmentNotFound()
    if appt.status == "cancelled":
        raise AppointmentAlreadyCancelled()
    if appt.starts_at <= now:
        raise AppointmentAlreadyStarted()
    snapshot = (appt.id, appt.starts_at, patient.full_name, patient.email, doctor.full_name)
    await session.rollback()
    appt_id, starts_at, name, email, doctor_name = snapshot
    outcome = outcome_for(email)
    async with session.begin():
        audit_id = await staff_repo.insert_audit(
            session,
            actor_email=normalize_email(actor.email),
            actor_role=actor.role,
            action="reminder_now",
            appointment_id=appt_id,
            reason=(reason or "").strip() or "Reminder sent now at staff request",
            before={},
            after={"outcome": outcome},
        )
    return NotifyResult(
        doctor_name=doctor_name,
        items=[_item(audit_id, appt_id, starts_at, name, email, outcome)],
    )


async def running_late(
    session: AsyncSession,
    clock: Clock,
    *,
    actor: Principal,
    doctor_id: uuid.UUID,
    minutes: int,
    reason: str | None,
) -> NotifyResult:
    """Tell the doctor's remaining patients of today, one audit row each."""
    now = clock.now()
    doctor = await doctor_repo.get_active_doctor(session, doctor_id)
    if doctor is None:
        raise DoctorNotFound()
    clinic = await doctor_repo.get_clinic(session, doctor.clinic_id)
    if clinic is None:  # pragma: no cover - foreign key
        raise DoctorNotFound()
    tz = ZoneInfo(clinic.timezone)
    day_end = datetime.combine(
        now.astimezone(tz).date() + timedelta(days=1), time.min, tzinfo=tz
    ).astimezone(UTC)
    doctor_name = doctor.full_name
    rows = await ops_repo.remaining_for_doctor(
        session, doctor_id=doctor_id, now=now, day_end=day_end, limit=MAX_RECIPIENTS
    )
    await session.rollback()
    text = (reason or "").strip() or f"Doctor running about {minutes} minutes late"
    items: list[NotifyItem] = []
    async with session.begin():
        for r in rows:
            outcome = outcome_for(r["email"])
            audit_id = await staff_repo.insert_audit(
                session,
                actor_email=normalize_email(actor.email),
                actor_role=actor.role,
                action="running_late",
                appointment_id=r["id"],
                reason=text,
                before={},
                after={"outcome": outcome, "delay_minutes": minutes},
            )
            items.append(
                _item(audit_id, r["id"], r["starts_at"], r["full_name"], r["email"], outcome)
            )
    return NotifyResult(doctor_name=doctor_name, items=items)
