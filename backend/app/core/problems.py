"""Problem+json responses and the exception handlers that produce them."""

from __future__ import annotations

import logging
import socket
from typing import Any, cast

import sqlalchemy.exc
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.logging import APP_LOGGER
from app.core.middleware import problem_code_ctx, request_id_ctx
from app.db.errors import is_db_unavailable
from app.domain.errors import CATALOGUE_BY_CODE, DomainError

PROBLEM_MEDIA_TYPE = "application/problem+json"

# Exceptions raised before or outside a SQL statement that mean "the database is unreachable",
# mapped to 503 with Retry-After. Server-side errors that arrive as a DBAPIError are classified
# by SQLSTATE in ``_dbapi_error_handler`` instead. A bare OSError is deliberately not listed:
# it would hide unrelated bugs (a missing file, a permission error) behind a 503.
DB_UNAVAILABLE_EXCEPTIONS: tuple[type[Exception], ...] = (
    sqlalchemy.exc.TimeoutError,  # connection pool exhausted
    sqlalchemy.exc.DisconnectionError,
    ConnectionError,  # refused, reset, aborted
    socket.gaierror,  # DNS failure
    TimeoutError,  # connect timeout
)


def _public_base_url(request: Request) -> str:
    settings = request.app.state.settings
    return str(settings.PUBLIC_BASE_URL).rstrip("/")


def _request_id(request: Request) -> str:
    # The scope value survives after the request-context middleware has reset the contextvar
    # (the catch-all 500 handler runs outside that middleware).
    scoped = request.scope.get("clinic.request_id")
    if isinstance(scoped, str) and scoped:
        return scoped
    return request_id_ctx.get() or "00000000-0000-0000-0000-000000000000"


def build_problem(
    request: Request,
    code: str,
    *,
    detail: str | None = None,
    errors: list[dict[str, Any]] | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    spec = CATALOGUE_BY_CODE[code]
    problem_code_ctx.set(code)
    body: dict[str, Any] = {
        "type": f"{_public_base_url(request)}/problems/{spec.slug}",
        "title": spec.title,
        "status": spec.status,
        "detail": detail or spec.description,
        "instance": request.url.path,
        "code": code,
        "request_id": _request_id(request),
        "errors": errors,
    }
    # A problem describes this one request and must never be stored or shared.
    return JSONResponse(
        status_code=spec.status,
        content=body,
        media_type=PROBLEM_MEDIA_TYPE,
        headers={"Cache-Control": "no-store", **(headers or {})},
    )


async def _domain_error_handler(request: Request, exc: Exception) -> JSONResponse:
    exc = cast(DomainError, exc)
    headers: dict[str, str] | None = None
    if exc.code == "DB_UNAVAILABLE":
        headers = {"Retry-After": "2"}
    elif exc.retry_after is not None:
        headers = {"Retry-After": str(exc.retry_after)}
    return build_problem(request, exc.code, detail=exc.detail, headers=headers)


async def _validation_handler(request: Request, exc: Exception) -> JSONResponse:
    exc = cast(RequestValidationError, exc)
    raw = exc.errors()
    errors = [
        {"loc": list(e.get("loc", [])), "msg": e.get("msg", ""), "type": e.get("type", "")}
        for e in raw
    ]
    all_tz = bool(raw) and all(e.get("type") == "timezone_aware" for e in raw)
    if all_tz:
        return build_problem(request, "TIMEZONE_REQUIRED")
    return build_problem(request, "VALIDATION_ERROR", errors=errors)


async def _http_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    exc = cast(StarletteHTTPException, exc)
    if exc.status_code == 405:
        return build_problem(request, "METHOD_NOT_ALLOWED")
    if exc.status_code == 404:
        return build_problem(request, "NOT_FOUND")
    # FastAPI raises HTTPException(400) when it cannot parse the body (e.g. invalid UTF-8,
    # which it does not convert to a RequestValidationError). We never emit 400; a body-parse
    # failure is a client validation error -> 422. (Found by schemathesis.)
    if exc.status_code in (400, 422):
        return build_problem(request, "VALIDATION_ERROR")
    code = "DB_UNAVAILABLE" if exc.status_code == 503 else "INTERNAL_ERROR"
    return build_problem(request, code)


async def _db_unavailable_handler(request: Request, exc: Exception) -> JSONResponse:
    return build_problem(request, "DB_UNAVAILABLE", headers={"Retry-After": "2"})


async def _dbapi_error_handler(request: Request, exc: Exception) -> JSONResponse:
    """Database outages (SQLSTATE class 08, 53300, 57P01/02/03) are 503; any other database
    error is a bug and is re-raised to the catch-all (opaque 500)."""
    if is_db_unavailable(exc):
        return build_problem(request, "DB_UNAVAILABLE", headers={"Retry-After": "2"})
    raise exc


def _log_unhandled(request: Request, exc: BaseException) -> None:
    # Opaque response body; the trace is logged under request_id, without bound parameters.
    logging.getLogger(APP_LOGGER).error(
        "unhandled exception",
        exc_info=exc,
        extra={"request_id": _request_id(request)},
    )


async def _catch_all_handler(request: Request, exc: Exception) -> JSONResponse:
    _log_unhandled(request, exc)
    return build_problem(request, "INTERNAL_ERROR")


class UnhandledErrorMiddleware:
    """Turn an unhandled exception into a 500 problem+json *inside* the request-context and CORS
    middleware.

    Starlette's own catch-all runs in ServerErrorMiddleware, outside every user middleware, so
    a response built there carries no ``X-Request-ID``, ``Server-Timing`` or CORS headers and
    never reaches the access log. Installed innermost, this lets the outer middleware see a
    normal 500 response.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        started = False

        async def tracking_send(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, tracking_send)
        except Exception as exc:
            if started:
                raise  # a response is already on the wire; nothing sane to send
            request = Request(scope, receive)
            _log_unhandled(request, exc)
            await build_problem(request, "INTERNAL_ERROR")(scope, receive, send)


def register_exception_handlers(app: FastAPI) -> None:
    app.add_exception_handler(DomainError, _domain_error_handler)
    app.add_exception_handler(RequestValidationError, _validation_handler)
    app.add_exception_handler(StarletteHTTPException, _http_exception_handler)
    app.add_exception_handler(sqlalchemy.exc.DBAPIError, _dbapi_error_handler)
    for exc_type in DB_UNAVAILABLE_EXCEPTIONS:
        app.add_exception_handler(exc_type, _db_unavailable_handler)
    app.add_exception_handler(Exception, _catch_all_handler)
