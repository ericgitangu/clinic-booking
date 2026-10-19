"""The drill-down reads behind the dashboard's numbers, on real Postgres: ``/ops/changes``, the
single admin appointment, and ``patient_changed`` on the Today board.

Every count here is checked against the number it explains: reschedules against the KPI, cancels
against the reasons chart and each category, and every kind against the metrics series point.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Any

import asyncpg
import pytest

from tests.integration.staff_support import OTIENO, TUE_10, TUE_11, Env
from tests.integration.test_ops import (
    DEMO,
    KAMAU,
    REAL,
    REAL_NAME,
    REAL_PHONE,
    SYNTH,
    add,
    eat,
    ops,
)

pytestmark = pytest.mark.asyncio

__all__ = ["ops"]  # the fixture is shared with test_ops

BASE = "/internal/admin/ops/changes"
DAY = "from=2026-10-27&to=2026-10-28"


async def event(
    conn: asyncpg.Connection,
    appt: uuid.UUID,
    kind: str,
    at: datetime,
    *,
    doctor: uuid.UUID = OTIENO,
    actor: str | None = "patient",
    was: datetime | None = None,
    now: datetime | None = None,
) -> int:
    event_id: int = await conn.fetchval(
        "INSERT INTO appointment_events (appointment_id, doctor_id, event_type, from_starts_at, "
        "to_starts_at, local_date, occurred_at, actor) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
        appt,
        doctor,
        kind,
        was,
        now,
        (at + timedelta(hours=3)).date(),
        at,
        actor,
    )
    return event_id


async def cancelled(
    conn: asyncpg.Connection, patient: uuid.UUID, at: datetime, reason: str | None, hour: int
) -> int:
    appt = await add(
        conn, OTIENO, patient, eat(30, hour), status="cancelled", reason=reason, cancelled_at=at
    )
    return await event(conn, appt, "cancelled", at, was=eat(30, hour))


async def seed(conn: asyncpg.Connection) -> dict[str, Any]:
    """Changes on the 26th to the 28th (Nairobi); the visits are all on the 30th, so the day a
    change happened and the day of its visit never coincide."""
    out: dict[str, Any] = {}
    n = 8
    for key, at, patient in [
        ("r_before", eat(26, 23, 59), REAL),  # 26th, one minute short of the day
        ("r_start", eat(27, 0, 0), REAL),  # first instant of the 27th
        ("r_demo", eat(27, 12, 0), DEMO),  # demo patients are included
        ("r_end", eat(27, 23, 59), REAL),  # last minute of the 27th
        ("r_after", eat(28, 0, 0), REAL),  # first instant of the 28th
        ("r_synth", eat(27, 12, 0), SYNTH),  # excluded
    ]:
        appt = await add(conn, OTIENO, patient, eat(30, n))
        n += 1
        was, now = eat(30, 7), eat(30, n - 1)
        out[key] = await event(conn, appt, "rescheduled", at, was=was, now=now, actor="staff")
        out[key + "_appt"] = appt
    for i, (kind, at) in enumerate(
        [("booked", eat(27, 8)), ("booked", eat(27, 9)), ("booked", eat(28, 1))]
    ):
        appt = await add(conn, KAMAU, REAL, eat(31, 8 + i))
        out[f"b{i}"] = await event(conn, appt, kind, at, doctor=KAMAU, now=eat(31, 8 + i))
    synth_book = await add(conn, OTIENO, SYNTH, eat(31, 12))
    await event(conn, synth_book, "booked", eat(27, 9), now=eat(31, 12))
    out["c_transport"] = await cancelled(conn, REAL, eat(27, 8), "bus broke down", 9)
    out["c_illness"] = await cancelled(conn, DEMO, eat(27, 9), "I was sick", 10)
    out["c_weather"] = await cancelled(conn, REAL, eat(27, 10), "rain", 11)
    out["c_better"] = await cancelled(conn, REAL, eat(27, 11), "felt much better", 12)
    out["c_other"] = await cancelled(conn, REAL, eat(27, 12), None, 13)
    out["c_next_day"] = await cancelled(conn, REAL, eat(28, 9), "sick", 14)
    await cancelled(conn, SYNTH, eat(27, 9), "sick", 15)  # excluded
    return out


async def get(env: Env, query: str, role: str = "owner") -> dict[str, Any]:
    resp = await env.req("GET", f"{BASE}?{query}", role=role)
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    return body


# --- the day a change happened, not the day of the visit ------------------------------------


async def test_changes_are_placed_by_the_day_they_happened_in_nairobi(
    ops: Env, owner_conn: asyncpg.Connection
) -> None:
    ids = await seed(owner_conn)
    body = await get(ops, f"kind=rescheduled&{DAY}")
    got = [i["appointment_id"] for i in body["items"]]
    # 00:00 and 23:59 of the 27th are in, 23:59 of the 26th and 00:00 of the 28th are out; the
    # synthetic patient's reschedule at noon is out; the demo patient's is in. Newest first.
    assert got == [
        str(ids["r_end_appt"]),
        str(ids["r_demo_appt"]),
        str(ids["r_start_appt"]),
    ]
    assert body["total"] == 3
    # The visits are on the 30th: the same call over the 30th finds none of these.
    none = await get(ops, "kind=rescheduled&from=2026-10-30&to=2026-10-31")
    assert none["total"] == 0 and none["items"] == []
    first = body["items"][2]
    assert first["occurred_at"].startswith("2026-10-27T00:00:00+03:00")
    assert first["kind"] == "rescheduled" and first["actor"] == "staff"
    assert first["from_starts_at"] and first["to_starts_at"]
    assert first["starts_at"].startswith("2026-10-30")  # where it stands now
    assert body["range"] == {"from": "2026-10-27", "to": "2026-10-28"}


async def test_only_reschedules_carry_from_and_to(ops: Env, owner_conn: asyncpg.Connection) -> None:
    await seed(owner_conn)
    body = await get(ops, f"kind=booked&{DAY}")
    assert body["total"] == 2 and body["view"] == "full"
    for item in body["items"]:
        assert item["from_starts_at"] is None and item["to_starts_at"] is None
        assert item["reason"] is None and item["reason_category"] is None
        assert item["doctor_name"] and item["status"] == "booked"


async def test_the_doctor_filter(ops: Env, owner_conn: asyncpg.Connection) -> None:
    await seed(owner_conn)
    only = await get(ops, f"kind=booked&{DAY}&doctor_id={KAMAU}")
    assert only["total"] == 2
    none = await get(ops, f"kind=booked&{DAY}&doctor_id={OTIENO}")
    assert none["total"] == 0


# --- agreement with the numbers the lists explain --------------------------------------------


async def test_totals_agree_with_the_kpi_the_reasons_chart_and_the_metrics_series(
    ops: Env, owner_conn: asyncpg.Connection
) -> None:
    await seed(owner_conn)
    kpis = (await ops.req("GET", f"/internal/admin/ops/kpis?{DAY}")).json()
    reasons = (await ops.req("GET", f"/internal/admin/ops/cancellation-reasons?{DAY}")).json()
    metrics = (await ops.req("GET", f"/internal/admin/metrics?{DAY}&bucket=day")).json()
    (point,) = metrics["series"]
    assert point["bucket_start"] == "2026-10-27T00:00:00"

    resched = await get(ops, f"kind=rescheduled&{DAY}")
    assert resched["total"] == kpis["reschedules"]["value"] == point["rescheduled"] == 3
    cancels = await get(ops, f"kind=cancelled&{DAY}")
    assert cancels["total"] == reasons["total"] == point["cancelled"] == 5
    assert (await get(ops, f"kind=booked&{DAY}"))["total"] == point["booked"] == 2

    assert reasons["total"] == 5
    for share in reasons["items"]:
        by_reason = await get(ops, f"kind=cancelled&{DAY}&reason={share['category']}")
        assert by_reason["total"] == share["count"], share["category"]
        assert len(by_reason["items"]) == share["count"]
        assert {i["reason_category"] for i in by_reason["items"]} <= {share["category"]}
    assert (await get(ops, f"kind=cancelled&{DAY}&reason=transport"))["items"][0]["reason"] == (
        "bus broke down"
    )


async def test_a_wider_range_agrees_with_the_series_day_by_day(
    ops: Env, owner_conn: asyncpg.Connection
) -> None:
    await seed(owner_conn)
    wide = "from=2026-10-26&to=2026-10-29"
    metrics = (await ops.req("GET", f"/internal/admin/metrics?{wide}&bucket=day")).json()
    for point in metrics["series"]:
        day = point["bucket_start"][:10]
        nxt = (datetime.fromisoformat(day) + timedelta(days=1)).date().isoformat()
        for kind in ("booked", "rescheduled", "cancelled"):
            got = await get(ops, f"kind={kind}&from={day}&to={nxt}")
            assert got["total"] == point[kind], (day, kind)


# --- who sees what ---------------------------------------------------------------------------


async def test_roles(ops: Env, owner_conn: asyncpg.Connection) -> None:
    await seed(owner_conn)
    for role in ("owner", "admin"):
        body = await get(ops, f"kind=cancelled&{DAY}", role)
        assert body["view"] == "full"
        assert any(i["patient_name"] == REAL_NAME for i in body["items"])
        assert "bus broke down" in {i["reason"] for i in body["items"]}
    resp = await ops.req("GET", f"{BASE}?kind=cancelled&{DAY}", role="viewer")
    assert resp.status_code == 200
    viewer = resp.json()
    assert viewer["view"] == "minimised" and viewer["total"] == 5
    assert {i["patient_name"] for i in viewer["items"]} == {"A. O.", "D. P."}
    assert all(i["reason"] is None for i in viewer["items"])
    assert REAL_NAME not in resp.text and REAL_PHONE not in resp.text
    assert "amani@example.com" not in resp.text and "bus broke down" not in resp.text
    # The category is a grouping, not the text, and stays.
    assert "transport" in {i["reason_category"] for i in viewer["items"]}
    none = await ops.req("GET", f"{BASE}?kind=cancelled&{DAY}", role="none")
    assert none.status_code == 403


# --- paging ----------------------------------------------------------------------------------


async def test_paging_is_stable_over_ties_and_the_total_ignores_it(
    ops: Env, owner_conn: asyncpg.Connection
) -> None:
    same = eat(27, 10, 0)  # seven changes in the same instant: only the id breaks the tie
    wanted = []
    for h in range(7):
        appt = await add(owner_conn, OTIENO, REAL, eat(30, 8 + h))
        wanted.append(
            await event(owner_conn, appt, "rescheduled", same, was=eat(30, 7), now=eat(30, 8 + h))
        )
    seen: list[str] = []
    cursor = ""
    pages = 0
    while True:
        body = await get(ops, f"kind=rescheduled&{DAY}&limit=3{cursor}")
        assert body["total"] == 7  # independent of the page
        assert len(body["items"]) <= 3
        seen += [i["appointment_id"] for i in body["items"]]
        pages += 1
        if body["next_cursor"] is None:
            break
        cursor = f"&cursor={body['next_cursor']}"
    assert pages == 3 and len(seen) == len(set(seen)) == 7
    by_event = {
        str(r["appointment_id"]): r["id"]
        for r in await owner_conn.fetch("SELECT id, appointment_id FROM appointment_events")
    }
    assert [by_event[a] for a in seen] == sorted(wanted, reverse=True)
    # A change landing between two page reads does not shift the pages already read.
    first = await get(ops, f"kind=rescheduled&{DAY}&limit=3")
    appt = await add(owner_conn, OTIENO, REAL, eat(30, 16))
    await event(owner_conn, appt, "rescheduled", eat(27, 11), was=eat(30, 7), now=eat(30, 16))
    rest = await get(ops, f"kind=rescheduled&{DAY}&limit=50&cursor={first['next_cursor']}")
    assert [i["appointment_id"] for i in rest["items"]] == seen[3:]


async def test_a_page_that_ends_exactly_has_no_next_cursor(
    ops: Env, owner_conn: asyncpg.Connection
) -> None:
    await seed(owner_conn)
    body = await get(ops, f"kind=rescheduled&{DAY}&limit=3")
    assert len(body["items"]) == 3 and body["next_cursor"] is None


# --- validation ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "query",
    [
        DAY,  # no kind
        f"kind=moved&{DAY}",
        f"kind=rescheduled&{DAY}&reason=transport",  # a reason is for cancellations only
        f"kind=cancelled&{DAY}&reason=boredom",
        f"kind=cancelled&{DAY}&limit=0",
        f"kind=cancelled&{DAY}&limit=101",
        f"kind=cancelled&{DAY}&cursor=nonsense",
        "kind=cancelled&from=2026-10-28&to=2026-10-28",
        "kind=cancelled&from=2026-01-01&to=2026-12-31",
        "kind=cancelled&from=2026-10-27",
        f"kind=cancelled&{DAY}&doctor_id=not-a-uuid",
    ],
)
async def test_bad_queries_are_problem_json_422(ops: Env, query: str) -> None:
    resp = await ops.req("GET", f"{BASE}?{query}")
    assert resp.status_code == 422, resp.text
    assert resp.headers["content-type"].startswith("application/problem+json")


# --- one appointment -------------------------------------------------------------------------


async def test_one_appointment_is_the_list_item_for_each_role(
    ops: Env, owner_conn: asyncpg.Connection
) -> None:
    appt = await add(
        owner_conn, OTIENO, REAL, eat(30, 9), status="cancelled", reason="sick", attendance=None
    )
    for role in ("owner", "admin", "viewer"):
        listed = (
            await ops.req("GET", "/internal/admin/appointments?status=all&limit=100", role=role)
        ).json()
        (item,) = [i for i in listed["items"] if i["id"] == str(appt)]
        resp = await ops.req("GET", f"/internal/admin/appointments/{appt}", role=role)
        assert resp.status_code == 200, resp.text
        assert resp.json() == item
        assert resp.headers["cache-control"] == "no-store"
    viewer = (await ops.req("GET", f"/internal/admin/appointments/{appt}", role="viewer")).json()
    assert viewer["patient_name"] == "A. O." and viewer["patient_email"] is None
    assert viewer["cancellation_reason"] is None and viewer["patient_phone"] == "+**********33"
    full = (await ops.req("GET", f"/internal/admin/appointments/{appt}")).json()
    assert full["patient_name"] == REAL_NAME and full["cancellation_reason"] == "sick"
    assert full["staff_locked"] is False and "attendance" in full
    assert (
        await ops.req("GET", f"/internal/admin/appointments/{appt}", role="none")
    ).status_code == 403


async def test_a_synthetic_or_unknown_appointment_is_404(
    ops: Env, owner_conn: asyncpg.Connection
) -> None:
    synth = await add(owner_conn, OTIENO, SYNTH, eat(30, 9))
    for target in (synth, uuid.uuid4()):
        resp = await ops.req("GET", f"/internal/admin/appointments/{target}")
        assert resp.status_code == 404, resp.text
        assert resp.headers["content-type"].startswith("application/problem+json")
    bad = await ops.req("GET", "/internal/admin/appointments/not-a-uuid")
    assert bad.status_code == 422


# --- patient_changed on the Today board ------------------------------------------------------


async def changed(env: Env) -> dict[str, bool]:
    board = (await env.req("GET", "/internal/admin/ops/today?date=2026-10-27")).json()
    return {a["id"]: a["patient_changed"] for d in board["doctors"] for a in d["appointments"]}


async def veto(env: Env, appt: str) -> Any:
    return await env.req(
        "POST", f"/internal/admin/appointments/{appt}/veto", body={"reason": "settled by phone"}
    )


async def test_patient_changed_follows_the_veto_rule(env: Env) -> None:
    # A booking nobody changed: the patient's own first booking is not a change to veto.
    plain = await env.patient_book(TUE_10)
    assert (await changed(env)) == {plain: False}

    # The patient moves it: vetoable, so the row shows it.
    assert (
        await env.client.patch(f"/appointments/{plain}/reschedule", json={"starts_at": TUE_11})
    ).status_code == 200
    assert (await changed(env))[plain] is True

    # Staff then moves it: the latest change is staff's, so there is nothing to veto.
    staff_move = await env.req(
        "PATCH",
        f"/internal/admin/appointments/{plain}/reschedule",
        body={"starts_at": TUE_10, "reason": "back to ten"},
    )
    assert staff_move.status_code == 200
    assert (await changed(env))[plain] is False
    assert (await veto(env, plain)).status_code == 409  # the board and the action agree


async def test_patient_changed_after_a_veto_or_a_cancel(env: Env) -> None:
    moved = await env.patient_book(TUE_10)
    await env.client.patch(f"/appointments/{moved}/reschedule", json={"starts_at": TUE_11})
    assert (await changed(env))[moved] is True
    assert (await veto(env, moved)).status_code == 200
    # Vetoed and locked: the latest change is now staff's.
    assert (await changed(env))[moved] is False
    locked = (await env.req("GET", f"/internal/admin/appointments/{moved}")).json()
    assert locked["staff_locked"] is True


async def test_a_cancel_by_the_patient_is_vetoable_until_staff_rebook(env: Env) -> None:
    appt = await env.patient_book(TUE_10)
    cancel = await env.client.patch(f"/appointments/{appt}/cancel", json={"reason": "cannot go"})
    assert cancel.status_code == 200
    assert (await changed(env))[appt] is True
    rebooked = await veto(env, appt)
    assert rebooked.status_code == 200
    new_id = rebooked.json()["id"]
    state = await changed(env)
    assert state[appt] is False  # the cancelled row now has a successor
    assert state[new_id] is False  # the locked replacement's only change is staff's


async def test_a_cancel_by_staff_is_not_vetoable(env: Env) -> None:
    appt = await env.patient_book(TUE_10)
    done = await env.req(
        "PATCH",
        f"/internal/admin/appointments/{appt}/cancel",
        body={"reason": "doctor unwell"},
    )
    assert done.status_code == 200, done.text
    assert (await changed(env))[appt] is False


async def test_the_pre_actor_event_is_not_vetoable(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    appt = await env.patient_book(TUE_10)
    await env.client.patch(f"/appointments/{appt}/reschedule", json={"starts_at": TUE_11})
    await owner_conn.execute(
        "UPDATE appointment_events SET actor = NULL WHERE appointment_id = $1 "
        "AND event_type = 'rescheduled'",
        uuid.UUID(appt),
    )
    assert (await changed(env))[appt] is False
    assert (await veto(env, appt)).status_code == 409
