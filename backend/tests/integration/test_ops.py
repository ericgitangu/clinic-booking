"""The operations dashboard's read model on real Postgres: statuses, running behind, KPIs with
previous-period deltas, reason categories, heatmap, free slots, and who sees what."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from typing import Any

import asyncpg
import pytest
import pytest_asyncio

from tests.conftest import seeded_doctor_id
from tests.integration.staff_support import OTIENO, Env

pytestmark = pytest.mark.asyncio

KAMAU = seeded_doctor_id("kamau")
REAL = uuid.UUID("00000000-0000-4000-8000-0000000000d1")
SYNTH = uuid.UUID("00000000-0000-4000-8000-0000000000d2")
DEMO = uuid.UUID("00000000-0000-4000-8000-0000000000d3")
REAL_NAME, REAL_PHONE = "Amani Odhiambo", "+254722111333"


def eat(day: int, hour: int, minute: int = 0) -> datetime:
    """A Nairobi wall time in October 2026, as UTC."""
    return datetime(2026, 10, day, hour, minute, tzinfo=UTC) - timedelta(hours=3)


async def add(
    conn: asyncpg.Connection,
    doctor: uuid.UUID,
    patient: uuid.UUID,
    start: datetime,
    *,
    status: str = "booked",
    reason: str | None = None,
    lead_minutes: int = 120,
    attendance: str | None = None,
    cancelled_at: datetime | None = None,
) -> uuid.UUID:
    created = start - timedelta(minutes=lead_minutes)
    appt_id: uuid.UUID = await conn.fetchval(
        "INSERT INTO appointments (doctor_id, patient_id, starts_at, ends_at, status, "
        "cancellation_reason, cancelled_at, created_at, updated_at) "
        "VALUES ($1, $2, $3::timestamptz, $3::timestamptz + interval '30 minutes', "
        "$4, $5, $6, $7, $7) RETURNING id",
        doctor,
        patient,
        start,
        status,
        reason,
        (cancelled_at or created + timedelta(minutes=5)) if status == "cancelled" else None,
        created,
    )
    if attendance:
        await conn.execute(
            "INSERT INTO appointment_attendance (appointment_id, kind, marked_by, marked_at) "
            "VALUES ($1, $2, 'seed', $3)",
            appt_id,
            attendance,
            start,
        )
    return appt_id


@pytest_asyncio.fixture
async def ops(env: Env, owner_conn: asyncpg.Connection) -> AsyncIterator[Env]:
    await owner_conn.execute("DELETE FROM patients WHERE id = ANY($1::uuid[])", [REAL, SYNTH, DEMO])
    await owner_conn.execute(
        "INSERT INTO patients (id, full_name, phone, email, synthetic) VALUES "
        "($1, $4, $5, 'amani@example.com', false), ($2, 'Release Smoke', NULL, NULL, true), "
        "($3, 'Demo Patient', NULL, 'demo@example.com', false)",
        REAL,
        SYNTH,
        DEMO,
        REAL_NAME,
        REAL_PHONE,
    )
    yield env
    await owner_conn.execute("TRUNCATE appointment_events, appointments RESTART IDENTITY CASCADE")
    await owner_conn.execute("DELETE FROM patients WHERE id = ANY($1::uuid[])", [REAL, SYNTH, DEMO])


def doctor_board(board: dict[str, Any], doctor: uuid.UUID) -> dict[str, Any]:
    (found,) = [d for d in board["doctors"] if d["doctor_id"] == str(doctor)]
    return found  # type: ignore[no-any-return]  # a JSON object


# --- today's board ---------------------------------------------------------------------------


async def seed_board(conn: asyncpg.Connection) -> dict[str, uuid.UUID]:
    ids = {
        "behind": await add(conn, OTIENO, REAL, eat(27, 9, 0)),
        "arrived": await add(conn, OTIENO, DEMO, eat(27, 9, 30), attendance="arrived"),
        "noshow": await add(conn, OTIENO, REAL, eat(27, 10, 0), attendance="no_show"),
        "cancelled": await add(
            conn, OTIENO, REAL, eat(27, 10, 30), status="cancelled", reason="bus broke down"
        ),
        "synthetic": await add(conn, OTIENO, SYNTH, eat(27, 11, 0)),
    }
    return ids


async def test_the_today_board_shows_statuses_gap_and_running_behind(
    ops: Env, owner_conn: asyncpg.Connection
) -> None:
    ids = await seed_board(owner_conn)
    ops.clock.set(eat(27, 9, 20))  # the 09:00 visit began 20 minutes ago and nobody marked it
    resp = await ops.req("GET", "/internal/admin/ops/today?date=2026-10-27", role="admin")
    assert resp.status_code == 200, resp.text
    board = resp.json()
    assert board["view"] == "full"
    d = doctor_board(board, OTIENO)
    shown = {a["id"]: a for a in d["appointments"]}
    assert str(ids["synthetic"]) not in shown  # synthetic patients are left out
    assert [shown[str(ids[k])]["status"] for k in ("behind", "arrived", "noshow", "cancelled")] == [
        "booked",
        "arrived",
        "no_show",
        "cancelled",
    ]
    assert shown[str(ids["behind"])]["patient_name"] == REAL_NAME
    assert shown[str(ids["behind"])]["patient_phone"] == REAL_PHONE
    assert d["running_behind"] == {
        "behind": True,
        "minutes": 20,
        "appointment_id": str(ids["behind"]),
    }
    # The cancelled 10:30 slot is free again; 11:00 is held by the synthetic booking (not shown,
    # but a slot nobody else can take is not a gap).
    assert d["next_gap"]["starts_at"].startswith("2026-10-27T10:30:00+03:00")
    assert d["next_gap"]["slots"] == 1
    assert board["totals"] == {"booked": 1, "arrived": 1, "no_show": 1, "cancelled": 1}
    # Other doctors are listed with empty timelines.
    assert doctor_board(board, KAMAU)["appointments"] == []


async def test_marking_the_late_patient_clears_running_behind(
    ops: Env, owner_conn: asyncpg.Connection
) -> None:
    ids = await seed_board(owner_conn)
    ops.clock.set(eat(27, 9, 20))
    marked = await ops.req("POST", f"/internal/admin/appointments/{ids['behind']}/arrived")
    assert marked.status_code == 200, marked.text
    d = doctor_board(
        (await ops.req("GET", "/internal/admin/ops/today?date=2026-10-27")).json(), OTIENO
    )
    assert d["running_behind"]["behind"] is False


async def test_ten_minutes_late_is_still_within_grace(
    ops: Env, owner_conn: asyncpg.Connection
) -> None:
    await add(owner_conn, OTIENO, REAL, eat(27, 9, 0))
    for minutes, behind in [(10, False), (11, True)]:
        ops.clock.set(eat(27, 9, minutes))
        board = (await ops.req("GET", "/internal/admin/ops/today?date=2026-10-27")).json()
        assert doctor_board(board, OTIENO)["running_behind"]["behind"] is behind


async def test_the_board_for_another_day_is_never_behind(
    ops: Env, owner_conn: asyncpg.Connection
) -> None:
    await add(owner_conn, OTIENO, REAL, eat(26, 9, 0))
    ops.clock.set(eat(27, 12, 0))
    board = (await ops.req("GET", "/internal/admin/ops/today?date=2026-10-26")).json()
    assert doctor_board(board, OTIENO)["running_behind"]["behind"] is False
    assert doctor_board(board, OTIENO)["next_gap"] is None  # a past day has no free future slots


async def test_a_viewer_gets_the_minimised_board(ops: Env, owner_conn: asyncpg.Connection) -> None:
    await seed_board(owner_conn)
    ops.clock.set(eat(27, 9, 20))
    resp = await ops.req("GET", "/internal/admin/ops/today?date=2026-10-27", role="viewer")
    board = resp.json()
    assert board["view"] == "minimised"
    names = {a["patient_name"] for a in doctor_board(board, OTIENO)["appointments"]}
    assert names == {"A. O.", "D. P."}
    assert REAL_NAME not in resp.text and REAL_PHONE not in resp.text
    phones = {a["patient_phone"] for a in doctor_board(board, OTIENO)["appointments"]}
    assert phones == {"+**********33", None}


# --- KPIs ------------------------------------------------------------------------------------


async def offered(conn: asyncpg.Connection, weekday: int) -> int:
    value: int = await conn.fetchval(
        "SELECT sum(extract(epoch FROM (w.end_time - w.start_time)) / 1800)::int "
        "FROM working_hours w JOIN doctors d ON d.id = w.doctor_id "
        "WHERE d.is_active AND w.weekday = $1",
        weekday,
    )
    return value


async def seed_kpis(conn: asyncpg.Connection) -> None:
    # Tuesday 27th (the period), then Monday 26th (the period before it).
    await add(conn, OTIENO, REAL, eat(27, 8, 0), lead_minutes=120, attendance="arrived")
    await add(conn, OTIENO, DEMO, eat(27, 8, 30), lead_minutes=60, attendance="arrived")
    await add(conn, OTIENO, REAL, eat(27, 9, 0), lead_minutes=600, attendance="no_show")
    await add(conn, OTIENO, DEMO, eat(27, 9, 30), lead_minutes=60)
    await add(conn, OTIENO, REAL, eat(27, 10, 0), status="cancelled", reason="sick")
    await add(conn, OTIENO, SYNTH, eat(27, 10, 30), attendance="arrived")  # excluded
    await add(conn, OTIENO, REAL, eat(26, 8, 0), lead_minutes=30, attendance="arrived")
    await add(conn, OTIENO, DEMO, eat(26, 8, 30), lead_minutes=90, attendance="arrived")
    await add(conn, OTIENO, REAL, eat(26, 9, 0), status="cancelled", reason="rain")
    for day, minute in [(27, 0), (27, 30), (26, 30)]:
        appt = await add(conn, KAMAU, REAL, eat(day, 15, minute))
        await conn.execute(
            "INSERT INTO appointment_events (appointment_id, doctor_id, event_type, local_date, "
            "occurred_at) VALUES ($1, $2, 'rescheduled', $3, $4)",
            appt,
            KAMAU,
            datetime(2026, 10, day).date(),
            eat(day, 12),
        )
    synth_appt = await add(conn, KAMAU, SYNTH, eat(27, 16, 0))
    await conn.execute(
        "INSERT INTO appointment_events (appointment_id, doctor_id, event_type, local_date, "
        "occurred_at) VALUES ($1, $2, 'rescheduled', '2026-10-27', $3)",
        synth_appt,
        KAMAU,
        eat(27, 12),
    )


async def test_kpis_with_previous_period_deltas(ops: Env, owner_conn: asyncpg.Connection) -> None:
    await seed_kpis(owner_conn)
    resp = await ops.req(
        "GET", "/internal/admin/ops/kpis?from=2026-10-27&to=2026-10-28", role="viewer"
    )
    assert resp.status_code == 200, resp.text
    k = resp.json()
    assert k["range"] == {"from": "2026-10-27", "to": "2026-10-28"}
    assert k["previous_range"] == {"from": "2026-10-26", "to": "2026-10-27"}
    off_now, off_prev = await offered(owner_conn, 2), await offered(owner_conn, 1)
    # Tuesday: Otieno 4 booked (2 arrived, 1 no-show, 1 unmarked) + 1 cancelled; Kamau 2 booked
    # at 15:00 and 15:30 (the reschedule fixtures) and the synthetic rows are all left out.
    assert k["counts"] == {
        "offered": off_now,
        "booked": 6,
        "cancelled": 1,
        "arrived": 2,
        "no_show": 1,
    }
    assert k["utilisation"]["value"] == round(2 / off_now, 4)
    assert k["fill_rate"]["value"] == round(6 / off_now, 4)
    assert k["cancellation_rate"]["value"] == round(1 / 7, 4)
    assert k["no_show_rate"]["value"] == round(1 / 3, 4)
    assert k["no_show_rate"]["previous"] == 0.0
    assert k["no_show_rate"]["delta"] == round(1 / 3, 4)
    # Monday: 2 arrived + Kamau's 15:30 booking, 1 cancelled.
    assert k["utilisation"]["previous"] == round(2 / off_prev, 4)
    assert k["cancellation_rate"]["previous"] == round(1 / 4, 4)
    assert k["reschedules"] == {"value": 2.0, "previous": 1.0, "delta": 1.0}
    # leads (minutes) Tuesday: 120, 60, 600, 60 and Kamau's two at 120 -> median 120
    assert k["median_lead_minutes"]["value"] == 120.0
    assert k["median_lead_minutes"]["previous"] == 90.0  # 30, 90, 120 -> 90
    assert k["median_lead_minutes"]["delta"] == 30.0


async def test_a_rate_without_a_denominator_is_null_not_zero(ops: Env) -> None:
    k = (await ops.req("GET", "/internal/admin/ops/kpis?from=2030-01-07&to=2030-01-08")).json()
    assert k["no_show_rate"] == {"value": None, "previous": None, "delta": None}
    assert k["cancellation_rate"]["value"] is None
    assert k["reschedules"]["value"] == 0.0
    assert k["median_lead_minutes"]["value"] is None


@pytest.mark.parametrize(
    "query",
    [
        "from=2026-10-28&to=2026-10-27",
        "from=2026-10-27&to=2026-10-27",
        "from=2026-01-01&to=2026-12-31",
    ],
)
async def test_bad_ranges_are_refused(ops: Env, query: str) -> None:
    for path in ("kpis", "cancellation-reasons", "heatmap"):
        resp = await ops.req("GET", f"/internal/admin/ops/{path}?{query}")
        assert resp.status_code == 422
        assert resp.json()["code"] == "VALIDATION_ERROR"


# --- reasons ---------------------------------------------------------------------------------


async def test_cancellation_reasons_are_grouped(ops: Env, owner_conn: asyncpg.Connection) -> None:
    reasons = [
        "No matatu today",
        "Traffic was terrible",
        "I have a fever",
        "Out of town for a funeral",
        "Boss called a meeting",
        "Heavy rain",
        "I feel better now",
        "NHIF is not active",
        "Something came up",
        "Clinic closed (cancelled by clinic staff)",
    ]
    for i, text in enumerate(reasons):
        await add(
            owner_conn,
            OTIENO if i < 5 else KAMAU,
            REAL,
            eat(27, 8 + i // 2, 30 * (i % 2)),
            status="cancelled",
            reason=text,
            cancelled_at=eat(27, 7),
        )
    await add(
        owner_conn,
        OTIENO,
        SYNTH,
        eat(27, 14, 0),
        status="cancelled",
        reason="bus",
        cancelled_at=eat(27, 7),
    )
    await add(
        owner_conn,
        OTIENO,
        REAL,
        eat(27, 14, 30),
        status="cancelled",
        reason="old one",
        cancelled_at=eat(20, 7),
    )
    resp = await ops.req(
        "GET",
        "/internal/admin/ops/cancellation-reasons?from=2026-10-27&to=2026-10-28",
        role="viewer",
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["total"] == 10
    counts = {i["category"]: i["count"] for i in data["items"]}
    assert counts == {
        "transport": 2,
        "illness": 1,
        "travel": 1,
        "work": 1,
        "weather": 1,
        "felt_better": 1,
        "insurance": 1,
        "other": 2,
    }
    assert data["items"][0]["category"] == "transport" and data["items"][0]["share"] == 0.2
    assert "matatu" not in resp.text  # counts only, never the text


# --- heatmap ---------------------------------------------------------------------------------


async def test_the_heatmap_counts_booked_visits_by_local_weekday_and_hour(
    ops: Env, owner_conn: asyncpg.Connection
) -> None:
    await add(owner_conn, OTIENO, REAL, eat(27, 9, 0))
    await add(owner_conn, OTIENO, DEMO, eat(27, 9, 30))
    await add(owner_conn, KAMAU, DEMO, eat(27, 9, 0))
    await add(owner_conn, OTIENO, REAL, eat(26, 14, 0))
    await add(owner_conn, OTIENO, REAL, eat(27, 10, 0), status="cancelled", reason="rain")
    await add(owner_conn, OTIENO, SYNTH, eat(27, 13, 0))
    clinic = (
        await ops.req(
            "GET", "/internal/admin/ops/heatmap?from=2026-10-26&to=2026-10-28", role="viewer"
        )
    ).json()
    cells = {(c["weekday"], c["hour"]): c["count"] for c in clinic["cells"]}
    assert cells == {(2, 9): 3, (1, 14): 1}
    assert clinic["max"] == 3
    one = (
        await ops.req(
            "GET", f"/internal/admin/ops/heatmap?from=2026-10-26&to=2026-10-28&doctor_id={OTIENO}"
        )
    ).json()
    assert {(c["weekday"], c["hour"]): c["count"] for c in one["cells"]} == {(2, 9): 2, (1, 14): 1}
    empty = (
        await ops.req("GET", "/internal/admin/ops/heatmap?from=2030-01-07&to=2030-01-08")
    ).json()
    assert empty["cells"] == [] and empty["max"] == 0


# --- gaps to fill ----------------------------------------------------------------------------


async def test_gaps_list_free_slots_in_the_next_48_hours(
    ops: Env, owner_conn: asyncpg.Connection
) -> None:
    ops.clock.set(eat(27, 9, 20))
    await add(owner_conn, OTIENO, REAL, eat(27, 9, 30))
    await add(owner_conn, OTIENO, SYNTH, eat(27, 10, 0))  # holds the slot: not a gap
    await add(owner_conn, OTIENO, REAL, eat(27, 10, 30), status="cancelled", reason="rain")
    resp = await ops.req("GET", "/internal/admin/ops/gaps", role="viewer")
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["hours"] == 48
    items = data["items"]
    starts = [i["starts_at"] for i in items]
    assert starts == sorted(starts)
    otieno = [
        i["starts_at"][11:16]
        for i in items
        if i["doctor_id"] == str(OTIENO) and i["starts_at"].startswith("2026-10-27")
    ]
    assert "09:30" not in otieno and "10:00" not in otieno
    assert "10:30" in otieno  # the cancelled slot is free again
    assert "09:00" not in otieno  # already past
    # Nothing starts before now or at/after now + 48h.
    assert all(i["starts_at"] >= "2026-10-27T09:20" for i in items)
    assert all(i["starts_at"] < "2026-10-29T09:20" for i in items)
    # Inside the one-hour window is listed: staff may book it.
    assert any(
        i["starts_at"].startswith("2026-10-27T09:30") and i["doctor_id"] != str(OTIENO)
        for i in items
    )


async def test_gaps_are_capped(ops: Env) -> None:
    ops.clock.set(eat(26, 6, 0))
    data = (await ops.req("GET", "/internal/admin/ops/gaps?hours=96")).json()
    assert len(data["items"]) <= 200
    if data["truncated"]:
        assert len(data["items"]) == 200


async def test_gaps_hours_is_bounded(ops: Env) -> None:
    assert (await ops.req("GET", "/internal/admin/ops/gaps?hours=0")).status_code == 422
    assert (await ops.req("GET", "/internal/admin/ops/gaps?hours=97")).status_code == 422


# --- who may read ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    "path",
    [
        "today",
        "kpis?from=2026-10-27&to=2026-10-28",
        "cancellation-reasons?from=2026-10-27&to=2026-10-28",
        "heatmap?from=2026-10-27&to=2026-10-28",
        "gaps",
    ],
)
async def test_staff_may_read_and_strangers_may_not(ops: Env, path: str) -> None:
    for role in ("owner", "admin", "viewer"):
        assert (await ops.req("GET", f"/internal/admin/ops/{path}", role=role)).status_code == 200
    stranger = await ops.req("GET", f"/internal/admin/ops/{path}", role="none")
    assert stranger.status_code == 403
