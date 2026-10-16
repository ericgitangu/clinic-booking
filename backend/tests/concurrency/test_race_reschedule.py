"""Two reschedules into one free slot: exactly one wins and the loser keeps its original slot."""

from __future__ import annotations

import httpx
import pytest

from app.services import booking
from tests.concurrency.harness import make_race_app, pg_sleep_after_write, race
from tests.conftest import TEST_PUBLIC_BASE_URL, seeded_doctor_id, seeded_patient_id

pytestmark = [pytest.mark.asyncio, pytest.mark.race]

OTIENO = str(seeded_doctor_id("otieno"))
AMINA = str(seeded_patient_id("amina"))
WANJIRU = str(seeded_patient_id("wanjiru"))
AT_0900 = "2026-10-26T09:00:00+03:00"
AT_1030 = "2026-10-26T10:30:00+03:00"
TARGET = "2026-10-26T10:00:00+03:00"  # free slot both will race into


async def _book(client: httpx.AsyncClient, patient: str, at: str) -> str:
    resp = await client.post(
        "/appointments", json={"doctor_id": OTIENO, "patient_id": patient, "starts_at": at}
    )
    assert resp.status_code == 201, resp.text
    return str(resp.json()["id"])


async def test_two_reschedules_one_slot(
    reset_appointments: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = make_race_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url=TEST_PUBLIC_BASE_URL) as c:
        a_id = await _book(c, AMINA, AT_0900)
        b_id = await _book(c, WANJIRU, AT_1030)

    monkeypatch.setattr(booking, "_after_write", pg_sleep_after_write)
    appt_ids = [a_id, b_id]

    async def task(client: httpx.AsyncClient, i: int) -> httpx.Response:
        return await client.patch(
            f"/appointments/{appt_ids[i]}/reschedule", json={"starts_at": TARGET}
        )

    responses = await race(app, task, 2)
    ok = [r for r in responses if r.status_code == 200]
    conflicts = [r for r in responses if r.status_code == 409]
    assert len(ok) == 1, [r.status_code for r in responses]
    assert len(conflicts) == 1
    assert conflicts[0].json()["code"] in ("SLOT_TAKEN", "CONCURRENT_UPDATE")

    # The loser keeps its original slot.
    transport2 = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport2, base_url=TEST_PUBLIC_BASE_URL) as c:
        a = (await c.get(f"/appointments/{a_id}")).json()
        b = (await c.get(f"/appointments/{b_id}")).json()
    starts = {a["starts_at"], b["starts_at"]}
    assert TARGET in starts  # the winner moved to the target slot
    originals = {AT_0900, AT_1030}
    remaining_originals = starts & originals
    assert len(remaining_originals) == 1  # the loser kept exactly one original slot
