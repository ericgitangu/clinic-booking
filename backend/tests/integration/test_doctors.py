from __future__ import annotations

import httpx
import pytest

from tests.conftest import seeded_doctor_id

pytestmark = pytest.mark.asyncio


async def test_list_doctors_active_sorted(client: httpx.AsyncClient) -> None:
    resp = await client.get("/doctors")
    assert resp.status_code == 200
    items = resp.json()["items"]
    assert len(items) == 5
    names = [d["full_name"] for d in items]
    assert names == sorted(names)
    assert resp.headers["cache-control"] == "no-store"
    first = items[0]
    assert first["clinic"]["timezone"] == "Africa/Nairobi"
    assert isinstance(first["working_hours"], list)


async def test_get_doctor_ok(client: httpx.AsyncClient) -> None:
    did = seeded_doctor_id("otieno")
    resp = await client.get(f"/doctors/{did}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["full_name"] == "Dr. Achieng Otieno"
    # Mon-Fri two windows each -> 10 rows.
    assert len(body["working_hours"]) == 10


async def test_get_doctor_unknown_404(client: httpx.AsyncClient) -> None:
    resp = await client.get("/doctors/00000000-0000-0000-0000-000000000000")
    assert resp.status_code == 404
    assert resp.json()["code"] == "DOCTOR_NOT_FOUND"


async def test_get_doctor_non_uuid_422(client: httpx.AsyncClient) -> None:
    resp = await client.get("/doctors/not-a-uuid")
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDATION_ERROR"
