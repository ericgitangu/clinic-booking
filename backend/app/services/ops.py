"""The operations dashboard's read model: today's board, KPIs, reasons, heatmap, free slots.

Every figure is computed from the database on request; nothing is stored or faked.
"""

from __future__ import annotations

import csv
import io
import re
import uuid
from collections import defaultdict
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import Clock
from app.domain.errors import DomainError
from app.domain.ops import board_status, coalesce_gaps, running_behind
from app.domain.reasons import CATEGORIES, Category, classify_reason
from app.domain.slots import SLOT, generate_slots
from app.domain.staff import is_vetoable
from app.repositories import admin as admin_repo
from app.repositories import doctors as doctor_repo
from app.repositories import ops as repo
from app.schemas.admin import DateRange
from app.schemas.ops import (
    BoardAppointment,
    BoardGap,
    BoardTotals,
    ChangeItem,
    ChangeKind,
    ChangeList,
    DoctorBoard,
    FreeSlot,
    GapList,
    HeatCell,
    Heatmap,
    KpiCounts,
    Kpis,
    KpiValue,
    ReasonBreakdown,
    ReasonShare,
    RunningBehind,
    TodayBoard,
)
from app.services.admin import (
    FULL_VIEW_ROLES,
    decode_changes_cursor,
    encode_changes_cursor,
    initials,
    mask_phone,
)

MAX_RANGE_DAYS = 92
MAX_GAP_HOURS = 96
MAX_GAP_ITEMS = 200


class InvalidOpsQuery(DomainError):
    code = "VALIDATION_ERROR"


def _check_range(start: date, end: date) -> None:
    if end <= start:
        raise InvalidOpsQuery("'to' must be after 'from'")
    if (end - start).days > MAX_RANGE_DAYS:
        raise InvalidOpsQuery(f"the range may be at most {MAX_RANGE_DAYS} days")


def _day_bounds(day: date, tz: ZoneInfo) -> tuple[datetime, datetime]:
    lo = datetime.combine(day, time.min, tzinfo=tz).astimezone(UTC)
    hi = datetime.combine(day + timedelta(days=1), time.min, tzinfo=tz).astimezone(UTC)
    return lo, hi


WorkingRow = tuple[uuid.UUID, int, time, time]


async def _working(session: AsyncSession) -> list[WorkingRow]:
    """Plain tuples, so they stay usable after the read transaction is ended."""
    rows = await doctor_repo.all_working_hours_active(session)
    return [(w.doctor_id, w.weekday, w.start_time, w.end_time) for w in rows]


def _windows(
    working: list[WorkingRow], doctor_id: uuid.UUID, weekday: int
) -> list[tuple[time, time]]:
    return [(start, end) for did, wd, start, end in working if did == doctor_id and wd == weekday]


