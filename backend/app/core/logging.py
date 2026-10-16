"""Structured JSON logging.

One JSON object per line on stdout. The formatter emits a fixed allowlist of fields, so
PII (names, phones, emails, reasons, patient ids, SQL params) can never leak through a
stray ``extra=`` — redaction is by construction, covered by ``test_log_redaction``.
"""

from __future__ import annotations

import json
import logging
import sys
from typing import Any

ACCESS_LOGGER = "clinic.access"
APP_LOGGER = "clinic.app"

# Only these record attributes are ever serialized.
_ALLOWED_FIELDS = (
    "request_id",
    "method",
    "route",
    "status",
    "latency_ms",
    "code",
    "logging.googleapis.com/trace",
)


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "severity": record.levelname,
            "message": record.getMessage(),
        }
        for field in _ALLOWED_FIELDS:
            value = getattr(record, field, None)
            if value is not None:
                payload[field] = value
        if record.exc_info:
            # Exception type/trace only; never bound parameters (hide_parameters=True).
            payload["exc_type"] = getattr(record.exc_info[0], "__name__", "Exception")
        return json.dumps(payload, default=str)


def configure_logging(level: str = "info") -> None:
    handler = logging.StreamHandler(stream=sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level.upper())
    # uvicorn's own access log is redundant with ours and unstructured.
    logging.getLogger("uvicorn.access").handlers = []
    logging.getLogger("uvicorn.access").propagate = False
    logging.getLogger("httpx").setLevel(logging.WARNING)


def access_log(
    *,
    request_id: str,
    method: str,
    route: str,
    status: int,
    latency_ms: float,
    code: str | None,
    trace: str | None,
) -> None:
    extra: dict[str, Any] = {
        "request_id": request_id,
        "method": method,
        "route": route,
        "status": status,
        "latency_ms": round(latency_ms, 2),
    }
    if code is not None:
        extra["code"] = code
    if trace is not None:
        extra["logging.googleapis.com/trace"] = trace
    logging.getLogger(ACCESS_LOGGER).info("request", extra=extra)
