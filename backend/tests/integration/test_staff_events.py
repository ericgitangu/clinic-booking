"""Veto, unlock and attendance are events on the stream, written in the same transaction as their
audit row, carrying actor 'staff' and nothing personal; and the relay carries them to the admin
channel only, without stalling."""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import asyncpg
import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI

from app.core.clock import FakeClock
from tests.conftest import FIXED_NOW
from tests.integration.realtime_support import RecordingPublisher, make_realtime_app
from tests.integration.staff_support import (
    KEY,
    OTIENO,
    OWNER,
    PATIENT,
    PATIENT_EMAIL,
    PATIENT_NAME,
    PATIENT_PHONE,
    TUE_10,
    TUE_11,
    Env,
    audit_rows,
)

pytestmark = pytest.mark.asyncio

START = datetime(2026, 10, 27, 7, 0, tzinfo=UTC)  # TUE_10 in Nairobi


async def events(conn: asyncpg.Connection) -> list[tuple[str, str | None]]:
    rows = await conn.fetch("SELECT event_type, actor FROM appointment_events ORDER BY id")
    return [(r["event_type"], r["actor"]) for r in rows]


async def test_veto_of_a_reschedule_is_an_event_and_its_audit_row_commits_with_it(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    appt = await env.patient_book(TUE_10)
    await env.client.patch(f"/appointments/{appt}/reschedule", json={"starts_at": TUE_11})
    veto = await env.req(
        "POST", f"/internal/admin/appointments/{appt}/veto", body={"reason": "doctor is away at 11"}
    )
    assert veto.status_code == 200
    assert await events(owner_conn) == [
        ("booked", "patient"),
        ("rescheduled", "patient"),
        ("rescheduled", "staff"),
        ("vetoed", "staff"),
    ]
    (audit,) = await audit_rows(owner_conn)
    assert audit["action"] == "veto"
    row = await owner_conn.fetchrow("SELECT * FROM appointment_events WHERE event_type = 'vetoed'")
    assert row["appointment_id"] == uuid.UUID(appt) and row["to_starts_at"] == START
    # Nothing in the row can hold a person's details: it has ids, times and a type.
    assert not {"name", "phone", "email"} & {
        k for k in row.keys() if "name" in k or "phone" in k or "email" in k
    }


async def test_veto_of_a_cancel_unlock_and_attendance_are_events(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    appt = await env.patient_book(TUE_10)
    await env.client.patch(f"/appointments/{appt}/cancel", json={"reason": "cannot make it"})
    veto = await env.req(
        "POST", f"/internal/admin/appointments/{appt}/veto", body={"reason": "insured only today"}
    )
    new_id = veto.json()["id"]
    unlock = await env.req(
        "POST", f"/internal/admin/appointments/{new_id}/unlock", body={"reason": "sorted by phone"}
    )
    assert unlock.status_code == 200
    env.clock.set(START)
    assert (
        await env.req("POST", f"/internal/admin/appointments/{new_id}/arrived")
    ).status_code == 200
    flip = await env.req(
        "POST",
        f"/internal/admin/appointments/{new_id}/no-show",
        body={"reason": "left before being seen"},
    )
    assert flip.status_code == 200
    kinds = await events(owner_conn)
    assert kinds == [
        ("booked", "patient"),
        ("cancelled", "patient"),
        ("booked", "staff"),
        ("vetoed", "staff"),
        ("unlocked", "staff"),
        ("arrived", "staff"),
        ("no_show", "staff"),
    ]
    assert len(await audit_rows(owner_conn)) == 4  # veto, unlock, arrived, no_show


async def test_staff_create_cancel_and_reschedule_events_carry_actor_staff(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    created = await env.req(
        "POST",
        "/internal/admin/appointments",
        body={
            "doctor_id": str(OTIENO),
            "patient_id": str(PATIENT),
            "starts_at": TUE_10,
            "reason": "desk booking",
        },
    )
    appt = created.json()["id"]
    await env.req(
        "PATCH",
        f"/internal/admin/appointments/{appt}/reschedule",
        body={"starts_at": TUE_11, "reason": "doctor asked for 11"},
    )
    await env.req(
        "PATCH", f"/internal/admin/appointments/{appt}/cancel", body={"reason": "patient phoned in"}
    )
    assert await events(owner_conn) == [
        ("booked", "staff"),
        ("rescheduled", "staff"),
        ("cancelled", "staff"),
    ]


async def test_a_failed_staff_write_leaves_no_annotation(
    env: Env, owner_conn: asyncpg.Connection
) -> None:
    appt = await env.patient_book(TUE_10)
    env.clock.set(START + timedelta(hours=3))
    late = await env.req("POST", f"/internal/admin/appointments/{appt}/arrived")
    assert late.status_code == 409
    assert await events(owner_conn) == [("booked", "patient")]


@pytest_asyncio.fixture
async def live(
    env: Env, realtime_clean: None
) -> AsyncIterator[tuple[Env, RecordingPublisher, FastAPI]]:
    publisher = RecordingPublisher()
    clock = FakeClock(FIXED_NOW)
    app = make_realtime_app(publisher, clock=clock, INTERNAL_SIGNING_KEY=KEY, ADMIN_EMAILS=OWNER)
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
    )
    yield Env(client, clock), publisher, app
    await client.aclose()


async def test_the_relay_sends_annotations_to_admins_only_and_does_not_stall(
    live: tuple[Env, RecordingPublisher, FastAPI], owner_conn: asyncpg.Connection
) -> None:
    env, publisher, app = live
    appt = await env.patient_book(TUE_10)
    await env.client.patch(f"/appointments/{appt}/reschedule", json={"starts_at": TUE_11})
    await env.req(
        "POST", f"/internal/admin/appointments/{appt}/veto", body={"reason": "doctor is away at 11"}
    )
    await env.req(
        "POST", f"/internal/admin/appointments/{appt}/unlock", body={"reason": "sorted by phone"}
    )
    env.clock.set(START)
    await env.req("POST", f"/internal/admin/appointments/{appt}/arrived")
    await env.req(
        "POST",
        f"/internal/admin/appointments/{appt}/no-show",
        body={"reason": "left before being seen"},
    )
    # every request ran the relay; one more pass picks up anything left
    await app.state.relay.run(env.clock)

    patient = [m for m in publisher.messages if m.channel != "admin:events"]
    admin = [m for m in publisher.messages if m.channel == "admin:events"]
    assert {m.name for m in patient} <= {"slot_taken", "slot_freed"}
    assert not any(m.name in ("vetoed", "unlocked", "arrived", "no_show") for m in patient)
    assert [m.name for m in admin if m.name in ("vetoed", "unlocked", "arrived", "no_show")] == [
        "vetoed",
        "unlocked",
        "arrived",
        "no_show",
    ]
    blob = json.dumps([m.data for m in publisher.messages])
    for secret in (PATIENT_NAME, PATIENT_PHONE, PATIENT_EMAIL, "Zainab"):
        assert secret not in blob
    # The cursor moved past every event: nothing is left pending.
    pending = await owner_conn.fetchval(
        "SELECT count(*) FROM appointment_events e, event_relay_cursor c "
        "WHERE (e.txid, e.id) > (c.txid, c.id)"
    )
    assert pending == 0
    before = len(publisher.messages)
    await app.state.relay.run(env.clock)
    assert len(publisher.messages) == before