async def today_board(
    session: AsyncSession, clock: Clock, *, on_date: date | None, role: str
) -> TodayBoard:
    now = clock.now()
    docs = await repo.doctors(session)
    working = await _working(session)
    days = {d["id"]: on_date or now.astimezone(ZoneInfo(d["timezone"])).date() for d in docs}
    bounds = {d["id"]: _day_bounds(days[d["id"]], ZoneInfo(d["timezone"])) for d in docs}
    if not docs:
        await session.rollback()
        return TodayBoard(
            view="full" if role in FULL_VIEW_ROLES else "minimised",
            doctors=[],
            totals=BoardTotals(booked=0, arrived=0, no_show=0, cancelled=0),
        )
    lo = min(b[0] for b in bounds.values())
    hi = max(b[1] for b in bounds.values())
    appts = await repo.board_appointments(session, lo=lo, hi=hi)
    occupied = await repo.occupied(session, lo=lo, hi=hi)
    await session.rollback()

    full = role in FULL_VIEW_ROLES
    by_doctor: dict[uuid.UUID, list[dict[str, Any]]] = defaultdict(list)
    for a in appts:
        by_doctor[a["doctor_id"]].append(a)
    busy: dict[uuid.UUID, list[tuple[datetime, datetime]]] = defaultdict(list)
    for o in occupied:
        busy[o["doctor_id"]].append((o["starts_at"], o["ends_at"]))

    boards: list[DoctorBoard] = []
    counts = {"booked": 0, "arrived": 0, "no_show": 0, "cancelled": 0}
    for d in docs:
        did, tz = d["id"], ZoneInfo(d["timezone"])
        day = days[did]
        d_lo, d_hi = bounds[did]
        items: list[BoardAppointment] = []
        unresolved: list[tuple[object, datetime]] = []
        for a in by_doctor.get(did, []):
            if not d_lo <= a["starts_at"] < d_hi:
                continue
            status = board_status(a["status"], a["attendance"])
            counts[status] += 1
            if status == "booked":
                unresolved.append((a["id"], a["starts_at"]))
            items.append(
                BoardAppointment(
                    timezone=d["timezone"],
                    id=a["id"],
                    starts_at=a["starts_at"],
                    ends_at=a["ends_at"],
                    status=status,
                    patient_name=a["full_name"] if full else initials(a["full_name"]),
                    patient_phone=a["phone"] if full else mask_phone(a["phone"]),
                    locked=a["locked"],
                    patient_changed=is_vetoable(
                        a["latest_event_type"], a["latest_actor"], a["has_successor"]
                    ),
                )
            )
        free = generate_slots(
            _windows(working, did, day.isoweekday()), busy.get(did, []), tz, day, now, timedelta(0)
        )
        gaps = coalesce_gaps([(s.starts_at, s.ends_at) for s in free])
        is_today = day == now.astimezone(tz).date()
        behind = running_behind(unresolved, now) if is_today else running_behind([], now)
        boards.append(
            DoctorBoard(
                doctor_id=did,
                name=d["full_name"],
                specialty=d["specialty"],
                timezone=d["timezone"],
                date=day,
                appointments=items,
                next_gap=BoardGap(
                    timezone=d["timezone"],
                    starts_at=gaps[0].starts_at,
                    ends_at=gaps[0].ends_at,
                    slots=gaps[0].slots,
                )
                if gaps
                else None,
                free_slots=len(free),
                running_behind=RunningBehind(
                    behind=behind.behind,
                    minutes=behind.minutes,
                    appointment_id=behind.appointment_id,
                ),
            )
        )
    return TodayBoard(
        view="full" if full else "minimised",
        doctors=boards,
        totals=BoardTotals(**counts),
    )


def _ratio(num: int, den: int) -> float | None:
    return round(num / den, 4) if den > 0 else None


def _value(current: float | None, previous: float | None) -> KpiValue:
    delta = round(current - previous, 4) if current is not None and previous is not None else None
    return KpiValue(value=current, previous=previous, delta=delta)


async def _period(session: AsyncSession, start: date, end: date) -> dict[str, Any]:
    cohort = await repo.cohort(session, from_day=start, to_day=end)
    capacity = await admin_repo.capacity_by_doctor(session, from_date=start, to_date=end)
    resched = await repo.reschedules(session, from_day=start, to_day=end)
    offered = sum(capacity.values())
    booked, cancelled = int(cohort["booked"]), int(cohort["cancelled"])
    arrived, no_show = int(cohort["arrived"]), int(cohort["no_show"])
    median = cohort["median_lead_minutes"]
    return {
        "counts": KpiCounts(
            offered=offered, booked=booked, cancelled=cancelled, arrived=arrived, no_show=no_show
        ),
        "utilisation": _ratio(arrived, offered),
        "fill_rate": _ratio(booked, offered),
        "cancellation_rate": _ratio(cancelled, booked + cancelled),
        "no_show_rate": _ratio(no_show, arrived + no_show),
        "median_lead_minutes": round(float(median), 1) if median is not None else None,
        "reschedules": float(resched),
    }


