"""A curated demo clinic: invented Nairobi patients with two weeks of history and two weeks ahead.

    python -m app.scripts.seed_demo [--today YYYY-MM-DD]

Everything here is fictional and AI-generated (see ``demo_data``): 100 patients, @example.com
emails that can never receive mail, clearly fake phone numbers (+254700000xxx), and appointments
across the five seeded doctors from 14 days before ``today`` to 14 days after. It exists so the
admin dashboard can be reviewed with believable activity. It is NOT part of the release migrate
job; it is run by hand, once, after the core seed (``python -m app.scripts.seed``).

What it writes: patients (flagged ``demo``, visible everywhere, unlike ``synthetic``),
appointments and their ``appointment_events`` (booked, rescheduled, cancelled) with backdated
``occurred_at`` times, so the activity chart and KPIs tell a believable story.

Why it inserts directly instead of calling ``services.booking``: the service refuses past slots and
anything under the lead time, and stamps events with the database clock, so it cannot write
history. The rules are still applied: every booking and reschedule is checked with the pure domain
validator (``validate_slot``: grid, working hours, lead time, horizon) against the clock of the
moment it was supposedly made, the event rows are built by the domain functions the service uses
(``booked_event``, ``rescheduled_event``, ``cancelled_event``), a cancel is checked against the
one-hour rule, and the database's own constraints (partial unique indexes, CHECKs) still hold.

Staff-aware parts. A patient's own actions are events with ``actor = 'patient'``. A visit that
already happened is also marked at the desk, the way the app does it (``mark_attendance``): an
``appointment_attendance`` row, a ``staff_action_audit`` row and an ``arrived`` / ``no_show``
annotation event with ``actor = 'staff'``, marked inside the attendance window
(``domain.attendance.window_is_open``). The desk is the fictional ``reception@example.com``; that
address is not in ``staff_access``, so it is a label on the audit trail and grants nobody anything.

Idempotent and deterministic: ids are ``uuid5`` of stable keys, every random choice is a hash of
those keys, and ``ON CONFLICT DO NOTHING`` means a second run with the same ``--today`` inserts
nothing. Events are only written for appointments this run inserted. Nothing is ever deleted or
updated. The default ``today`` is the current Nairobi date (yesterday, before 07:00 there).

Events are all at least an hour older than "now", beyond the realtime relay's freshness window, so
the seed never causes a push to the live feed.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import sys
import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core.clock import SystemClock
from app.core.config import Settings
from app.db.session import dispose_engine, get_engine
from app.domain.attendance import Attendance, window_is_open
from app.domain.booking_rules import validate_slot
from app.domain.events import (
    EventFields,
    annotation_event,
    booked_event,
    cancelled_event,
    rescheduled_event,
)
from app.domain.slots import SLOT, grid_for_date
from app.scripts.demo_data import CANCEL_REASONS, PEOPLE, Person
from app.scripts.seed import CLINIC_TZ, DOCTORS, NAMESPACE, DoctorSeed

TZ = ZoneInfo(CLINIC_TZ)
LEAD = timedelta(minutes=60)  # BOOKING_MIN_LEAD_MINUTES
HORIZON_DAYS = 90  # BOOKING_HORIZON_DAYS
PAST_DAYS = 14
FUTURE_DAYS = 14
SEED_HOUR = time(7, 0)  # "now" of the seed on its day, clinic-local
EVENT_MARGIN = timedelta(hours=1)  # no event is newer than now minus this

# Share of a doctor's slots that hold a booked visit, per doctor (the admin utilisation).
FILL = {"otieno": 0.66, "kamau": 0.47, "rotich": 0.55, "mwangi": 0.52, "njeri": 0.62}
CANCEL_PER_BOOKED = 0.11  # cancelled rows per booked row: about 10% of all appointments
RESCHEDULED_SHARE = 0.09  # of booked rows

# Which patients each doctor sees (age bands), so a paediatrician sees children and a
# gynaecologist sees adult women.
SEES = {
    "otieno": {"teen", "adult", "senior"},
    "kamau": {"child", "teen"},
    "rotich": {"teen", "adult", "senior"},
    "mwangi": {"adult"},
    "njeri": {"child", "teen", "adult", "senior"},
}

LEAD_DAYS = (1, 1, 2, 2, 3, 3, 4, 5, 6, 7, 9, 12, 14, 18, 21)


def _hash(*parts: object) -> int:
    digest = hashlib.sha256("|".join(str(p) for p in parts).encode()).digest()
    return int.from_bytes(digest[:8], "big")


def _u(*parts: object) -> float:
    """A deterministic number in [0, 1) from stable keys."""
    return _hash(*parts) / 2**64


def _id(kind: str, key: str) -> uuid.UUID:
    return uuid.uuid5(NAMESPACE, f"demo:{kind}:{key}")


def patient_id(person: Person) -> uuid.UUID:
    return _id("patient", person.key)


def phone(index: int) -> str:
    """+254700000001 ...: the +254 700 000 0xx range, all fictional."""
    return f"+254700000{index + 1:03d}"


@dataclass(frozen=True)
class PlannedEvent:
    appointment_id: uuid.UUID
    doctor_id: uuid.UUID
    event_type: str
    from_starts_at: datetime | None
    to_starts_at: datetime | None
    local_date: date
    from_local_date: date | None
    occurred_at: datetime
    actor: str = "patient"


@dataclass(frozen=True)
class PlannedMark:
    kind: str  # arrived | no_show
    marked_at: datetime


@dataclass
class PlannedAppointment:
    id: uuid.UUID
    doctor_key: str
    doctor_id: uuid.UUID
    patient: Person
    starts_at: datetime
    status: str
    created_at: datetime
    updated_at: datetime
    cancelled_at: datetime | None = None
    cancellation_reason: str | None = None
    events: list[PlannedEvent] = field(default_factory=list)
    mark: PlannedMark | None = None


@dataclass
class Plan:
    today: date
    now: datetime
    appointments: list[PlannedAppointment]

    @property
    def events(self) -> list[PlannedEvent]:
        out = [e for a in self.appointments for e in a.events]
        out.sort(key=lambda e: (e.occurred_at, str(e.appointment_id), e.event_type))
        return out


def default_today(real_now: datetime) -> date:
    local = real_now.astimezone(TZ)
    return local.date() if local.time() >= SEED_HOUR else local.date() - timedelta(days=1)


def seed_now(today: date) -> datetime:
    return datetime.combine(today, SEED_HOUR, tzinfo=TZ).astimezone(UTC)


def _windows(doc: DoctorSeed, weekday: int) -> list[tuple[time, time]]:
    return [(w.start, w.end) for w in doc.windows if w.weekday == weekday]


def _day_slots(doc: DoctorSeed, day: date) -> list[datetime]:
    return grid_for_date(_windows(doc, day.isoweekday()), TZ, day)


def _day_states(doc: DoctorSeed, day: date) -> dict[datetime, str]:
    """booked / cancelled / free for each slot of one doctor-day, from hashes of stable keys only.

    The number of booked and cancelled slots is the day's expected share, rounded up or down by
    a hash, so the average over many days is the target and a day never depends on any other.
    """
    slots = _day_slots(doc, day)
    n = len(slots)
    if n == 0:
        return {}
    p_b = FILL[doc.key]
    k_b = min(n, math.floor(p_b * n + _u(doc.key, day, "kb")))
    k_c = min(n - k_b, math.floor(p_b * CANCEL_PER_BOOKED * n + _u(doc.key, day, "kc")))
    ranked = sorted(slots, key=lambda s: _hash(doc.key, s.isoformat(), "rank"))
    states = {s: "free" for s in slots}
    for s in ranked[:k_b]:
        states[s] = "booked"
    for s in ranked[k_b : k_b + k_c]:
        states[s] = "cancelled"
    return states


def _clinic_hour(day: date, u: float) -> datetime:
    """A clinic-local time between 07:30 and 20:30 on ``day``, as a UTC instant."""
    minutes = 7 * 60 + 30 + int(u * (13 * 60))
    local = datetime.combine(day, time(minutes // 60, minutes % 60), tzinfo=TZ)
    return local.astimezone(UTC)


def _booking_time(doc_key: str, start: datetime, cap: datetime, salt: str) -> datetime:
    """When the visit was booked: some days before it, and never after ``cap``."""
    days = LEAD_DAYS[_hash(doc_key, start.isoformat(), salt, "lead") % len(LEAD_DAYS)]
    day = (start.astimezone(TZ) - timedelta(days=days)).date()
    booked = _clinic_hour(day, _u(doc_key, start.isoformat(), salt, "hour"))
    if booked > cap:
        back = 1 + int(_u(doc_key, start.isoformat(), salt, "back") * 3)
        day = (cap.astimezone(TZ) - timedelta(days=back)).date()
        booked = _clinic_hour(day, _u(doc_key, start.isoformat(), salt, "hour2"))
    return booked


def _between(lo: datetime, hi: datetime, u: float) -> datetime | None:
    if hi <= lo:
        return None
    seconds = int((hi - lo).total_seconds() * u)
    return (lo + timedelta(seconds=seconds)).replace(second=0, microsecond=0)


def _eligible(doc_key: str) -> list[Person]:
    return [
        p for p in PEOPLE if p.band in SEES[doc_key] and (doc_key != "mwangi" or p.gender == "F")
    ]


def build_plan(today: date, *, now: datetime | None = None) -> Plan:
    """The whole seed as data. Pure: no database, no clock."""
    now = now or seed_now(today)
    cap = now - EVENT_MARGIN
    first_day = today - timedelta(days=PAST_DAYS)
    last_day = today + timedelta(days=FUTURE_DAYS)

    rows: list[PlannedAppointment] = []
    busy: set[tuple[str, datetime]] = set()  # (patient key, start) already held by anyone
    taken_originals: set[tuple[str, datetime]] = set()  # (doctor key, original start) in use
    load: dict[str, int] = {}

    candidates: list[tuple[datetime, str, DoctorSeed, str]] = []
    day = first_day
    while day <= last_day:
        for doc in DOCTORS:
            for start, state in _day_states(doc, day).items():
                if state != "free":
                    candidates.append((start, doc.key, doc, state))
        day += timedelta(days=1)
    candidates.sort(key=lambda c: (c[0], c[1]))

    for start, _key, doc, state in candidates:
        doctor_id = uuid.uuid5(NAMESPACE, f"doctor:{doc.key}")
        pool = _eligible(doc.key)
        order = sorted(pool, key=lambda p: _hash(doc.key, start.isoformat(), p.key, "who"))
        free_people = [p for p in order if (p.key, start) not in busy][:4]
        if not free_people:
            continue
        # Of four hashed candidates, the one with the fewest visits so far: no patient piles up.
        person = min(free_people, key=lambda p: load.get(p.key, 0))
        load[person.key] = load.get(person.key, 0) + 1
        appt_id = _id("appointment", f"{doc.key}:{start.isoformat()}")
        windows = _windows(doc, start.astimezone(TZ).isoweekday())

        if state == "cancelled":
            booked_at = _booking_time(doc.key, start, cap, "c")
            cancelled_at = _between(
                booked_at + timedelta(hours=1),
                min(start - LEAD - timedelta(minutes=5), cap),
                _u(doc.key, start.isoformat(), "cancel-at"),
            )
            if cancelled_at is None:
                continue
            validate_slot(start, windows, TZ, booked_at, LEAD, HORIZON_DAYS)
            if start - cancelled_at < LEAD:  # the one-hour rule for cancels
                raise ValueError("seed plan cancels inside the last hour")
            reasons = [r for r, areas in CANCEL_REASONS if areas is None or person.area in areas]
            reason = reasons[_hash(doc.key, start.isoformat(), "reason") % len(reasons)]
            busy.add((person.key, start))
            appt = PlannedAppointment(
                appt_id,
                doc.key,
                doctor_id,
                person,
                start,
                "cancelled",
                booked_at,
                cancelled_at,
                cancelled_at,
                reason,
            )
            appt.events = [
                _event(appt_id, doctor_id, booked_event(start, TZ), booked_at),
                _event(appt_id, doctor_id, cancelled_event(start, TZ), cancelled_at),
            ]
            rows.append(appt)
            continue

        # booked, and possibly moved from an earlier time that was free for this doctor
        original = _original(doc, start, taken_originals, busy, person, cap)
        if original is not None and _u(doc.key, start.isoformat(), "resched") < RESCHEDULED_SHARE:
            orig_start, booked_at, moved_at = original
            validate_slot(
                orig_start,
                _windows(doc, orig_start.astimezone(TZ).isoweekday()),
                TZ,
                booked_at,
                LEAD,
                HORIZON_DAYS,
            )
            validate_slot(start, windows, TZ, moved_at, LEAD, HORIZON_DAYS)
            taken_originals.add((doc.key, orig_start))
            busy.add((person.key, orig_start))
            busy.add((person.key, start))
            appt = PlannedAppointment(
                appt_id, doc.key, doctor_id, person, start, "booked", booked_at, moved_at
            )
            appt.events = [
                _event(appt_id, doctor_id, booked_event(orig_start, TZ), booked_at),
                _event(appt_id, doctor_id, rescheduled_event(orig_start, start, TZ), moved_at),
            ]
            rows.append(appt)
            continue

        booked_at = _booking_time(doc.key, start, cap, "b")
        validate_slot(start, windows, TZ, booked_at, LEAD, HORIZON_DAYS)
        busy.add((person.key, start))
        appt = PlannedAppointment(
            appt_id, doc.key, doctor_id, person, start, "booked", booked_at, booked_at
        )
        appt.events = [_event(appt_id, doctor_id, booked_event(start, TZ), booked_at)]
        rows.append(appt)

    for appt in rows:
        _mark_attendance(appt, cap)
    return Plan(today, now, rows)


DESK = "reception@example.com"


def _mark_attendance(appt: PlannedAppointment, cap: datetime) -> None:
    """The desk marks a visit that has happened: mostly arrived a few minutes before or after the
    start, a few no-shows an hour or so later. Visits too recent to have been marked are left."""
    if appt.status != "booked":
        return
    key = appt.starts_at.isoformat()
    kind: Attendance = "no_show" if _u(appt.doctor_key, key, "show") < 0.05 else "arrived"
    if kind == "arrived":
        marked_at = appt.starts_at + timedelta(
            minutes=-10 + int(_u(appt.doctor_key, key, "at") * 25)
        )
    else:
        marked_at = appt.starts_at + timedelta(
            minutes=30 + int(_u(appt.doctor_key, key, "at") * 40)
        )
    if marked_at > cap or not window_is_open(appt.starts_at, marked_at, kind):
        return
    appt.mark = PlannedMark(kind, marked_at)
    appt.events.append(
        _event(
            appt.id, appt.doctor_id, annotation_event(kind, appt.starts_at, TZ), marked_at, "staff"
        )
    )
    appt.updated_at = max(appt.updated_at, marked_at)


def _original(
    doc: DoctorSeed,
    start: datetime,
    taken: set[tuple[str, datetime]],
    busy: set[tuple[str, datetime]],
    person: Person,
    cap: datetime,
) -> tuple[datetime, datetime, datetime] | None:
    """An earlier free slot of the same doctor this visit was moved from, with when it was
    booked and when it was moved. None when no consistent history exists."""
    for back in (1, 2, 3, 4, 5, 6):
        day = (start.astimezone(TZ) - timedelta(days=back)).date()
        free = [s for s, st in _day_states(doc, day).items() if st == "free"]
        free.sort(key=lambda s: _hash(doc.key, start.isoformat(), s.isoformat(), "orig"))
        for orig in free:
            if (doc.key, orig) in taken or (person.key, orig) in busy:
                continue
            booked_at = _booking_time(doc.key, orig, cap, "o")
            moved_at = _between(
                booked_at + timedelta(hours=2),
                min(orig - LEAD - timedelta(minutes=5), cap),
                _u(doc.key, start.isoformat(), "moved-at"),
            )
            if moved_at is None:
                continue
            return orig, booked_at, moved_at
    return None


def _event(
    appt_id: uuid.UUID, doctor_id: uuid.UUID, f: EventFields, at: datetime, actor: str = "patient"
) -> PlannedEvent:
    return PlannedEvent(
        appt_id,
        doctor_id,
        f.event_type,
        f.from_starts_at,
        f.to_starts_at,
        f.local_date,
        f.from_local_date,
        at,
        actor,
    )


async def apply(conn: AsyncConnection, plan: Plan) -> dict[str, int]:
    """Write the plan. Counts of rows inserted; a second run with the same plan returns zeros."""
    known = {r[0] for r in (await conn.execute(text("SELECT id FROM doctors"))).all()}
    needed = {uuid.uuid5(NAMESPACE, f"doctor:{d.key}") for d in DOCTORS}
    if not needed <= known:
        raise SystemExit("run the core seed first: python -m app.scripts.seed")

    first_booking: dict[str, datetime] = {}
    for a in plan.appointments:
        first_booking[a.patient.key] = min(
            first_booking.get(a.patient.key, a.created_at), a.created_at
        )

    inserted = {"patients": 0, "appointments": 0, "events": 0, "marks": 0, "skipped": 0}
    for index, person in enumerate(PEOPLE):
        joined = first_booking.get(person.key, plan.now) - timedelta(
            days=3 + int(_u(person.key, "joined") * 30)
        )
        res = await conn.execute(
            text(
                "INSERT INTO patients (id, full_name, phone, email, demo, created_at) "
                "VALUES (:id, :name, :phone, :email, true, :created) ON CONFLICT (id) DO NOTHING"
            ),
            {
                "id": patient_id(person),
                "name": person.full_name,
                "phone": phone(index),
                "email": person.email,
                "created": joined,
            },
        )
        inserted["patients"] += res.rowcount

    inserted_ids: set[uuid.UUID] = set()
    for appt in plan.appointments:
        taken = (
            await conn.execute(
                text(
                    "SELECT 1 FROM appointments WHERE doctor_id = :d AND starts_at = :s "
                    "AND status = 'booked' AND id <> :id"
                ),
                {"d": appt.doctor_id, "s": appt.starts_at, "id": appt.id},
            )
        ).first()
        if taken is not None and appt.status == "booked":
            inserted["skipped"] += 1  # a real booking holds this slot: never displace it
            continue
        res = await conn.execute(
            text(
                "INSERT INTO appointments (id, doctor_id, patient_id, starts_at, ends_at, status, "
                "cancellation_reason, cancelled_at, created_at, updated_at) "
                "VALUES (:id, :doctor, :patient, :s, :e, :status, :reason, :cancelled, :created, "
                ":updated) ON CONFLICT (id) DO NOTHING"
            ),
            {
                "id": appt.id,
                "doctor": appt.doctor_id,
                "patient": patient_id(appt.patient),
                "s": appt.starts_at,
                "e": appt.starts_at + SLOT,
                "status": appt.status,
                "reason": appt.cancellation_reason,
                "cancelled": appt.cancelled_at,
                "created": appt.created_at,
                "updated": appt.updated_at,
            },
        )
        if res.rowcount == 0:
            continue
        inserted["appointments"] += 1
        inserted_ids.add(appt.id)
    for e in plan.events:
        if e.appointment_id not in inserted_ids:
            continue  # skipped, or already there with its history from an earlier run
        await conn.execute(
            text(
                "INSERT INTO appointment_events (appointment_id, doctor_id, event_type, "
                "from_starts_at, to_starts_at, local_date, from_local_date, occurred_at, actor) "
                "VALUES (:a, :d, :t, :f, :to, :ld, :fld, :at, :actor)"
            ),
            {
                "a": e.appointment_id,
                "d": e.doctor_id,
                "t": e.event_type,
                "f": e.from_starts_at,
                "to": e.to_starts_at,
                "ld": e.local_date,
                "fld": e.from_local_date,
                "at": e.occurred_at,
                "actor": e.actor,
            },
        )
        inserted["events"] += 1
    for appt in plan.appointments:
        if appt.id not in inserted_ids or appt.mark is None:
            continue
        await _write_mark(conn, appt, appt.mark)
        inserted["marks"] += 1
    return inserted


async def _write_mark(conn: AsyncConnection, appt: PlannedAppointment, mark: PlannedMark) -> None:
    """What ``services.booking.mark_attendance`` writes besides the annotation event: the attendance
    row and the staff audit row (same reason text, same before / after). The audit row's id is
    stable, so the row is the same on every run."""
    reason = "Marked arrived at the desk" if mark.kind == "arrived" else "Marked no-show"
    await conn.execute(
        text(
            "INSERT INTO appointment_attendance (appointment_id, kind, marked_by, marked_at) "
            "VALUES (:id, :kind, :by, :at)"
        ),
        {"id": appt.id, "kind": mark.kind, "by": DESK, "at": mark.marked_at},
    )
    await conn.execute(
        text(
            "INSERT INTO staff_action_audit (id, actor_email, actor_role, action, appointment_id, "
            "reason, before, after, occurred_at) VALUES (:id, :by, CAST('admin' AS staff_role), "
            ":kind, :appt, :reason, CAST(:before AS jsonb), CAST(:after AS jsonb), :at) "
            "ON CONFLICT (id) DO NOTHING"
        ),
        {
            "id": _id("audit", f"{appt.id}:{mark.kind}"),
            "by": DESK,
            "kind": mark.kind,
            "appt": appt.id,
            "reason": reason,
            "before": json.dumps({"attendance": None}),
            "after": json.dumps({"attendance": mark.kind}),
            "at": mark.marked_at,
        },
    )


async def main(today: date | None = None) -> None:
    real_now = SystemClock().now()
    day = today or default_today(real_now)
    plan = build_plan(day)
    if plan.now > real_now - EVENT_MARGIN:
        raise SystemExit(f"--today {day} is too recent: its history would be newer than now")
    engine = get_engine(Settings())
    async with engine.begin() as conn:
        counts = await apply(conn, plan)
    await dispose_engine()
    sys.stdout.write(f"seed_demo today={day} {counts}\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--today", type=date.fromisoformat, default=None)
    asyncio.run(main(parser.parse_args().today))
