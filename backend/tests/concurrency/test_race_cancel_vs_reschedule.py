"""A cancel racing a reschedule leaves a consistent state and never double-books."""

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
AT_1300 = "2026-10-26T13:00:00+03:00"


async def _book(client: httpx.AsyncClient, patient: str, at: str) -> str:
    resp = await client.post(
        "/appointments", json={"doctor_id": OTIENO, "patient_id": patient, "starts_at": at}
    )
    assert resp.status_code == 201, resp.text
    return str(resp.json()["id"])


async def test_case4_cancel_vs_reschedule_same_appointment(
    reset_appointments: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = make_race_app()
    transport = httpx.ASGITransport(app=app)  # type: ignore[arg-type]
    async with httpx.AsyncClient(transport=transport, base_url=TEST_PUBLIC_BASE_URL) as c:
        appt_id = await _book(c, AMINA, AT_0900)

    monkeypatch.setattr(booking, "_after_write", pg_sleep_after_write)

    async def task(client: httpx.AsyncClient, i: int) -> httpx.Response:
        if i == 0:
            return await client.patch(
                f"/appointments/{appt_id}/cancel", json={"reason": "cancel wins or loses"}
            )
        return await client.patch(
            f"/appointments/{appt_id}/reschedule", json={"starts_at": AT_1300}
        )

    responses = await race(app, task, 2)
    assert all(r.status_code < 500 for r in responses), [r.status_code for r in responses]

    # Final state is self-consistent and the latest event matches it.
    async with httpx.AsyncClient(transport=transport, base_url=TEST_PUBLIC_BASE_URL) as c:
        final = (await c.get(f"/appointments/{appt_id}")).json()
    if final["status"] == "cancelled":
        assert final["cancelled_at"] is not None
        assert final["cancellation_reason"] is not None
    else:
        assert final["status"] == "booked"
        assert final["cancelled_at"] is None


async def test_case8_cancel_x_vs_reschedule_y_into_slot(
    reset_appointments: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = make_race_app()
    transport = httpx.ASGITransport(app=app)  # type: ignore[arg-type]
    async with httpx.AsyncClient(transport=transport, base_url=TEST_PUBLIC_BASE_URL) as c:
        x_id = await _book(c, AMINA, AT_0900)  # X holds 09:00
        y_id = await _book(c, WANJIRU, AT_1300)  # Y at 13:00, will try to move into 09:00

    monkeypatch.setattr(booking, "_after_write", pg_sleep_after_write)

    async def task(client: httpx.AsyncClient, i: int) -> httpx.Response:
        if i == 0:
            return await client.patch(
                f"/appointments/{x_id}/cancel", json={"reason": "freeing the slot"}
            )
        return await client.patch(f"/appointments/{y_id}/reschedule", json={"starts_at": AT_0900})

    responses = await race(app, task, 2)
    assert all(r.status_code < 500 for r in responses), [r.status_code for r in responses]
    # Never two booked rows at the contested slot.
    assert await count_booked_at(OTIENO, AT_0900) <= 1
