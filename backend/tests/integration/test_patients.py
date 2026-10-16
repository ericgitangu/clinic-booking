from __future__ import annotations

import asyncpg
import httpx
import pytest

from tests.conftest import owner_dsn

pytestmark = pytest.mark.asyncio

PHONE = "+254711222333"


async def _delete_phone() -> None:
    conn = await asyncpg.connect(owner_dsn())
    try:
        await conn.execute("DELETE FROM patients WHERE phone = $1", PHONE)
    finally:
        await conn.close()


async def test_create_patient_201_with_location(client: httpx.AsyncClient) -> None:
    resp = await client.post("/patients", json={"full_name": "Grace Wairimu"})
    assert resp.status_code == 201
    body = resp.json()
    assert body["full_name"] == "Grace Wairimu"
    assert resp.headers["location"] == f"/patients/{body['id']}"


async def test_create_patient_phone_conflict_409(client: httpx.AsyncClient) -> None:
    await _delete_phone()
    try:
        first = await client.post("/patients", json={"full_name": "Phone One", "phone": PHONE})
        assert first.status_code == 201
        dup = await client.post("/patients", json={"full_name": "Phone Two", "phone": PHONE})
        assert dup.status_code == 409
        assert dup.json()["code"] == "PATIENT_PHONE_EXISTS"
    finally:
        await _delete_phone()


async def test_create_patient_too_short_name_422(client: httpx.AsyncClient) -> None:
    resp = await client.post("/patients", json={"full_name": "A"})
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDATION_ERROR"


async def test_create_patient_extra_field_422(client: httpx.AsyncClient) -> None:
    resp = await client.post("/patients", json={"full_name": "Valid Name", "nope": 1})
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDATION_ERROR"
