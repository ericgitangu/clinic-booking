"""Error responses are problem+json with the documented fields and headers;
the catalogue endpoints list every code."""

from __future__ import annotations

import io
import logging
import uuid
from typing import Any

import asyncpg.exceptions as pgexc
import asyncpg.prepared_stmt
import httpx
import pytest

from app.core.logging import JsonFormatter
from app.repositories import doctors as doctor_repo

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


async def test_unhandled_error_500_headers(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def boom(*args: object, **kwargs: object) -> None:
        raise RuntimeError("simulated bug")

    monkeypatch.setattr(doctor_repo, "list_active_doctors", boom)

    buffer = io.StringIO()
    handler = logging.StreamHandler(buffer)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.addHandler(handler)
    try:
        resp = await client.get("/doctors", headers={"Origin": "http://localhost:3000"})
    finally:
        root.removeHandler(handler)

    assert resp.status_code == 500
    body = resp.json()
    assert body["code"] == "INTERNAL_ERROR"
    assert resp.headers["content-type"].startswith("application/problem+json")
    assert resp.headers["x-request-id"] == body["request_id"]
    assert "server-timing" in resp.headers
    assert resp.headers["access-control-allow-origin"] == "http://localhost:3000"
    # The 500 reaches the access log with the matched route and its request id.
    access = [line for line in buffer.getvalue().splitlines() if '"message": "request"' in line]
    assert access, buffer.getvalue()
    assert '"status": 500' in access[-1]
    assert f'"request_id": "{body["request_id"]}"' in access[-1]
    assert "simulated bug" not in resp.text  # the body stays opaque


async def test_unclassified_db_error_is_500_not_503(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def boom(self: Any, *args: Any, **kwargs: Any) -> Any:
        raise pgexc.UndefinedTableError('relation "nope" does not exist')

    monkeypatch.setattr(asyncpg.prepared_stmt.PreparedStatement, "fetch", boom)

    resp = await client.get("/doctors")

    assert resp.status_code == 500
    assert resp.json()["code"] == "INTERNAL_ERROR"
    assert "retry-after" not in resp.headers
