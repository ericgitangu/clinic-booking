"""The availability cursor and weak ETag: what lets a client order a poll against pushed events."""

from __future__ import annotations

import asyncpg
import httpx
import pytest

from app.domain.realtime import parse_cursor
from tests.conftest import seeded_doctor_id, seeded_patient_id

pytestmark = pytest.mark.asyncio

OTIENO = seeded_doctor_id("otieno")
AMINA = seeded_patient_id("amina")
DAY = "2026-10-26"
URL = f"/doctors/{OTIENO}/availability?date={DAY}"


async def test_the_response_carries_a_well_formed_cursor_and_a_weak_etag(
    client: httpx.AsyncClient,
) -> None:
    resp = await client.get(URL)
    body = resp.json()
    txid, event_id = parse_cursor(body["cursor"])
    assert txid > 0 and event_id == 0
    assert resp.headers["etag"].startswith('W/"') and resp.headers["etag"].endswith('"')
    assert resp.headers["cache-control"] == "no-store"


async def test_the_cursor_never_goes_backwards_between_polls(client: httpx.AsyncClient) -> None:
    seen = [parse_cursor((await client.get(URL)).json()["cursor"]) for _ in range(5)]
    assert seen == sorted(seen)


async def test_an_unchanged_grid_answers_304_even_though_the_cursor_moved(
    client: httpx.AsyncClient,
) -> None:
    first = await client.get(URL)
    tag = first.headers["etag"]
    again = await client.get(URL, headers={"If-None-Match": tag})
    assert again.status_code == 304 and again.content == b"" and again.headers["etag"] == tag
    assert again.headers["cache-control"] == "no-store"
    # Weak comparison, lists, and the wildcard.
    assert (
        await client.get(URL, headers={"If-None-Match": tag.removeprefix("W/")})
    ).status_code == 304
    assert (await client.get(URL, headers={"If-None-Match": f'"x", {tag}'})).status_code == 304
    assert (await client.get(URL, headers={"If-None-Match": "*"})).status_code == 304
    assert (await client.get(URL, headers={"If-None-Match": 'W/"stale"'})).status_code == 200


async def test_a_booking_changes_the_etag_and_the_new_cursor_is_not_older(
    client: httpx.AsyncClient, reset_appointments: None, owner_conn: asyncpg.Connection
) -> None:
    before = await client.get(URL)
    slot = before.json()["slots"][0]["starts_at"]
    booked = await client.post(
        "/appointments",
        json={"doctor_id": str(OTIENO), "patient_id": str(AMINA), "starts_at": slot},
    )
    assert booked.status_code == 201
    stale = await client.get(URL, headers={"If-None-Match": before.headers["etag"]})
    assert stale.status_code == 200, "the old tag no longer matches: the slot is gone"
    after = stale.json()
    assert slot not in [s["starts_at"] for s in after["slots"]]
    assert stale.headers["etag"] != before.headers["etag"]
    assert parse_cursor(after["cursor"]) >= parse_cursor(before.json()["cursor"])

    # Everything at or before the cursor is reflected in the slots: the booking's event sorts
    # before the cursor, so a client holding this response need not apply it again.
    row = await owner_conn.fetchrow("SELECT txid::text AS txid, id FROM appointment_events")
    assert row is not None
    assert (int(row["txid"]), int(row["id"])) <= parse_cursor(after["cursor"])


async def test_an_unknown_doctor_is_still_a_404_and_has_no_etag(client: httpx.AsyncClient) -> None:
    resp = await client.get(f"/doctors/{AMINA}/availability?date={DAY}")
    assert resp.status_code == 404 and "etag" not in resp.headers
