"""Idempotency: a lost response then a retry with the same key yields the original
201, never SLOT_TAKEN; and a burst of concurrent duplicates books exactly once."""

from __future__ import annotations

import httpx
import pytest

from app.services import booking
from tests.concurrency.harness import (
    LockSampler,
    count_booked_at,
    make_race_app,
    pg_sleep_after_write,
    race,
)
from tests.conftest import TEST_PUBLIC_BASE_URL, seeded_doctor_id, seeded_patient_id

pytestmark = [pytest.mark.asyncio, pytest.mark.race]

OTIENO = str(seeded_doctor_id("otieno"))
AMINA = str(seeded_patient_id("amina"))
AT = "2026-10-26T09:00:00+03:00"
N = 12


def _body() -> dict[str, str]:
    return {"doctor_id": OTIENO, "patient_id": AMINA, "starts_at": AT}


async def test_lost_response_then_retry_returns_the_original_201(
    reset_appointments: None,
) -> None:
    app = make_race_app()
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    headers = {"Idempotency-Key": "lost-response-1"}
    async with httpx.AsyncClient(transport=transport, base_url=TEST_PUBLIC_BASE_URL) as c:
        # The server commits the booking; the caller never reads the response (it was lost).
        lost = await c.post("/appointments", json=_body(), headers=headers)
        assert lost.status_code == 201
        original_id = lost.json()["id"]
        del lost

        retry = await c.post("/appointments", json=_body(), headers=headers)
        assert retry.status_code == 201, retry.text
        assert retry.json()["id"] == original_id
        assert retry.headers["idempotent-replayed"] == "true"

        # The same retry without a key is what the key exists to prevent: a conflict with itself.
        keyless = await c.post("/appointments", json=_body())
        assert keyless.status_code == 409
        assert keyless.json()["code"] == "PATIENT_DOUBLE_BOOKED" or keyless.json()["code"] == (
            "SLOT_TAKEN"
        )
    assert await count_booked_at(OTIENO, AT) == 1


async def test_concurrent_duplicates_book_once_and_all_get_the_original(
    reset_appointments: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(booking, "_after_write", pg_sleep_after_write)
    app = make_race_app()

    async def task(client: httpx.AsyncClient, i: int) -> httpx.Response:
        return await client.post(
            "/appointments", json=_body(), headers={"Idempotency-Key": "burst-1"}
        )

    async with LockSampler() as sampler:
        responses = await race(app, task, N)

    assert [r.status_code for r in responses] == [201] * N, [
        (r.status_code, r.text) for r in responses
    ]
    assert len({r.json()["id"] for r in responses}) == 1
    fresh = [r for r in responses if "idempotent-replayed" not in r.headers]
    replayed = [r for r in responses if r.headers.get("idempotent-replayed") == "true"]
    assert len(fresh) == 1 and len(replayed) == N - 1
    assert await count_booked_at(OTIENO, AT) == 1
    assert sampler.peak >= 1, "the duplicates never overlapped on the uniqueness check"
