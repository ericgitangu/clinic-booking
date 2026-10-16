"""On a server error, logs carry request_id but never PII (ADR-0019, WP-07)."""

from __future__ import annotations

import io
import logging

import httpx
import pytest

from app.core.logging import JsonFormatter
from app.repositories import events as event_repo
from tests.conftest import seeded_doctor_id, seeded_patient_id

pytestmark = pytest.mark.asyncio

OTIENO = str(seeded_doctor_id("otieno"))
AMINA = str(seeded_patient_id("amina"))
BOOK_AT = "2026-10-26T09:00:00+03:00"
SECRET_REASON = "patient has a confidential condition zzxyq"


async def test_error_logs_omit_reason_and_patient_id(
    client: httpx.AsyncClient,
    reset_appointments: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created = await client.post(
        "/appointments", json={"doctor_id": OTIENO, "patient_id": AMINA, "starts_at": BOOK_AT}
    )
    assert created.status_code == 201
    appt_id = created.json()["id"]

    # Capture everything the loggers emit (access + error), independent of stdout handlers.
    buffer = io.StringIO()
    handler = logging.StreamHandler(buffer)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.addHandler(handler)

    async def _boom(*args: object, **kwargs: object) -> None:
        raise RuntimeError("ck_appt_cancel_consistency simulated failure")

    monkeypatch.setattr(event_repo, "insert_event", _boom)
    try:
        resp = await client.patch(f"/appointments/{appt_id}/cancel", json={"reason": SECRET_REASON})
    finally:
        root.removeHandler(handler)

    assert resp.status_code == 500
    assert resp.json()["code"] == "INTERNAL_ERROR"
    assert SECRET_REASON not in resp.text  # opaque body

    logs = buffer.getvalue()
    assert "request_id" in logs  # the error is traceable
    assert SECRET_REASON not in logs  # reason never logged
    assert "confidential" not in logs
    assert AMINA not in logs  # patient id never logged


async def test_access_log_records_route_template_not_ids(
    client: httpx.AsyncClient, reset_appointments: None
) -> None:
    created = await client.post(
        "/appointments", json={"doctor_id": OTIENO, "patient_id": AMINA, "starts_at": BOOK_AT}
    )
    assert created.status_code == 201
    appt_id = created.json()["id"]

    buffer = io.StringIO()
    handler = logging.StreamHandler(buffer)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.addHandler(handler)
    try:
        assert (await client.get(f"/patients/{AMINA}/appointments")).status_code == 200
        assert (await client.get(f"/appointments/{appt_id}")).status_code == 200
        assert (await client.get(f"/no/such/place/{appt_id}")).status_code == 404
    finally:
        root.removeHandler(handler)

    logs = buffer.getvalue()
    assert '"route": "/patients/{patient_id}/appointments"' in logs
    assert '"route": "/appointments/{appointment_id}"' in logs
    assert '"route": "unmatched"' in logs  # a 404 never logs the raw URL
    assert AMINA not in logs
    assert appt_id not in logs
