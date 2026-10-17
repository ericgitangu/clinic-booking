"""An unauthenticated /internal request is refused without touching the database."""

from __future__ import annotations

import httpx
import pytest
from sqlalchemy import event

from app.db.session import get_engine
from app.main import create_app
from tests.conftest import make_settings, seeded_doctor_id

pytestmark = pytest.mark.asyncio

DOCTOR = str(seeded_doctor_id("otieno"))
APPT = "11111111-1111-4111-8111-111111111111"

CASES: list[tuple[str, str, dict[str, str] | None]] = [
    ("GET", "/internal/admin/session", None),
    ("GET", "/internal/admin/appointments", None),
    ("GET", "/internal/admin/metrics?from=2026-10-12&to=2026-10-19", None),
    ("GET", f"/internal/admin/appointments/{APPT}/lineage", None),
    ("GET", "/internal/me/appointments", None),
    ("GET", f"/internal/me/appointments/{APPT}", None),
    (
        "POST",
        "/internal/me/appointments",
        {"doctor_id": DOCTOR, "starts_at": "2026-10-26T09:00:00Z"},
    ),
    ("POST", "/internal/accounts/link", {"full_name": "No Session"}),
]


@pytest.mark.parametrize(("method", "path", "body"), CASES)
@pytest.mark.parametrize("key_configured", [False, True])
async def test_unauthenticated_internal_request_runs_no_sql(
    method: str, path: str, body: dict[str, str] | None, key_configured: bool
) -> None:
    settings = make_settings(INTERNAL_SIGNING_KEY="k" * 40) if key_configured else make_settings()
    app = create_app(settings)
    statements: list[str] = []

    def count(*args: object) -> None:
        statements.append(str(args[2]))

    engine = get_engine(settings).sync_engine
    event.listen(engine, "before_cursor_execute", count)
    try:
        transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
            resp = await c.request(method, path, json=body)
    finally:
        event.remove(engine, "before_cursor_execute", count)

    assert resp.status_code == 401, resp.text
    assert resp.json()["code"] == "UNAUTHENTICATED"
    assert statements == []


async def test_the_counter_sees_statements_when_there_are_some() -> None:
    # Guards the test above: the hook must really observe the real engine.
    settings = make_settings()
    app = create_app(settings)
    statements: list[str] = []

    def count(*args: object) -> None:
        statements.append(str(args[2]))

    engine = get_engine(settings).sync_engine
    event.listen(engine, "before_cursor_execute", count)
    try:
        transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
            resp = await c.get("/doctors")
    finally:
        event.remove(engine, "before_cursor_execute", count)
    assert resp.status_code == 200
    assert statements, "GET /doctors runs SQL, so the hook must have seen it"
