"""Admin dashboard queries: range handling, cursors and the per-doctor join.

Dates are clinic-local (``clinics.timezone``); ``from`` is inclusive and ``to`` exclusive.
"""

from __future__ import annotations

import base64
import binascii
import json
import uuid
from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import Clock
from app.domain.errors import AppointmentNotFound, DomainError
from app.repositories import admin as repo
from app.schemas.admin import (
    AdminAppointment,
    AdminAppointmentPage,
    Bucket,
    DateRange,
    DoctorLoad,
    Lineage,
    LineageEvent,
    Metrics,
    SeriesPoint,
    Totals,
)

MAX_DAYS = {"day": 90, "hour": 7}
DEFAULT_LIMIT = 25
MAX_LIMIT = 100


class InvalidAdminQuery(DomainError):
    code = "VALIDATION_ERROR"


def _in_zone(value: datetime | None, zone: str) -> datetime | None:
    return value.astimezone(ZoneInfo(zone)) if value is not None else None


FULL_VIEW_ROLES = frozenset({"owner", "admin"})


def initials(full_name: str) -> str:
    """ "Jane Mary Doe" -> "J. M. D." (letters and digits only; at most three)."""
    letters = [w[0].upper() for w in full_name.split() if w and w[0].isalnum()]
    return " ".join(f"{c}." for c in letters[:3]) or "?"


def mask_phone(phone: str | None) -> str | None:
    """Only the last two digits are shown: +254712345678 -> +***********78. A number too short
    to hide anything behind two digits is masked entirely."""
    if phone is None:
        return None
    lead = "+" if phone.startswith("+") else ""
    digits = phone[len(lead) :]
    if len(digits) < 7:
        return lead + "*" * len(digits)
    return lead + "*" * (len(digits) - 2) + digits[-2:]


def project_for_viewer(item: AdminAppointment) -> AdminAppointment:
    return item.model_copy(
        update={
            "patient_name": initials(item.patient_name),
            "patient_phone": mask_phone(item.patient_phone),
            "patient_email": None,
            "cancellation_reason": None,
        }
    )


def encode_cursor(starts_at: datetime, appointment_id: uuid.UUID) -> str:
    body = {"s": starts_at.astimezone(UTC).isoformat(), "i": str(appointment_id)}
    raw = json.dumps(body, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    bad = InvalidAdminQuery("cursor is not a cursor issued by this endpoint")
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
        body = json.loads(raw)
        if not isinstance(body, dict) or set(body) != {"s", "i"}:
            raise bad
        s, i = body["s"], body["i"]
        if not isinstance(s, str) or not isinstance(i, str):
            raise bad
        starts_at = datetime.fromisoformat(s)
        if starts_at.tzinfo is None:
            raise bad
        return starts_at.astimezone(UTC), uuid.UUID(i)
    except (binascii.Error, ValueError, UnicodeDecodeError) as exc:
        # json.JSONDecodeError and UnicodeDecodeError are ValueError subclasses.
        raise bad from exc


async def metrics(
    session: AsyncSession, clock: Clock, *, start: date, end: date, bucket: Bucket
) -> Metrics:
    if end <= start:
        raise InvalidAdminQuery("'to' must be after 'from'")
    if (end - start).days > MAX_DAYS[bucket]:
        raise InvalidAdminQuery(f"bucket={bucket} allows at most {MAX_DAYS[bucket]} days")

    rows = await repo.series(session, bucket=bucket, from_day=start, to_day=end)
    series = [SeriesPoint(**{**r, "bucket_start": r["bucket_start"].isoformat()}) for r in rows]
    upcoming = await repo.upcoming_active(session, now=clock.now())

    doctors = await repo.doctors(session)
    visits = await repo.visits_by_doctor(session, from_day=start, to_day=end)
    cancels = await repo.cancel_actions_by_doctor(session, from_day=start, to_day=end)
    capacity = await repo.capacity_by_doctor(session, from_date=start, to_date=end)

    per_doctor: list[DoctorLoad] = []
    for d in doctors:
        did = d["doctor_id"]
        # A deactivated doctor stays listed while they still have activity in the range.
        if not d["is_active"] and not (visits.get(did) or cancels.get(did)):
            continue
        cap = capacity.get(did, 0)
        booked_visits = visits.get(did, 0)
        per_doctor.append(
            DoctorLoad(
                doctor_id=did,
                name=d["name"],
                booked_visits=booked_visits,
                cancelled_actions=cancels.get(did, 0),
                capacity=cap,
                utilization=round(booked_visits / cap, 4) if cap > 0 else None,
            )
        )

    return Metrics(
        range=DateRange(from_=start, to=end),
        bucket=bucket,
        series=series,
        totals=Totals(
            booked=sum(p.booked for p in series),
            rescheduled=sum(p.rescheduled for p in series),
            cancelled=sum(p.cancelled for p in series),
            upcoming_active=upcoming,
        ),
        per_doctor=per_doctor,
    )


async def appointments(
    session: AsyncSession,
    *,
    status: str,
    doctor_id: uuid.UUID | None,
    start: date | None,
    end: date | None,
    limit: int,
    cursor: str | None,
    role: str,
) -> AdminAppointmentPage:
    if start is not None and end is not None and end <= start:
        raise InvalidAdminQuery("'to' must be after 'from'")
    after = decode_cursor(cursor) if cursor else None

    rows = await repo.appointments_page(
        session,
        status=status,
        doctor_id=doctor_id,
        from_day=start,
        to_day=end,
        after=after,
        limit=limit,
    )
    page, has_more = rows[:limit], len(rows) > limit
    items = [AdminAppointment.model_validate(r) for r in page]
    # The projection is decided here, from the role the database confirmed: only owner and admin
    # ever receive a full name, an unmasked phone, an email or a reason.
    minimised = role not in FULL_VIEW_ROLES
    if minimised:
        items = [project_for_viewer(i) for i in items]
    next_cursor = encode_cursor(page[-1]["starts_at"], page[-1]["id"]) if has_more else None
    return AdminAppointmentPage(
        view="minimised" if minimised else "full", items=items, next_cursor=next_cursor
    )


async def lineage(session: AsyncSession, appointment_id: uuid.UUID) -> Lineage:
    if not await repo.appointment_exists(session, appointment_id):
        raise AppointmentNotFound()
    rows = await repo.lineage(session, appointment_id)
    # Each event is rendered in the zone of its doctor's clinic (the query joined it in).
    events = [
        LineageEvent(
            id=r["id"],
            event_type=r["event_type"],
            from_starts_at=_in_zone(r["from_starts_at"], r["timezone"]),
            to_starts_at=_in_zone(r["to_starts_at"], r["timezone"]),
            occurred_at=r["occurred_at"].astimezone(ZoneInfo(r["timezone"])),
            actor=r["actor"],
        )
        for r in rows
    ]
    return Lineage(appointment_id=appointment_id, events=events)
