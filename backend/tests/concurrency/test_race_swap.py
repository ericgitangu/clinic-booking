"""Case 7 (§3.4): a two-appointment slot swap stays consistent (original or swapped)."""

from __future__ import annotations

import httpx
import pytest

from app.services import booking
from tests.concurrency.harness import (
    count_booked_at,
    make_race_app,
    pg_sleep_after_write,
    race,
)
from tests.conftest import TEST_PUBLIC_BASE_URL, seeded_doctor_id, seeded_patient_id

pytestmark = [pytest.mark.asyncio, pytest.mark.race]

OTIENO = str(seeded_doctor_id("otieno"))
AMINA = str(seeded_patient_id("amina"))
WANJIRU = str(seeded_patient_id("wanjiru"))
AT_0900 = "2026-10-26T09:00:00+03:00"
AT_1000 = "2026-10-26T10:00:00+03:00"


async def _book(client: httpx.AsyncClient, patient: str, at: str) -> str:
    resp = await client.post(
        "/appointments", json={"doctor_id": OTIENO, "patient_id": patient, "starts_at": at}
    )
    assert resp.status_code == 201, resp.text
    return str(resp.json()["id"])


async def test_swap_no_5xx_no_double_book(
    reset_appointments: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = make_race_app()
    transport = httpx.ASGITransport(app=app)  # type: ignore[arg-type]
    async with httpx.AsyncClient(transport=transport, base_url=TEST_PUBLIC_BASE_URL) as c:
        a_id = await _book(c, AMINA, AT_0900)  # A at 09:00 -> wants 10:00
        b_id = await _book(c, WANJIRU, AT_1000)  # B at 10:00 -> wants 09:00

    monkeypatch.setattr(booking, "_after_write", pg_sleep_after_write)

    async def task(client: httpx.AsyncClient, i: int) -> httpx.Response:
        if i == 0:
            return await client.patch(
                f"/appointments/{a_id}/reschedule", json={"starts_at": AT_1000}
            )
        return await client.patch(f"/appointments/{b_id}/reschedule", json={"starts_at": AT_0900})

    responses = await race(app, task, 2)
    assert all(r.status_code < 500 for r in responses), [r.status_code for r in responses]
    for r in responses:
        if r.status_code == 409:
            assert r.json()["code"] in ("SLOT_TAKEN", "CONCURRENT_UPDATE")

    # No slot is double-booked.
    assert await count_booked_at(OTIENO, AT_0900) <= 1
    assert await count_booked_at(OTIENO, AT_1000) <= 1

    # Final state is either the original or the full swap.
    async with httpx.AsyncClient(transport=transport, base_url=TEST_PUBLIC_BASE_URL) as c:
        a = (await c.get(f"/appointments/{a_id}")).json()["starts_at"]
        b = (await c.get(f"/appointments/{b_id}")).json()["starts_at"]
    assert (a, b) in {(AT_0900, AT_1000), (AT_1000, AT_0900)}
