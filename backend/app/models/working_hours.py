from __future__ import annotations

import datetime as _dt
import uuid

from sqlalchemy import ForeignKey, SmallInteger, Time, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class WorkingHours(Base):
    __tablename__ = "working_hours"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    doctor_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("doctors.id"), nullable=False
    )
    weekday: Mapped[int] = mapped_column(SmallInteger, nullable=False)  # ISO 1=Mon..7=Sun
    start_time: Mapped[_dt.time] = mapped_column(Time, nullable=False)
    end_time: Mapped[_dt.time] = mapped_column(Time, nullable=False)
