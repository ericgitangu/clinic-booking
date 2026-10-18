from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.events import CURSOR_PATTERN


class Slot(BaseModel):
    starts_at: datetime
    ends_at: datetime


class Availability(BaseModel):
    doctor_id: uuid.UUID
    date: str  # "YYYY-MM-DD"
    timezone: str
    slot_minutes: Literal[30] = 30
    cursor: str = Field(
        pattern=CURSOR_PATTERN,
        description=(
            '"<txid>.<id>" read before the slots, in the same moment: every pushed event at or '
            "before it is already reflected in `slots`. Accept a newer response only if its "
            "cursor is not older than the one you hold."
        ),
    )
    slots: list[Slot]
    taken: list[datetime] = Field(
        description=(
            "Starts of this day's grid that are booked (clinic-local offset, like `slots`): the "
            "times the doctor works that overlap a booking. Starts only; nothing says who holds "
            "them. A time is in `slots` or in `taken`, never both."
        )
    )
