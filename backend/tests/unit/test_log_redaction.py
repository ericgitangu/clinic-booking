"""The JSON formatter emits only an allowlist, so PII can never leak (ADR-0019)."""

from __future__ import annotations

import json
import logging

from app.core.logging import JsonFormatter


def _record(**extra: object) -> logging.LogRecord:
    record = logging.LogRecord(
        name="clinic.access",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="request",
        args=(),
        exc_info=None,
    )
    for key, value in extra.items():
        setattr(record, key, value)
    return record


def test_pii_extras_are_dropped() -> None:
    record = _record(
        request_id="rid-1",
        status=200,
        cancellation_reason="patient has flu",
        patient_id="11111111-1111-1111-1111-111111111111",
        full_name="Amina Hassan",
        phone="+254700000000",
    )
    out = json.loads(JsonFormatter().format(record))
    assert out["request_id"] == "rid-1"
    assert out["status"] == 200
    for leaked in ("cancellation_reason", "patient_id", "full_name", "phone"):
        assert leaked not in out
    assert "flu" not in json.dumps(out)
    assert "Amina" not in json.dumps(out)


def test_allowlisted_fields_present() -> None:
    record = _record(
        request_id="rid-2",
        method="GET",
        route="/healthz",
        status=200,
        latency_ms=1.23,
        code="NOT_FOUND",
    )
    out = json.loads(JsonFormatter().format(record))
    assert out["severity"] == "INFO"
    assert out["message"] == "request"
    assert out["method"] == "GET"
    assert out["route"] == "/healthz"
    assert out["code"] == "NOT_FOUND"


def test_exception_logs_type_not_params() -> None:
    try:
        raise ValueError("secret bound param value=+254700000000")
    except ValueError:
        import sys

        record = _record(request_id="rid-3")
        record.exc_info = sys.exc_info()
    out = json.loads(JsonFormatter().format(record))
    assert out["exc_type"] == "ValueError"
    # The message itself is the fixed "request"; the exception detail string is not emitted.
    assert "254700000000" not in json.dumps(out)
