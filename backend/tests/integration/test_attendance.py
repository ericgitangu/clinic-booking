"""Arrival and no-show: the time window, who may record it, corrections, and the audit trail."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import asyncpg
import pytest

from tests.integration.staff_support import TUE_10, Env, audit_rows

pytestmark = pytest.mark.asyncio

START = datetime(2026, 10, 27, 7, 0, tzinfo=UTC)  # TUE_10 in Nairobi


def path(appt: str, what: str) -> str:
    return f"/internal/admin/appointments/{appt}/{what}"


async def booked(env: Env) -> str:
    return await env.patient_book(TUE_10)


ARRIVED_WINDOW = [
    (timedelta(minutes=-16), False),
    (timedelta(minutes=-15, seconds=-1), False),
    (timedelta(minutes=-15), True),
    (timedelta(0), True),
    (timedelta(hours=2), True),
    (timedelta(hours=2, seconds=1), False),
    (timedelta(hours=3), False),
]
# A patient cannot be a no-show for a visit that has not started.
NO_SHOW_WINDOW = [
    (timedelta(minutes=-15), False),
    (timedelta(seconds=-1), False),
    (timedelta(0), True),
    (timedelta(hours=2), True),
    (timedelta(hours=2, seconds=1), False),
    (timedelta(hours=3), False),
]


@pytest.mark.parametrize(
    ("what", "offset", "ok"),
    [("arrived", o, ok) for o, ok in ARRIVED_WINDOW]
    + [("no-show", o, ok) for o, ok in NO_SHOW_WINDOW],
)
async def test_the_attendance_window_boundaries(
    env: Env, what: str, offset: timedelta, ok: bool
) -> None:
    appt = await booked(env)
    env.clock.set(START + offset)
    resp = await env.req("POST", path(appt, what), role="admin")
    if ok:
        assert resp.status_code == 200, resp.text
        assert resp.json()["audit_id"]
    else:
        assert resp.status_code == 409
        assert resp.json()["code"] == "ATTENDANCE_WINDOW_CLOSED"


async def test_a_viewer_cannot_record_attendance(env: Env) -> None:
    appt = await booked(env)
    env.clock.set(START)
    for what in ("arrived", "no-show"):
        resp = await env.req("POST", path(appt, what), role="viewer")
        assert resp.status_code == 403


async def test_a_cancelled_appointment_has_no_attendance(env: Env) -> None:
    appt = await booked(env)
    await env.client.patch(f"/appointments/{appt}/cancel", json={"reason": "cannot make it"})
    env.clock.set(START)
    resp = await env.req("POST", path(appt, "arrived"))
    assert resp.status_code == 409
    assert resp.json()["code"] == "APPOINTMENT_ALREADY_CANCELLED"


async def test_marking_twice_changes_nothing_and_a_change_needs_a_reason(
    env: Env,
    owner_conn: asyncpg.Connection,
) -> None:
    appt = await booked(env)
    env.clock.set(START)
    first = await env.req("POST", path(appt, "arrived"))
    again = await env.req("POST", path(appt, "arrived"))
    assert first.json()["audit_id"] and again.status_code == 200
    assert again.json()["audit_id"] is None
    flip = await env.req("POST", path(appt, "no-show"))
    assert flip.status_code == 422
    short = await env.req("POST", path(appt, "no-show"), body={"reason": "ab"})
    assert short.status_code == 422
    ok = await env.req("POST", path(appt, "no-show"), body={"reason": "left before being seen"})
    assert ok.status_code == 200, ok.text
    rows = await owner_conn.fetch("SELECT kind, marked_by FROM appointment_attendance ORDER BY id")
    assert [r["kind"] for r in rows] == ["arrived", "no_show"]
    audit = await audit_rows(owner_conn)
    assert [r["action"] for r in audit] == ["arrived", "no_show"]
    assert audit[1]["reason"] == "left before being seen"
    assert audit[0]["reason"] == "Marked arrived at the desk"
    assert '"attendance": "arrived"' in audit[1]["before"].replace('":"', '": "')


async def test_a_short_reason_on_a_first_mark_is_refused(env: Env) -> None:
    appt = await booked(env)
    env.clock.set(START)
    resp = await env.req("POST", path(appt, "arrived"), body={"reason": "x"})
    assert resp.status_code == 422


async def test_unknown_appointment(env: Env) -> None:
    env.clock.set(START)
    resp = await env.req("POST", path(str(uuid.uuid4()), "arrived"))
    assert resp.status_code == 404


async def test_attendance_rows_cannot_be_edited_by_the_app_role(
    env: Env,
    app_conn: asyncpg.Connection,
) -> None:
    appt = await booked(env)
    env.clock.set(START)
    await env.req("POST", path(appt, "arrived"))
    for statement in (
        "UPDATE appointment_attendance SET kind = 'no_show'",
        "DELETE FROM appointment_attendance",
    ):
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await app_conn.execute(statement)


async def test_the_list_carries_the_latest_attendance(env: Env) -> None:
    appt = await booked(env)
    env.clock.set(START)
    before = (await env.req("GET", "/internal/admin/appointments", role="viewer")).json()
    assert before["items"][0]["attendance"] is None
    await env.req("POST", path(appt, "no-show"))
    after = (await env.req("GET", "/internal/admin/appointments", role="viewer")).json()
    assert after["items"][0]["attendance"] == "no_show"
