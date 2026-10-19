"""The operations dashboard's read endpoints. Any staff role; what each role sees is decided here
and in the service, never by the web app. Nothing is cacheable."""

from __future__ import annotations

import uuid
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from fastapi.responses import PlainTextResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import ANY_STAFF, get_clock, get_session
from app.core.assertion import Principal
from app.core.clock import Clock
from app.domain.reasons import Category
from app.schemas.ops import (
    ChangeKind,
    ChangeList,
    GapList,
    Heatmap,
    Kpis,
    ReasonBreakdown,
    TodayBoard,
)
from app.schemas.problem import problem_responses
from app.services import ops

router = APIRouter(
    prefix="/internal/admin/ops",
    tags=["admin"],
    dependencies=[Depends(ANY_STAFF)],
    responses=problem_responses(401, 403),
)

_NO_STORE = {"Cache-Control": "no-store"}
FromDay = Annotated[date, Query(alias="from")]


@router.get(
    "/today",
    response_model=TodayBoard,
    responses=problem_responses(422),
    description=(
        "Each active doctor's day as a timeline with statuses booked, arrived, no_show and "
        "cancelled, the next free gap and a running-behind flag. `date` is a clinic-local day; "
        "without it, each doctor's clinic's today. Synthetic patients are left out. A viewer "
        "gets initials and a masked phone."
    ),
)
async def today(
    response: Response,
    on_date: Annotated[date | None, Query(alias="date")] = None,
    who: Principal = Depends(ANY_STAFF),
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
) -> TodayBoard:
    response.headers.update(_NO_STORE)
    return await ops.today_board(session, clock, on_date=on_date, role=who.role)


@router.get(
    "/kpis",
    response_model=Kpis,
    responses=problem_responses(422),
    description=(
        "Utilisation, fill rate, cancellation rate, no-show rate, median booking lead time and "
        "reschedules over the clinic-local days [from, to), each with the previous period of "
        "the same length and the difference. A rate is null when its denominator is zero."
    ),
)
async def kpis(
    response: Response,
    from_: FromDay,
    to: date,
    session: AsyncSession = Depends(get_session),
) -> Kpis:
    response.headers.update(_NO_STORE)
    return await ops.kpis(session, start=from_, end=to)


@router.get(
    "/cancellation-reasons",
    response_model=ReasonBreakdown,
    responses=problem_responses(422),
    description=(
        "Cancellations in [from, to) grouped by the reason text into transport, illness, travel, "
        "work, weather, felt_better, insurance and other. Counts only: no reason text."
    ),
)
async def cancellation_reasons(
    response: Response,
    from_: FromDay,
    to: date,
    session: AsyncSession = Depends(get_session),
) -> ReasonBreakdown:
    response.headers.update(_NO_STORE)
    return await ops.reasons(session, start=from_, end=to)


@router.get(
    "/changes",
    response_model=ChangeList,
    responses=problem_responses(422),
    description=(
        "The bookings, reschedules or cancellations (`kind`) made in the clinic-local days "
        "[from, to), by the day the change happened and not the day of the visit, newest first. "
        "`reason` (cancelled only) narrows to one cancellation-reason category, grouped as in "
        "`/cancellation-reasons`. `total` counts the whole range and filters, whatever `limit` "
        "(1 to 100, default 50) and `cursor` say. A viewer gets initials and no reason text."
    ),
)
async def changes(
    response: Response,
    kind: ChangeKind,
    from_: FromDay,
    to: date,
    reason: Category | None = None,
    doctor_id: uuid.UUID | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    cursor: str | None = None,
    who: Principal = Depends(ANY_STAFF),
    session: AsyncSession = Depends(get_session),
) -> ChangeList:
    response.headers.update(_NO_STORE)
    return await ops.changes(
        session,
        kind=kind,
        start=from_,
        end=to,
        reason=reason,
        doctor_id=doctor_id,
        limit=limit,
        cursor=cursor,
        role=who.role,
    )


@router.get(
    "/heatmap",
    response_model=Heatmap,
    responses=problem_responses(422),
    description=(
        "Booked appointments by weekday (1 = Monday) and local start hour over [from, to), for "
        "the clinic or one doctor."
    ),
)
async def heatmap(
    response: Response,
    from_: FromDay,
    to: date,
    doctor_id: uuid.UUID | None = None,
    session: AsyncSession = Depends(get_session),
) -> Heatmap:
    response.headers.update(_NO_STORE)
    return await ops.heatmap(session, start=from_, end=to, doctor_id=doctor_id)


@router.get(
    "/gaps",
    response_model=GapList,
    responses=problem_responses(422),
    description=(
        "Free 30-minute slots starting within the next `hours` (default 48), soonest first. "
        "Staff may book any of them, including inside the lead-time window."
    ),
)
async def gaps(
    response: Response,
    hours: Annotated[int, Query(ge=1, le=ops.MAX_GAP_HOURS)] = 48,
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
) -> GapList:
    response.headers.update(_NO_STORE)
    return await ops.gaps(session, clock, hours=hours)


@router.get(
    "/day-sheet.csv",
    response_class=PlainTextResponse,
    responses={
        200: {"content": {"text/csv": {}}, "description": "One row per appointment"},
        **problem_responses(422),
    },
    description=(
        "The day's appointments as CSV (one row each: doctor, time, status, patient, phone, "
        "email, cancellation reason, timezone: the IANA zone the time column is in), for `date` "
        "(clinic-local) and optionally one doctor. "
        "Owner and admin get full details; a viewer gets initials and a masked phone and no "
        "email or reason. Cells that would run as a spreadsheet formula are neutralised."
    ),
)
async def day_sheet(
    on_date: Annotated[date, Query(alias="date")],
    doctor_id: uuid.UUID | None = None,
    who: Principal = Depends(ANY_STAFF),
    session: AsyncSession = Depends(get_session),
) -> PlainTextResponse:
    body = await ops.day_sheet_csv(session, day=on_date, doctor_id=doctor_id, role=who.role)
    return PlainTextResponse(
        body,
        media_type="text/csv; charset=utf-8",
        headers={
            **_NO_STORE,
            "Content-Disposition": f'attachment; filename="day-sheet-{on_date.isoformat()}.csv"',
        },
    )
