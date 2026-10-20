from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Appointment(Base):
    __tablename__ = "appointments"
    __allow_unmapped__ = True

    # Not a column: the IANA zone of this appointment's doctor's clinic. The repository functions
    # set it from the same query that loads the row, and the booking service sets it on insert;
    # the response schema reads it. It is left unset on purpose, so a code path that forgot to
    # set it fails loudly instead of rendering in a guessed zone.
    timezone: str

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    doctor_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("doctors.id"), nullable=False
    )
    patient_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("patients.id"), nullable=False
    )
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False, server_default=text("'booked'"))
    cancellation_reason: Mapped[str | None] = mapped_column(String, nullable=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # the client's Idempotency-Key for the POST that created this row, and the sha256
    # of its canonical request. Both are NULL for a booking made without a key.
    idempotency_key: Mapped[str | None] = mapped_column(String, nullable=True)
    request_fingerprint: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    # A reminder is claimed with a lease (reminder_claimed_at) and counted as sent only after the
    # email provider accepted it (reminder_sent_at). Rescheduling clears both.
    reminder_claimed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    reminder_sent_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Set when staff veto a patient's change: from then on only staff can change the appointment
    # (a patient's cancel or reschedule is APPOINTMENT_LOCKED). A reschedule updates this same row,
    # so the lock follows it.
    staff_locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Set on the appointment staff book to undo a patient's cancel: the cancelled one it replaces.
    predecessor_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("appointments.id"), nullable=True
    )

    @property
    def locked(self) -> bool:
        """What the API schema reads: a patient may not change a locked appointment."""
        return self.staff_locked_at is not None
