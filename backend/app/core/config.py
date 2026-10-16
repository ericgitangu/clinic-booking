"""Application configuration (pydantic-settings).

A single ``Settings`` object is the system of record for runtime config. Values come from
the environment; ``.env.example`` documents every one. There are no secrets in the repo.
"""

from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# asyncpg does not accept these DSN query params; libpq-style users expect them, so we
# reject them loudly rather than letting asyncpg raise an opaque error at connect time.
_BANNED_DSN_PARAMS = ("sslmode", "channel_binding")


class Settings(BaseSettings):
    """Runtime configuration. Immutable after construction."""

    model_config = SettingsConfigDict(
        env_file=None,
        extra="ignore",
        frozen=True,
        # Never render the input (which includes the DSN password) into a ValidationError
        # that could reach startup logs/stderr.
        hide_input_in_errors=True,
    )

    DATABASE_URL: str = Field(..., description="postgresql+asyncpg://…?ssl=require")
    DB_POOL_SIZE: int = 5
    BOOKING_MIN_LEAD_MINUTES: int = 60
    BOOKING_HORIZON_DAYS: int = 90
    WEB_ORIGIN: str = "http://localhost:3000"
    PUBLIC_BASE_URL: str = "http://localhost:8080"
    LOG_LEVEL: str = "info"
    GIT_SHA: str = "unknown"

    @field_validator("DATABASE_URL")
    @classmethod
    def _reject_libpq_params(cls, value: str) -> str:
        query = parse_qs(urlsplit(value).query)
        offending = [p for p in _BANNED_DSN_PARAMS if p in query]
        if offending:
            raise ValueError(
                f"DATABASE_URL must not set {', '.join(offending)}: asyncpg does not accept "
                "these libpq params. Use '?ssl=require' instead."
            )
        return value

    @property
    def cors_origins(self) -> list[str]:
        origins = [self.WEB_ORIGIN]
        if "http://localhost:3000" not in origins:
            origins.append("http://localhost:3000")
        return origins
