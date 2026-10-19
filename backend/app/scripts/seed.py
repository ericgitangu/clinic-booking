"""Idempotent seed.

Writes are ``INSERT ... ON CONFLICT (id) DO UPDATE`` only. No DELETE, ever: the seed runs
against live prod on every deploy. Ids are deterministic ``uuid5`` values so reruns update
in place. The expected working_hours count is 27; if the DB shows anything else, the
seed is wrong, not the number.
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from datetime import time

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core.config import Settings
from app.db.session import dispose_engine, get_engine

NAMESPACE = uuid.UUID("6f1c2a52-6a0e-4c7a-9a3e-2b6f2d1c0a11")
CLINIC_NAME = "Idyllic Clinic"
CLINIC_TZ = "Africa/Nairobi"


def _id(kind: str, key: str) -> uuid.UUID:
    return uuid.uuid5(NAMESPACE, f"{kind}:{key}")


@dataclass(frozen=True)
class Window:
    weekday: int  # ISO 1=Mon..7=Sun
    start: time
    end: time


@dataclass(frozen=True)
class DoctorSeed:
    key: str
    full_name: str
    specialty: str
    windows: list[Window] = field(default_factory=list)


def _weekly(weekdays: list[int], spans: list[tuple[time, time]]) -> list[Window]:
    return [Window(d, s, e) for d in weekdays for (s, e) in spans]


MON_FRI = [1, 2, 3, 4, 5]
MON_SAT = [1, 2, 3, 4, 5, 6]

DOCTORS: list[DoctorSeed] = [
    DoctorSeed(
        "otieno",
        "Dr. Achieng Otieno",
        "General Practice",
        _weekly(MON_FRI, [(time(8, 0), time(12, 0)), (time(13, 0), time(17, 0))]),
    ),
    DoctorSeed(
        "kamau",
        "Dr. Brian Kamau",
        "Paediatrics",
        _weekly(MON_FRI, [(time(9, 0), time(17, 0))]),
    ),
    DoctorSeed(
        "rotich",
        "Dr. Chebet Rotich",
        "Dermatology",
        _weekly([1, 3, 5], [(time(8, 0), time(14, 0))]),
    ),
    DoctorSeed(
        "mwangi",
        "Dr. David Mwangi",
        "Obstetrics & Gynaecology",
        [
            Window(2, time(10, 0), time(18, 0)),
            Window(4, time(10, 0), time(18, 0)),
            Window(6, time(9, 0), time(13, 0)),
        ],
    ),
    DoctorSeed(
        "njeri",
        "Dr. Esther Njeri",
        "Dentistry",
        _weekly(MON_SAT, [(time(7, 0), time(11, 0))]),
    ),
]

DEMO_PATIENTS: list[tuple[str, str]] = [
    ("amina", "Amina Hassan"),
    ("brian", "Brian Otieno"),
    ("wanjiru", "Wanjiru Kariuki"),
]

EXPECTED_WORKING_HOURS = 27


def _validate_no_overlap(doc: DoctorSeed) -> None:
    by_day: dict[int, list[tuple[time, time]]] = {}
    for w in doc.windows:
        by_day.setdefault(w.weekday, []).append((w.start, w.end))
    for weekday, spans in by_day.items():
        spans.sort()
        for (s1, e1), (s2, e2) in zip(spans, spans[1:], strict=False):
            if s2 < e1:
                raise ValueError(
                    f"overlapping windows for {doc.key} on weekday {weekday}: "
                    f"{s1}-{e1} and {s2}-{e2}"
                )


async def _seed(conn: AsyncConnection) -> None:
    clinic_id = _id("clinic", "mvule")
    await conn.execute(
        text(
            "INSERT INTO clinics (id, name, timezone) VALUES (:id, :name, :tz) "
            "ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, timezone = EXCLUDED.timezone"
        ),
        {"id": clinic_id, "name": CLINIC_NAME, "tz": CLINIC_TZ},
    )

    total_windows = 0
    for doc in DOCTORS:
        _validate_no_overlap(doc)
        doctor_id = _id("doctor", doc.key)
        await conn.execute(
            text(
                "INSERT INTO doctors (id, clinic_id, full_name, specialty, is_active) "
                "VALUES (:id, :clinic_id, :full_name, :specialty, true) "
                "ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, "
                "specialty = EXCLUDED.specialty, is_active = EXCLUDED.is_active"
            ),
            {
                "id": doctor_id,
                "clinic_id": clinic_id,
                "full_name": doc.full_name,
                "specialty": doc.specialty,
            },
        )
        for w in doc.windows:
            wh_id = _id("wh", f"{doc.key}:{w.weekday}:{w.start.isoformat()}")
            await conn.execute(
                text(
                    "INSERT INTO working_hours (id, doctor_id, weekday, start_time, end_time) "
                    "VALUES (:id, :doctor_id, :weekday, :start, :end) "
                    "ON CONFLICT (id) DO UPDATE SET weekday = EXCLUDED.weekday, "
                    "start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time"
                ),
                {
                    "id": wh_id,
                    "doctor_id": doctor_id,
                    "weekday": w.weekday,
                    "start": w.start,
                    "end": w.end,
                },
            )
            total_windows += 1

    if total_windows != EXPECTED_WORKING_HOURS:
        raise ValueError(
            f"seed produced {total_windows} working_hours rows, expected {EXPECTED_WORKING_HOURS}"
        )

    for key, full_name in DEMO_PATIENTS:
        await conn.execute(
            text(
                "INSERT INTO patients (id, full_name, phone, email) "
                "VALUES (:id, :full_name, NULL, NULL) "
                "ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name"
            ),
            {"id": _id("patient", key), "full_name": full_name},
        )


async def main() -> None:
    settings = Settings()  # fields come from the environment at runtime
    engine = get_engine(settings)
    async with engine.begin() as conn:
        await _seed(conn)
    await dispose_engine()


if __name__ == "__main__":
    asyncio.run(main())
