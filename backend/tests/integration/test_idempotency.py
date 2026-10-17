"""Idempotency-Key on POST /appointments and POST /internal/me/appointments."""

from __future__ import annotations

import asyncpg
import httpx
import pytest

from tests.conftest import seeded_doctor_id, seeded_patient_id

pytestmark = pytest.mark.asyncio

OTIENO = str(seeded_doctor_id("otieno"))
KAMAU = str(seeded_doctor_id("kamau"))
AMINA = str(seeded_patient_id("amina"))
BRIAN = str(seeded_patient_id("brian"))
AT = "2026-10-26T09:00:00+03:00"
AT_UTC = "2026-10-26T06:00:00Z"  # the same instant, written another way
LATER = "2026-10-26T10:00:00+03:00"


def _body(doctor: str = OTIENO, patient: str = AMINA, starts_at: str = AT) -> dict[str, str]:
    return {"doctor_id": doctor, "patient_id": patient, "starts_at": starts_at}


def _key(key: str) -> dict[str, str]:
    return {"Idempotency-Key": key}


async def test_replay_returns_the_original_201_and_creates_no_second_row(
    client: httpx.AsyncClient, reset_appointments: None, owner_conn: asyncpg.Connection
) -> None:
    first = await client.post("/appointments", json=_body(), headers=_key("k-replay-1"))
    assert first.status_code == 201, first.text
    assert "idempotent-replayed" not in first.headers

    again = await client.post("/appointments", json=_body(), headers=_key("k-replay-1"))
    assert again.status_code == 201, again.text
    assert again.headers["idempotent-replayed"] == "true"
    assert again.headers["location"] == first.headers["location"]
    assert again.json() == first.json()
    assert await owner_conn.fetchval("SELECT count(*) FROM appointments") == 1


async def test_replay_matches_the_same_instant_written_with_another_offset(
    client: httpx.AsyncClient, reset_appointments: None
) -> None:
    first = await client.post("/appointments", json=_body(), headers=_key("k-offset"))
    again = await client.post(
        "/appointments", json=_body(starts_at=AT_UTC), headers=_key("k-offset")
    )
    assert again.status_code == 201
    assert again.json()["id"] == first.json()["id"]


async def test_same_key_other_time_or_doctor_is_key_reused(
    client: httpx.AsyncClient, reset_appointments: None
) -> None:
    assert (
        await client.post("/appointments", json=_body(), headers=_key("k-reuse"))
    ).status_code == 201
    for other in (_body(starts_at=LATER), _body(doctor=KAMAU)):
        resp = await client.post("/appointments", json=other, headers=_key("k-reuse"))
        assert resp.status_code == 422, resp.text
        assert resp.headers["content-type"].startswith("application/problem+json")
        assert resp.json()["code"] == "IDEMPOTENCY_KEY_REUSED"


async def test_key_is_scoped_to_the_patient(
    client: httpx.AsyncClient, reset_appointments: None
) -> None:
    a = await client.post("/appointments", json=_body(), headers=_key("k-shared"))
    b = await client.post(
        "/appointments", json=_body(patient=BRIAN, starts_at=LATER), headers=_key("k-shared")
    )
    assert a.status_code == 201 and b.status_code == 201
    assert a.json()["id"] != b.json()["id"]


async def test_replay_after_cancel_is_key_consumed(
    client: httpx.AsyncClient, reset_appointments: None
) -> None:
    first = await client.post("/appointments", json=_body(), headers=_key("k-consumed"))
    cancel = await client.patch(
        f"/appointments/{first.json()['id']}/cancel", json={"reason": "changed my mind"}
    )
    assert cancel.status_code == 200
    again = await client.post("/appointments", json=_body(), headers=_key("k-consumed"))
    assert again.status_code == 409
    assert again.json()["code"] == "IDEMPOTENCY_KEY_CONSUMED"


