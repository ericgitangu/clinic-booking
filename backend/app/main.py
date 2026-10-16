"""Application factory.

Doc URLs are fixed (§12.4): root_path is empty and the spec/docs live at the documented
paths. The public web origin serves static copies of the committed contract; FastAPI's own
routes stay for local use and the tag-URL smoke.
"""

from __future__ import annotations

from fastapi import FastAPI

from app.api.routers import appointments, doctors, health, patients, problems
from app.core.config import Settings
from app.core.cors import add_cors
from app.core.logging import configure_logging
from app.core.middleware import RequestContextMiddleware
from app.core.problems import register_exception_handlers
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

    # CORS first, then request-context middleware so the latter is outermost (it sets the
    # request id and emits the access log for every request).
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


def _app_from_env() -> FastAPI:
    # pydantic-settings populates required fields from the environment at runtime.
    return create_app(Settings())


app = _app_from_env()
