"""25 concurrent POSTs for one slot produce exactly one booking (one 201, the rest 409)."""

from __future__ import annotations

import httpx
import pytest

from app.services import booking
from tests.concurrency.harness import (
    LockSampler,
    count_booked_at,
    make_patients,
    make_race_app,
    pg_sleep_after_write,
    race,
)
from tests.conftest import TEST_PUBLIC_BASE_URL, seeded_doctor_id

pytestmark = [pytest.mark.asyncio, pytest.mark.race]

OTIENO = str(seeded_doctor_id("otieno"))
N = 25
ITERATIONS = 10


async def test_single_winner_per_slot(
    reset_appointments: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(booking, "_after_write", pg_sleep_after_write)
    app = make_race_app()

    transport = httpx.ASGITransport(app=app)  # type: ignore[arg-type]
    async with httpx.AsyncClient(transport=transport, base_url=TEST_PUBLIC_BASE_URL) as setup:
        patients = await make_patients(setup, N)
        avail = await setup.get(f"/doctors/{OTIENO}/availability?date=2026-10-26")
        slots = [s["starts_at"] for s in avail.json()["slots"]][:ITERATIONS]
    assert len(slots) == ITERATIONS

    overall_peak = 0
    for slot in slots:

        async def task(client: httpx.AsyncClient, i: int, slot: str = slot) -> httpx.Response:
            return await client.post(
                "/appointments",
                json={"doctor_id": OTIENO, "patient_id": patients[i], "starts_at": slot},
            )

        async with LockSampler() as sampler:
            responses = await race(app, task, N)
        overall_peak = max(overall_peak, sampler.peak)

        created = [r for r in responses if r.status_code == 201]
        conflicts = [r for r in responses if r.status_code == 409]
        assert len(created) == 1, [r.status_code for r in responses]
        assert len(conflicts) == N - 1
        assert all(r.json()["code"] == "SLOT_TAKEN" for r in conflicts)
        assert await count_booked_at(OTIENO, slot) == 1

    assert overall_peak >= 5, f"expected >= 5 blocked waiters, saw {overall_peak}"