async def test_replay_after_reschedule_returns_the_current_representation(
    client: httpx.AsyncClient, reset_appointments: None
) -> None:
    first = await client.post("/appointments", json=_body(), headers=_key("k-moved"))
    moved = await client.patch(
        f"/appointments/{first.json()['id']}/reschedule", json={"starts_at": LATER}
    )
    assert moved.status_code == 200
    again = await client.post("/appointments", json=_body(), headers=_key("k-moved"))
    assert again.status_code == 201
    assert again.headers["idempotent-replayed"] == "true"
    assert again.json()["id"] == first.json()["id"]
    assert again.json()["starts_at"] == moved.json()["starts_at"]


async def test_lost_response_retry_is_not_slot_taken(
    client: httpx.AsyncClient, reset_appointments: None
) -> None:
    # Without a key the retry of a booking the caller already holds is a conflict; with one it is
    # the original booking.
    first = await client.post("/appointments", json=_body(), headers=_key("k-lost"))
    unkeyed = await client.post("/appointments", json=_body())
    assert unkeyed.status_code == 409
    retry = await client.post("/appointments", json=_body(), headers=_key("k-lost"))
    assert retry.status_code == 201
    assert retry.json()["id"] == first.json()["id"]


async def test_other_patient_with_the_same_slot_still_gets_slot_taken(
    client: httpx.AsyncClient, reset_appointments: None
) -> None:
    await client.post("/appointments", json=_body(), headers=_key("k-a"))
    resp = await client.post("/appointments", json=_body(patient=BRIAN), headers=_key("k-b"))
    assert resp.status_code == 409
    assert resp.json()["code"] == "SLOT_TAKEN"


async def test_a_failed_attempt_does_not_use_up_the_key(
    client: httpx.AsyncClient, reset_appointments: None
) -> None:
    bad = await client.post(
        "/appointments", json=_body(starts_at="2026-10-26T09:10:00+03:00"), headers=_key("k-retry")
    )
    assert bad.status_code == 422
    good = await client.post("/appointments", json=_body(), headers=_key("k-retry"))
    assert good.status_code == 201


@pytest.mark.parametrize("bad", ["", "a" * 256, "has space", "tab\there", "naïve"])
async def test_a_malformed_key_is_a_validation_error(
    client: httpx.AsyncClient, reset_appointments: None, bad: str
) -> None:
    try:
        resp = await client.post("/appointments", json=_body(), headers=_key(bad))
    except (UnicodeEncodeError, httpx.InvalidURL):  # header cannot even be encoded
        return
    assert resp.status_code == 422, resp.text
    assert resp.json()["code"] == "VALIDATION_ERROR"


async def test_the_longest_valid_key_is_accepted(
    client: httpx.AsyncClient, reset_appointments: None
) -> None:
    resp = await client.post("/appointments", json=_body(), headers=_key("x" * 255))
    assert resp.status_code == 201


async def test_the_key_and_fingerprint_are_stored_on_the_row(
    client: httpx.AsyncClient, reset_appointments: None, owner_conn: asyncpg.Connection
) -> None:
    await client.post("/appointments", json=_body(), headers=_key("k-stored"))
    row = await owner_conn.fetchrow("SELECT idempotency_key, request_fingerprint FROM appointments")
    assert row is not None
    assert row["idempotency_key"] == "k-stored"
    assert len(row["request_fingerprint"]) == 64


async def test_a_booking_without_a_key_stores_neither_column(
    client: httpx.AsyncClient, reset_appointments: None, owner_conn: asyncpg.Connection
) -> None:
    await client.post("/appointments", json=_body())
    row = await owner_conn.fetchrow("SELECT idempotency_key, request_fingerprint FROM appointments")
    assert row is not None
    assert row["idempotency_key"] is None
    assert row["request_fingerprint"] is None


async def test_reschedule_retry_is_already_idempotent_without_a_key(
    client: httpx.AsyncClient, reset_appointments: None
) -> None:
    # Keys are scoped to POST. A lost reschedule response retried with the same body is the
    # same-start no-op: 200 with the same representation, never a conflict with itself.
    first = await client.post("/appointments", json=_body())
    path = f"/appointments/{first.json()['id']}/reschedule"
    one = await client.patch(path, json={"starts_at": LATER})
    two = await client.patch(path, json={"starts_at": LATER})
    assert one.status_code == two.status_code == 200
    assert one.json() == two.json()
