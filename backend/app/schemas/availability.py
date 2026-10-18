from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class Slot(BaseModel):
    starts_at: datetime
    ends_at: datetime


class Availability(BaseModel):
    doctor_id: uuid.UUID
    date: str  # "YYYY-MM-DD"
    timezone: str
    slot_minutes: Literal[30] = 30
    slots: list[Slot]