async def kpis(session: AsyncSession, *, start: date, end: date) -> Kpis:
    _check_range(start, end)
    length = end - start
    prev_start = start - length
    current = await _period(session, start, end)
    previous = await _period(session, prev_start, start)
    await session.rollback()
    return Kpis(
        range=DateRange(from_=start, to=end),
        previous_range=DateRange(from_=prev_start, to=start),
        utilisation=_value(current["utilisation"], previous["utilisation"]),
        fill_rate=_value(current["fill_rate"], previous["fill_rate"]),
        cancellation_rate=_value(current["cancellation_rate"], previous["cancellation_rate"]),
        no_show_rate=_value(current["no_show_rate"], previous["no_show_rate"]),
        median_lead_minutes=_value(current["median_lead_minutes"], previous["median_lead_minutes"]),
        reschedules=_value(current["reschedules"], previous["reschedules"]),
        counts=current["counts"],
    )


async def reasons(session: AsyncSession, *, start: date, end: date) -> ReasonBreakdown:
    _check_range(start, end)
    texts = await repo.cancellation_reasons(session, from_day=start, to_day=end)
    await session.rollback()
    tally = dict.fromkeys(CATEGORIES, 0)
    for t in texts:
        tally[classify_reason(t)] += 1
    total = len(texts)
    order = sorted(CATEGORIES, key=lambda c: (-tally[c], CATEGORIES.index(c)))
    return ReasonBreakdown(
        range=DateRange(from_=start, to=end),
        total=total,
        items=[
            ReasonShare(
                category=c, count=tally[c], share=round(tally[c] / total, 4) if total else 0.0
            )
            for c in order
        ],
    )


async def changes(
    session: AsyncSession,
    *,
    kind: ChangeKind,
    start: date,
    end: date,
    reason: Category | None,
    doctor_id: uuid.UUID | None,
    limit: int,
    cursor: str | None,
    role: str,
) -> ChangeList:
    """The events behind a number of the dashboard: every booking, reschedule or cancellation made
    in the clinic-local days [start, end), newest first. Same filters and joins as the metrics
    series, so ``total`` is that series' count and, for cancellations, the reasons chart's."""
    _check_range(start, end)
    if reason is not None and kind != "cancelled":
        raise InvalidOpsQuery("'reason' applies only to kind=cancelled")
    after = decode_changes_cursor(cursor) if cursor else None
    ids: list[int] | None = None
    if reason is not None:
        texts = await repo.change_reason_texts(
            session, from_day=start, to_day=end, doctor_id=doctor_id
        )
        ids = [i for i, t in texts if classify_reason(t) == reason]
    total = await repo.changes_count(
        session, kind=kind, from_day=start, to_day=end, doctor_id=doctor_id, ids=ids
    )
    rows = await repo.changes_page(
        session,
        kind=kind,
        from_day=start,
        to_day=end,
        doctor_id=doctor_id,
        ids=ids,
        after=after,
        limit=limit + 1,
    )
    await session.rollback()
    page, has_more = rows[:limit], len(rows) > limit
    full = role in FULL_VIEW_ROLES
    items = [
        ChangeItem(
            timezone=r["timezone"],
            appointment_id=r["appointment_id"],
            doctor_id=r["doctor_id"],
            doctor_name=r["doctor_name"],
            patient_name=r["patient_name"] if full else initials(r["patient_name"]),
            kind=r["kind"],
            occurred_at=r["occurred_at"],
            actor=r["actor"],
            from_starts_at=r["from_starts_at"] if kind == "rescheduled" else None,
            to_starts_at=r["to_starts_at"] if kind == "rescheduled" else None,
            starts_at=r["starts_at"],
            status=r["status"],
            attendance=r["attendance"],
            reason=r["cancellation_reason"] if full and kind == "cancelled" else None,
            reason_category=classify_reason(r["cancellation_reason"])
            if kind == "cancelled"
            else None,
        )
        for r in page
    ]
    return ChangeList(
        view="full" if full else "minimised",
        kind=kind,
        range=DateRange(from_=start, to=end),
        total=total,
        items=items,
        next_cursor=encode_changes_cursor(page[-1]["occurred_at"], page[-1]["id"])
        if has_more
        else None,
    )


