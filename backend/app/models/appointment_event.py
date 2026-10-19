from __future__ import annotations

import datetime as _dt
import uuid

from sqlalchemy import BigInteger, Date, DateTime, ForeignKey, String, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class AppointmentEvent(Base):
    __tablename__ = "appointment_events"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    appointment_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("appointments.id"), nullable=False
    )
    doctor_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("doctors.id"), nullable=False
    )
    event_type: Mapped[str] = mapped_column(String, nullable=False)
    from_starts_at: Mapped[_dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    to_starts_at: Mapped[_dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    local_date: Mapped[_dt.date] = mapped_column(Date, nullable=False)
    from_local_date: Mapped[_dt.date | None] = mapped_column(Date, nullable=True)
    occurred_at: Mapped[_dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    # 'patient' or 'staff'; NULL on rows written before the column existed.
    actor: Mapped[str | None] = mapped_column(String, nullable=True)
