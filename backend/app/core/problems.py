"""Problem+json responses and the exception handlers that produce them (ADR-0006)."""

from __future__ import annotations

import logging
import socket
from typing import Any, cast

import sqlalchemy.exc
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.logging import APP_LOGGER
from app.core.middleware import problem_code_ctx, request_id_ctx
from app.domain.errors import CATALOGUE_BY_CODE, DomainError

PROBLEM_MEDIA_TYPE = "application/problem+json"

# Exceptions that mean "the database is unreachable", mapped to 503 (§5).
DB_UNAVAILABLE_EXCEPTIONS: tuple[type[Exception], ...] = (
    sqlalchemy.exc.TimeoutError,
    sqlalchemy.exc.OperationalError,
    sqlalchemy.exc.InterfaceError,
    sqlalchemy.exc.DisconnectionError,
    ConnectionError,
    socket.gaierror,
    OSError,
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
    return JSONResponse(
        status_code=spec.status,
        content=body,
        media_type=PROBLEM_MEDIA_TYPE,
        headers=headers,
    )


async def _domain_error_handler(request: Request, exc: Exception) -> JSONResponse:
    exc = cast(DomainError, exc)
    headers = {"Retry-After": "2"} if exc.code == "DB_UNAVAILABLE" else None
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
    # Any other Starlette HTTP error: keep the shape, pick a catalogue code by class.
    code = "DB_UNAVAILABLE" if exc.status_code == 503 else "INTERNAL_ERROR"
    return build_problem(request, code)


async def _db_unavailable_handler(request: Request, exc: Exception) -> JSONResponse:
    return build_problem(request, "DB_UNAVAILABLE", headers={"Retry-After": "2"})


async def _catch_all_handler(request: Request, exc: Exception) -> JSONResponse:
    # Opaque body; the trace is logged under request_id, without bound parameters.
    logging.getLogger(APP_LOGGER).error(
        "unhandled exception",
        exc_info=exc,
        extra={"request_id": _request_id(request)},
    )
    return build_problem(request, "INTERNAL_ERROR")


def register_exception_handlers(app: FastAPI) -> None:
    app.add_exception_handler(DomainError, _domain_error_handler)
    app.add_exception_handler(RequestValidationError, _validation_handler)
    app.add_exception_handler(StarletteHTTPException, _http_exception_handler)
    for exc_type in DB_UNAVAILABLE_EXCEPTIONS:
        app.add_exception_handler(exc_type, _db_unavailable_handler)
    app.add_exception_handler(Exception, _catch_all_handler)
