"""Health and the fixed doc URLs (§12.4)."""

from __future__ import annotations

import httpx

from app.core.config import Settings
from app.main import create_app
from tests.conftest import make_settings


def test_root_path_is_empty() -> None:
    app = create_app(make_settings())
    assert app.root_path == ""


async def test_doc_urls_answer_200(client: httpx.AsyncClient) -> None:
    for path in ("/docs", "/redoc", "/openapi.json"):
        resp = await client.get(path)
        assert resp.status_code == 200, path


async def test_healthz_never_needs_db() -> None:
    # A bogus DB URL proves /healthz does not connect.
    settings = make_settings(DATABASE_URL="postgresql+asyncpg://x:x@127.0.0.1:1/x")
    assert isinstance(settings, Settings)
    app = create_app(settings)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
        resp = await c.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
