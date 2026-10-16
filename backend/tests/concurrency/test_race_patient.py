"""Case 2 (§3.4): one patient, two doctors, same instant -> one booking."""

from __future__ import annotations

import httpx
import pytest

from app.services import booking
from tests.concurrency.harness import make_race_app, pg_sleep_after_write, race
from tests.conftest import seeded_doctor_id, seeded_patient_id

pytestmark = [pytest.mark.asyncio, pytest.mark.race]

OTIENO = str(seeded_doctor_id("otieno"))
KAMAU = str(seeded_doctor_id("kamau"))
AMINA = str(seeded_patient_id("amina"))
AT = "2026-10-26T09:00:00+03:00"  # both doctors work Monday 09:00


async def test_patient_double_booked_race(
    reset_appointments: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(booking, "_after_write", pg_sleep_after_write)
    app = make_race_app()
    doctors = [OTIENO, KAMAU]

    async def task(client: httpx.AsyncClient, i: int) -> httpx.Response:
        return await client.post(
            "/appointments",
            json={"doctor_id": doctors[i], "patient_id": AMINA, "starts_at": AT},
        )

    responses = await race(app, task, 2)
    created = [r for r in responses if r.status_code == 201]
    conflicts = [r for r in responses if r.status_code == 409]
    assert len(created) == 1, [r.status_code for r in responses]
    assert len(conflicts) == 1
    assert conflicts[0].json()["code"] == "PATIENT_DOUBLE_BOOKED"
