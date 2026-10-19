from __future__ import annotations

import datetime as _dt
import uuid

from sqlalchemy import BigInteger, DateTime, ForeignKey, String, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class AppointmentAttendance(Base):
    """Append-only: the latest row for an appointment is its attendance."""

    __tablename__ = "appointment_attendance"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    appointment_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("appointments.id"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String, nullable=False)
    marked_by: Mapped[str] = mapped_column(String, nullable=False)
    marked_at: Mapped[_dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
