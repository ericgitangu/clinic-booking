from __future__ import annotations

import uuid
from datetime import date

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_clock, get_session, get_settings
from app.core.clock import Clock
from app.core.config import Settings
from app.domain.errors import DoctorNotFound
from app.domain.slots import DEFAULT_SLOT_MINUTES, slot_length
from app.models.doctor import Doctor as DoctorModel
from app.models.working_hours import WorkingHours
from app.repositories import doctors as doctor_repo
from app.schemas.availability import Availability
from app.schemas.doctor import Clinic, Doctor, DoctorList, WorkingWindow
from app.schemas.problem import problem_responses
from app.services.availability import get_availability

router = APIRouter(tags=["doctors"])

_NO_STORE = {"Cache-Control": "no-store"}


def _window(wh: WorkingHours) -> WorkingWindow:
    return WorkingWindow(
        weekday=wh.weekday,
        start_time=wh.start_time.strftime("%H:%M"),
        end_time=wh.end_time.strftime("%H:%M"),
    )


async def _to_schema(
    session: AsyncSession, doctor: DoctorModel, windows: list[WorkingHours]
) -> Doctor:
    clinic = await doctor_repo.get_clinic(session, doctor.clinic_id)
    assert clinic is not None  # noqa: S101  # FK guarantees the clinic exists
    return Doctor(
        id=doctor.id,
        full_name=doctor.full_name,
        specialty=doctor.specialty,
        clinic=Clinic.model_validate(clinic),
        working_hours=[_window(w) for w in windows],
    )


@router.get("/doctors", response_model=DoctorList)
async def list_doctors(
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> DoctorList:
    response.headers.update(_NO_STORE)
    doctors = await doctor_repo.list_active_doctors(session)
    all_wh = await doctor_repo.all_working_hours_active(session)
    by_doctor: dict[uuid.UUID, list[WorkingHours]] = {}
    for wh in all_wh:
        by_doctor.setdefault(wh.doctor_id, []).append(wh)
    items = [await _to_schema(session, d, by_doctor.get(d.id, [])) for d in doctors]
    return DoctorList(items=items)


@router.get("/doctors/{doctor_id}", response_model=Doctor, responses=problem_responses(404, 422))
async def get_doctor(
    doctor_id: uuid.UUID,
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> Doctor:
    response.headers.update(_NO_STORE)
    doctor = await doctor_repo.get_active_doctor(session, doctor_id)
    if doctor is None:
        raise DoctorNotFound()
    windows = await doctor_repo.working_hours_for(session, doctor_id)
    return await _to_schema(session, doctor, windows)


@router.get(
    "/doctors/{doctor_id}/availability",
    response_model=Availability,
    responses=problem_responses(404, 422),
)
async def doctor_availability(
    doctor_id: uuid.UUID,
    response: Response,
    date: date = Query(...),  # noqa: A002  # matches the ?date= query param name
    slot_minutes: int = Query(
        DEFAULT_SLOT_MINUTES,
        description="Slot length in minutes: 5 to 1440 and a divisor of 1440. Defaults to 30.",
    ),
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    settings: Settings = Depends(get_settings),
) -> Availability:
    response.headers.update(_NO_STORE)
    slot = slot_length(slot_minutes)
    return await get_availability(session, clock, settings, doctor_id, date, slot)
