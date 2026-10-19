"""Application factory.

Doc URLs are fixed: root_path is empty and the spec/docs live at the documented
paths. The public web origin serves static copies of the committed contract; FastAPI's own
routes stay for local use and the tag-URL smoke.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import FastAPI

from app.api.routers import (
    admin,
    appointments,
    doctors,
    health,
    me,
    ops,
    patients,
    problems,
    realtime,
    reminders,
    smoke,
    staff,
)
from app.core.clinic_zone import set_default_zone
from app.core.config import Settings
from app.core.cors import add_cors
from app.core.logging import configure_logging
from app.core.middleware import RequestContextMiddleware
from app.core.problems import UnhandledErrorMiddleware, register_exception_handlers
from app.schemas.events import EVENT_MODELS
from app.schemas.problem import (
    fill_lead_time,
    fill_problem_examples,
    strip_json_from_error_responses,
)
from app.services.publisher import build_publisher
from app.services.realtime_tokens import MinuteLimiter


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
    app.state.publisher = build_publisher(
        settings.ABLY_API_KEY.get_secret_value() if settings.ABLY_API_KEY else None,
        settings.ABLY_REST_URL,
        timeout=settings.REALTIME_RELAY_TIMEOUT_SECONDS,
    )
    app.state.relay = None
    app.state.patient_token_limiter = MinuteLimiter(settings.REALTIME_TOKEN_PER_MINUTE)
    # Only for patient.created_at and access granted_at/revoked_at (they belong to no clinic).
    set_default_zone(settings.DEFAULT_CLINIC_TZ)

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
    app.include_router(admin.router)
    app.include_router(ops.router)
    app.include_router(admin.identity_router)
    app.include_router(admin.manage_router)
    app.include_router(admin.access_router)
    app.include_router(staff.appointments_router)
    app.include_router(staff.doctors_router)
    app.include_router(staff.invites_router)
    app.include_router(staff.audit_router)
    app.include_router(me.router)
    app.include_router(realtime.router)
    app.include_router(realtime.admin_router)
    app.include_router(reminders.router)
    app.include_router(smoke.router)

    # Error responses carry only application/problem+json in the served spec, too.
    _default_openapi = app.openapi

    def _openapi() -> dict[str, object]:
        schema = _default_openapi()
        strip_json_from_error_responses(schema)
        fill_problem_examples(schema, str(settings.PUBLIC_BASE_URL))
        fill_lead_time(schema, settings.BOOKING_MIN_LEAD_MINUTES)
        # The pushed messages never appear in a response body, so add them to the components: the
        # generated clients then carry their types and zod schemas.
        components = schema.setdefault("components", {})
        assert isinstance(components, dict)  # noqa: S101  # FastAPI always builds a mapping
        schemas = components.setdefault("schemas", {})
        for name, model in EVENT_MODELS.items():
            schemas[name] = model.model_json_schema(ref_template="#/components/schemas/{model}")
        return schema

    app.openapi = _openapi  # type: ignore[method-assign]  # FastAPI documents replacing openapi() this way
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
