from __future__ import annotations

import uuid

from pydantic import BaseModel, ConfigDict


class Clinic(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    timezone: str


class WorkingWindow(BaseModel):
    weekday: int  # ISO 1=Mon..7=Sun
    start_time: str  # "HH:MM"
    end_time: str  # "HH:MM"


class Doctor(BaseModel):
    id: uuid.UUID
    full_name: str
    specialty: str
    clinic: Clinic
    working_hours: list[WorkingWindow]


class DoctorList(BaseModel):
    items: list[Doctor]
