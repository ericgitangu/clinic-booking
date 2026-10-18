"""The dashboard's day ranges are clinic-local days of each row's own clinic, not of one clinic.

Two clinics, Nairobi (seeded) and another zone, each with one event/visit at the same instant:
22:30Z on 2026-10-20 is already 21 October in Nairobi (01:30) but still 20 October in New York
(18:30). A range that selects the 21st must include only the Nairobi one, and the 20th only the
New York one, whichever clinic happens to be first.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import asyncpg
import httpx
import pytest

from app.api.deps import get_clock
from app.core.clock import FakeClock
from app.main import create_app
from tests.conftest import FIXED_NOW, make_settings, seeded_doctor_id, seeded_patient_id
from tests.integration.test_access import KEY, OWNER, _headers

pytestmark = pytest.mark.asyncio

NAIROBI_DOCTOR = seeded_doctor_id("otieno")
INSTANT = datetime(2026, 10, 20, 22, 30, tzinfo=UTC)  # 21 Oct 01:30 Nairobi, 20 Oct 18:30 New York
LATE = "2026-10-20"
EARLY = "2026-10-21"


async def _admin_get(path: str) -> httpx.Response:
    app = create_app(make_settings(INTERNAL_SIGNING_KEY=KEY, ADMIN_EMAILS=OWNER))
    app.dependency_overrides[get_clock] = lambda: FakeClock(FIXED_NOW)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        return await c.get(path, headers=_headers("GET", path, email=OWNER, role="owner"))


async def _seed_visit(conn: asyncpg.Connection, doctor: uuid.UUID, patient: uuid.UUID) -> uuid.UUID:
    appt = uuid.uuid4()
    await conn.execute(
        "INSERT INTO appointments (id, doctor_id, patient_id, starts_at, ends_at) "
        "VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz + interval '30 minutes')",
        appt,
        doctor,
        patient,
        INSTANT,
    )
    await conn.execute(
        "INSERT INTO appointment_events "
        "(appointment_id, doctor_id, event_type, to_starts_at, local_date, occurred_at) "
        "VALUES ($1, $2, 'booked', $3, $4, $3)",
        appt,
        doctor,
        INSTANT,
        INSTANT.date(),
    )
    return appt


@pytest.mark.parametrize("zone", ["America/New_York"])
async def test_metrics_and_list_use_each_rows_own_clinic_zone(
    reset_appointments: None,
    owner_conn: asyncpg.Connection,
    other_clinic: uuid.UUID,
    zone: str,
) -> None:
    amina, brian = seeded_patient_id("amina"), seeded_patient_id("brian")
    nairobi_appt = await _seed_visit(owner_conn, NAIROBI_DOCTOR, amina)
    ny_appt = await _seed_visit(owner_conn, other_clinic, brian)

    def visits(body: dict[str, object]) -> dict[str, int]:
        rows = body["per_doctor"]
        assert isinstance(rows, list)
        return {r["doctor_id"]: r["booked_visits"] for r in rows}

    # The 21st (Nairobi's local day): only the Nairobi visit and event.
    on_21st = (await _admin_get(f"/internal/admin/metrics?from={EARLY}&to=2026-10-22")).json()
    assert visits(on_21st).get(str(NAIROBI_DOCTOR)) == 1
    assert visits(on_21st).get(str(other_clinic), 0) == 0
    assert [p["bucket_start"] for p in on_21st["series"]] == ["2026-10-21T00:00:00"]
    assert on_21st["totals"]["booked"] == 1

    # The 20th (New York's local day): only the New York visit and event.
    on_20th = (await _admin_get(f"/internal/admin/metrics?from={LATE}&to={EARLY}")).json()
    assert visits(on_20th).get(str(other_clinic)) == 1
    assert visits(on_20th).get(str(NAIROBI_DOCTOR), 0) == 0
    assert [p["bucket_start"] for p in on_20th["series"]] == ["2026-10-20T00:00:00"]
    assert on_20th["totals"]["booked"] == 1

    # Both days: each event in the bucket of its own clinic's local day.
    both = (await _admin_get(f"/internal/admin/metrics?from={LATE}&to=2026-10-22")).json()
    assert [p["bucket_start"] for p in both["series"]] == [
        "2026-10-20T00:00:00",
        "2026-10-21T00:00:00",
    ]
    assert both["totals"]["booked"] == 2

    # The appointment list filters the same way and renders each row in its own zone.
    def listed(body: dict[str, object]) -> dict[str, str]:
        items = body["items"]
        assert isinstance(items, list)
        return {i["id"]: i["timezone"] for i in items}

    list_21 = (await _admin_get(f"/internal/admin/appointments?from={EARLY}&to=2026-10-22")).json()
    assert listed(list_21) == {str(nairobi_appt): "Africa/Nairobi"}
    list_20 = (await _admin_get(f"/internal/admin/appointments?from={LATE}&to={EARLY}")).json()
    assert listed(list_20) == {str(ny_appt): zone}
    list_all = (await _admin_get(f"/internal/admin/appointments?from={LATE}&to=2026-10-22")).json()
    assert listed(list_all) == {str(nairobi_appt): "Africa/Nairobi", str(ny_appt): zone}
    by_id = {i["id"]: i for i in list_all["items"]}
    assert by_id[str(nairobi_appt)]["starts_at"].startswith("2026-10-21T01:30:00+03:00")
    assert by_id[str(ny_appt)]["starts_at"].startswith("2026-10-20T18:30:00-04:00")


@pytest.mark.parametrize("zone", ["Asia/Kolkata"])
async def test_a_cancel_counts_in_its_own_clinics_local_day(
    reset_appointments: None,
    owner_conn: asyncpg.Connection,
    other_clinic: uuid.UUID,
    zone: str,
) -> None:
    amina = seeded_patient_id("amina")
    appt = await _seed_visit(owner_conn, other_clinic, amina)
    await owner_conn.execute(
        "INSERT INTO appointment_events "
        "(appointment_id, doctor_id, event_type, from_starts_at, local_date, occurred_at) "
        "VALUES ($1, $2, 'cancelled', $3, $4, $3)",
        appt,
        other_clinic,
        INSTANT,
        INSTANT.date(),
    )
    # 22:30Z is 04:00 on the 21st in Kolkata: the cancel belongs to the 21st there, and not to the
    # 20th (where it would fall in the UTC day or in an earlier-zone clinic's day).
    on_21st = (await _admin_get(f"/internal/admin/metrics?from={EARLY}&to=2026-10-22")).json()
    row = next(r for r in on_21st["per_doctor"] if r["doctor_id"] == str(other_clinic))
    assert row["cancelled_actions"] == 1
    on_20th = (await _admin_get(f"/internal/admin/metrics?from={LATE}&to={EARLY}")).json()
    other = [r for r in on_20th["per_doctor"] if r["doctor_id"] == str(other_clinic)]
    assert other == [] or other[0]["cancelled_actions"] == 0


@pytest.mark.parametrize("zone", ["America/Los_Angeles"])
async def test_a_cancel_west_of_utc_counts_on_the_clinics_earlier_local_day(
    reset_appointments: None,
    owner_conn: asyncpg.Connection,
    other_clinic: uuid.UUID,
    zone: str,
) -> None:
    # 02:00Z on the 21st is 05:00 on the 21st in Nairobi (the first clinic) but 19:00 on the 20th in
    # Los Angeles. A cancel in the Los Angeles clinic belongs to the 20th: counting it in the first
    # clinic's zone, or in UTC, would put it on the 21st.
    moment = datetime(2026, 10, 21, 2, 0, tzinfo=UTC)
    appt = uuid.uuid4()
    await owner_conn.execute(
        "INSERT INTO appointments (id, doctor_id, patient_id, starts_at, ends_at) "
        "VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz + interval '30 minutes')",
        appt,
        other_clinic,
        seeded_patient_id("amina"),
        datetime(2026, 10, 27, 17, 0, tzinfo=UTC),
    )
    await owner_conn.execute(
        "INSERT INTO appointment_events "
        "(appointment_id, doctor_id, event_type, from_starts_at, local_date, occurred_at) "
        "VALUES ($1, $2, 'cancelled', $3, $4, $3)",
        appt,
        other_clinic,
        moment,
        datetime(2026, 10, 20, tzinfo=UTC).date(),
    )

    def cancels(body: dict[str, object]) -> int:
        rows = body["per_doctor"]
        assert isinstance(rows, list)
        mine = [r for r in rows if r["doctor_id"] == str(other_clinic)]
        return int(mine[0]["cancelled_actions"]) if mine else 0

    on_20th = (await _admin_get("/internal/admin/metrics?from=2026-10-20&to=2026-10-21")).json()
    on_21st = (await _admin_get("/internal/admin/metrics?from=2026-10-21&to=2026-10-22")).json()
    assert cancels(on_20th) == 1
    assert cancels(on_21st) == 0
