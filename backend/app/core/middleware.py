"""Pure ASGI request-context middleware. No BaseHTTPMiddleware, no GZip.

Assigns a request id, measures app and DB time, sets ``Server-Timing`` and ``X-Request-ID``
on the response, and emits one JSON access line per request.
"""

from __future__ import annotations

import time
import uuid
from contextvars import ContextVar

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.logging import access_log

request_id_ctx: ContextVar[str] = ContextVar("request_id", default="")
# Accumulated DB time (ms) for the current request; repositories add to it.
db_time_ms_ctx: ContextVar[float] = ContextVar("db_time_ms", default=0.0)

# The handler sets this when it emits a problem so the access log can record the code.
problem_code_ctx: ContextVar[str | None] = ContextVar("problem_code", default=None)


def _valid_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True


def _route_label(scope: Scope) -> str:
    """The matched route template (``/patients/{patient_id}/appointments``), never the raw path.

    Logging the concrete path would write patient and appointment ids into Cloud Logging. The
    router stores the matched route on the shared scope; an unmatched request (404) is logged
    as ``unmatched`` so attacker-controlled URLs never reach the logs either.
    """
    path = getattr(scope.get("route"), "path", None)
    return path if isinstance(path, str) else "unmatched"


def _header(scope: Scope, name: bytes) -> str | None:
    for key, value in scope.get("headers", []):
        if key == name:
            return str(value.decode("latin-1"))
    return None


class RequestContextMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        inbound = _header(scope, b"x-request-id")
        request_id = inbound if (inbound and _valid_uuid(inbound)) else str(uuid.uuid4())
        trace = _header(scope, b"x-cloud-trace-context")

        # Stash on the scope too: the catch-all 500 handler runs in Starlette's
        # ServerErrorMiddleware, outside this middleware, after the contextvar is reset.
        scope["clinic.request_id"] = request_id
        req_token = request_id_ctx.set(request_id)
        db_token = db_time_ms_ctx.set(0.0)
        code_token = problem_code_ctx.set(None)
        start = time.perf_counter()
        status_holder = {"status": 500}

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                status_holder["status"] = message["status"]
                app_ms = (time.perf_counter() - start) * 1000.0
                db_ms = db_time_ms_ctx.get()
                headers = list(message.get("headers", []))
                headers.append((b"x-request-id", request_id.encode("latin-1")))
                headers.append(
                    (
                        b"server-timing",
                        f"db;dur={db_ms:.2f}, app;dur={app_ms:.2f}".encode("latin-1"),
                    )
                )
                message = {**message, "headers": headers}
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            latency_ms = (time.perf_counter() - start) * 1000.0
            access_log(
                request_id=request_id,
                method=scope.get("method", "-"),
                route=_route_label(scope),
                status=status_holder["status"],
                latency_ms=latency_ms,
                code=problem_code_ctx.get(),
                trace=trace,
            )
            request_id_ctx.reset(req_token)
            db_time_ms_ctx.reset(db_token)
            problem_code_ctx.reset(code_token)