async def heatmap(
    session: AsyncSession, *, start: date, end: date, doctor_id: uuid.UUID | None
) -> Heatmap:
    _check_range(start, end)
    rows = await repo.heatmap(session, from_day=start, to_day=end, doctor_id=doctor_id)
    await session.rollback()
    cells = [HeatCell(weekday=r["weekday"], hour=r["hour"], count=int(r["n"])) for r in rows]
    return Heatmap(
        range=DateRange(from_=start, to=end),
        doctor_id=doctor_id,
        max=max((c.count for c in cells), default=0),
        cells=cells,
    )


async def gaps(session: AsyncSession, clock: Clock, *, hours: int) -> GapList:
    """Free 30-minute slots starting between now and now + ``hours``, all doctors, soonest first.
    Staff may book inside the lead-time window, so a slot starting in ten minutes is listed."""
    now = clock.now()
    until = now + timedelta(hours=hours)
    docs = await repo.doctors(session)
    working = await _working(session)
    occupied = await repo.occupied(session, lo=now - SLOT, hi=until)
    await session.rollback()
    busy: dict[uuid.UUID, list[tuple[datetime, datetime]]] = defaultdict(list)
    for o in occupied:
        busy[o["doctor_id"]].append((o["starts_at"], o["ends_at"]))
    found: list[FreeSlot] = []
    for d in docs:
        tz = ZoneInfo(d["timezone"])
        day = now.astimezone(tz).date()
        last = until.astimezone(tz).date()
        while day <= last:
            for s in generate_slots(
                _windows(working, d["id"], day.isoweekday()),
                busy.get(d["id"], []),
                tz,
                day,
                now,
                timedelta(0),
            ):
                if s.starts_at < until:
                    found.append(
                        FreeSlot(
                            timezone=d["timezone"],
                            doctor_id=d["id"],
                            doctor_name=d["full_name"],
                            starts_at=s.starts_at,
                            ends_at=s.ends_at,
                        )
                    )
            day += timedelta(days=1)
    found.sort(key=lambda f: (f.starts_at, f.doctor_name))
    return GapList(hours=hours, items=found[:MAX_GAP_ITEMS], truncated=len(found) > MAX_GAP_ITEMS)


_PHONE = re.compile(r"\+[0-9*]+")
_CSV_DANGER = ("=", "+", "-", "@", "\t", "\r")


def _cell(value: object) -> str:
    """A CSV cell that a spreadsheet will not run as a formula."""
    text = "" if value is None else str(value)
    if _PHONE.fullmatch(text):
        return text  # +254712345678, or its masked form: digits only, nothing a sheet would run
    return "'" + text if text.startswith(_CSV_DANGER) else text


async def day_sheet_csv(
    session: AsyncSession, *, day: date, doctor_id: uuid.UUID | None, role: str
) -> str:
    """One row per appointment of the clinic-local day. Owner and admin get full names, phones,
    emails and cancellation reasons; a viewer gets initials, a masked phone, no email or reason."""
    rows = await repo.day_sheet(
        session, day=day, next_day=day + timedelta(days=1), doctor_id=doctor_id
    )
    await session.rollback()
    full = role in FULL_VIEW_ROLES
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\r\n")
    writer.writerow(
        ["doctor", "time", "status", "patient", "phone", "email", "cancellation_reason"]
    )
    for r in rows:
        writer.writerow(
            [
                _cell(r["doctor_name"]),
                r["starts_at"].astimezone(ZoneInfo(r["timezone"])).strftime("%H:%M"),
                board_status(r["status"], r["attendance"]),
                _cell(r["full_name"] if full else initials(r["full_name"])),
                _cell(r["phone"] if full else mask_phone(r["phone"])),
                _cell(r["email"] if full else None),
                _cell(r["cancellation_reason"] if full else None),
            ]
        )
    return out.getvalue()
