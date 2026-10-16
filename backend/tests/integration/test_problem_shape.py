"""Problem+json shape, headers and the catalogue endpoints (§6, ADR-0006)."""

from __future__ import annotations

import uuid

import httpx
import pytest

pytestmark = pytest.mark.asyncio

PROBLEM_CT = "application/problem+json"


async def test_unknown_path_is_problem_404(client: httpx.AsyncClient) -> None:
    resp = await client.get("/nope")
    assert resp.status_code == 404
    assert resp.headers["content-type"].startswith(PROBLEM_CT)
    body = resp.json()
    assert body["code"] == "NOT_FOUND"
    assert body["status"] == 404
    assert body["type"].endswith("/problems/not-found")
    assert body["instance"] == "/nope"
    uuid.UUID(body["request_id"])  # valid UUID


async def test_problem_catalogue_entry(client: httpx.AsyncClient) -> None:
    resp = await client.get("/problems/slot-taken")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == 409
    assert body["code"] == "SLOT_TAKEN"


async def test_problem_list(client: httpx.AsyncClient) -> None:
    resp = await client.get("/problems")
    assert resp.status_code == 200
    codes = {e["code"] for e in resp.json()}
    assert {"SLOT_TAKEN", "VALIDATION_ERROR", "DB_UNAVAILABLE"} <= codes


async def test_unknown_problem_slug_404(client: httpx.AsyncClient) -> None:
    resp = await client.get("/problems/does-not-exist")
    assert resp.status_code == 404
    assert resp.json()["code"] == "PROBLEM_NOT_FOUND"


async def test_request_id_echoed_when_valid_uuid(client: httpx.AsyncClient) -> None:
    rid = str(uuid.uuid4())
    resp = await client.get("/healthz", headers={"X-Request-ID": rid})
    assert resp.headers["x-request-id"] == rid


async def test_request_id_generated_when_invalid(client: httpx.AsyncClient) -> None:
    resp = await client.get("/healthz", headers={"X-Request-ID": "not-a-uuid"})
    uuid.UUID(resp.headers["x-request-id"])  # a fresh valid one


async def test_server_timing_header_present(client: httpx.AsyncClient) -> None:
    resp = await client.get("/healthz")
    st = resp.headers["server-timing"]
    assert "app;dur=" in st and "db;dur=" in st
