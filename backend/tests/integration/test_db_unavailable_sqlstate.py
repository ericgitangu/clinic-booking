"""Server-side database outages arrive as a plain DBAPIError and must be reported as 503.

Real asyncpg exceptions are raised from the driver's ``PreparedStatement.fetch``, so they pass
through SQLAlchemy's own asyncpg translation exactly as they would from a live server.
"""

from __future__ import annotations

from typing import Any

import asyncpg.exceptions as pgexc
import asyncpg.prepared_stmt
import httpx
import pytest

pytestmark = pytest.mark.asyncio

OUTAGES = [
    pytest.param(pgexc.AdminShutdownError, "57P01", id="admin_shutdown"),
    pytest.param(pgexc.CannotConnectNowError, "57P03", id="cannot_connect_now"),
    pytest.param(pgexc.TooManyConnectionsError, "53300", id="too_many_connections"),
    pytest.param(pgexc.PostgresConnectionError, "08000", id="connection_exception"),
]


@pytest.mark.parametrize(("error_cls", "sqlstate"), OUTAGES)
async def test_outage_sqlstate_is_503_with_retry_after(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    error_cls: type[pgexc.PostgresError],
    sqlstate: str,
) -> None:
    assert error_cls.sqlstate == sqlstate

    async def boom(self: Any, *args: Any, **kwargs: Any) -> Any:
        # Server errors always carry the server's message; SQLAlchemy's translation reads args[0].
        raise error_cls(f"simulated server error {sqlstate}")

    monkeypatch.setattr(asyncpg.prepared_stmt.PreparedStatement, "fetch", boom)

    resp = await client.get("/doctors")

    assert resp.status_code == 503, resp.text
    assert resp.json()["code"] == "DB_UNAVAILABLE"
    assert resp.headers["retry-after"] == "2"
    assert resp.headers["content-type"].startswith("application/problem+json")
