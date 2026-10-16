"""Application factory.

Doc URLs are fixed: root_path is empty and the spec/docs live at the documented
paths. The public web origin serves static copies of the committed contract; FastAPI's own
routes stay for local use and the tag-URL smoke.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import FastAPI

from app.api.routers import appointments, doctors, health, patients, problems
from app.core.config import Settings
from app.core.cors import add_cors
from app.core.logging import configure_logging
from app.core.middleware import RequestContextMiddleware
from app.core.problems import UnhandledErrorMiddleware, register_exception_handlers
from app.schemas.problem import strip_json_from_error_responses


def create_app(settings: Settings) -> FastAPI:
    configure_logging(settings.LOG_LEVEL)
    app = FastAPI(
        title="Clinic Booking API",
        version="1.0.0",
        root_path="",
        openapi_url="/openapi.json",
        docs_url="/docs",
        redoc_url="/redoc",
    )
    app.state.settings = settings

    # Added innermost-first: unhandled-error -> CORS -> request-context (outermost, so it sets
    # the request id and logs every request, including a 500 turned into a response here).
    app.add_middleware(UnhandledErrorMiddleware)
    add_cors(app, settings)
    app.add_middleware(RequestContextMiddleware)
    register_exception_handlers(app)

    app.include_router(health.router)
    app.include_router(problems.router)
    app.include_router(doctors.router)
    app.include_router(patients.router)
    app.include_router(appointments.router)

    # Error responses carry only application/problem+json in the served spec, too.
    _default_openapi = app.openapi

    def _openapi() -> dict[str, object]:
        schema = _default_openapi()
        strip_json_from_error_responses(schema)
        return schema

    app.openapi = _openapi  # type: ignore[method-assign]
    return app


_app: FastAPI | None = None


def __getattr__(name: str) -> FastAPI:
    """Build the ASGI app on first access to ``app.main:app`` (what uvicorn imports).

    Importing this module for ``create_app`` (tests, the OpenAPI export) must not require the
    runtime environment, so the settings are read only when the served app is actually asked for.
    """
    global _app
    if name != "app":
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    if _app is None:
        # pydantic-settings populates the required fields from the environment.
        _app = create_app(Settings())
    return _app


if TYPE_CHECKING:
    app: FastAPI
