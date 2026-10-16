from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel

from app.schemas.common import ClinicDatetime


class Slot(BaseModel):
    starts_at: ClinicDatetime
    ends_at: ClinicDatetime


class Availability(BaseModel):
    doctor_id: uuid.UUID
    date: str  # "YYYY-MM-DD"
    timezone: str
    slot_minutes: Literal[30] = 30
    slots: list[Slot]
