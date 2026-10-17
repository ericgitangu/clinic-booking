"""Application configuration (pydantic-settings).

A single ``Settings`` object is the system of record for runtime config. Values come from
the environment; ``.env.example`` documents every one. There are no secrets in the repo.
"""

from __future__ import annotations

from urllib.parse import parse_qs, urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# asyncpg does not accept these DSN query params; libpq-style users expect them, so we
# reject them loudly rather than letting asyncpg raise an opaque error at connect time.
_BANNED_DSN_PARAMS = ("sslmode", "channel_binding")
_MIN_SIGNING_KEY_CHARS = 32


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
    # Used only while the clinics table is empty; otherwise the clinic row's timezone decides.
    DEFAULT_CLINIC_TZ: str = "Africa/Nairobi"
    LOG_LEVEL: str = "info"
    GIT_SHA: str = "unknown"
    # HMAC key shared with the web apps' server side. Unset means every /internal/* call is
    # refused (fail closed), so a deployment without the key cannot be reached by accident.
    INTERNAL_SIGNING_KEY: SecretStr | None = None
    # Comma-separated owner emails. An owner is always `owner`, needs no staff_access row and can
    # never be granted, changed or revoked through the API. Must match the admin app's variable.
    ADMIN_EMAILS: str = ""

    @field_validator("INTERNAL_SIGNING_KEY", mode="before")
    @classmethod
    def _signing_key_strength(cls, value: object) -> object:
        # An empty variable (compose passes `${VAR:-}`) means "not configured", never an empty key.
        if value is None or (isinstance(value, str) and value == ""):
            return None
        raw = value.get_secret_value() if isinstance(value, SecretStr) else value
        if not isinstance(raw, str) or len(raw) < _MIN_SIGNING_KEY_CHARS:
            raise ValueError(
                f"INTERNAL_SIGNING_KEY must be at least {_MIN_SIGNING_KEY_CHARS} characters."
            )
        return value

    @field_validator("DEFAULT_CLINIC_TZ")
    @classmethod
    def _known_zone(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError(f"DEFAULT_CLINIC_TZ is not an IANA zone: {value!r}") from exc
        return value

    @field_validator("DATABASE_URL")
    @classmethod
    def _require_asyncpg_url(cls, value: str) -> str:
        # The engine is built with create_async_engine, so the URL must select the asyncpg
        # driver. A plain "postgresql://" (what Neon's console hands out) selects psycopg, which
        # is not installed, and the first migrate would crash on it.
        if not value.startswith("postgresql+asyncpg://"):
            raise ValueError(
                "DATABASE_URL must start with 'postgresql+asyncpg://' "
                "(for example postgresql+asyncpg://USER:PASSWORD@HOST/DB?ssl=require)."
            )
        return value

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
    def owner_emails(self) -> frozenset[str]:
        return frozenset(e.strip().lower() for e in self.ADMIN_EMAILS.split(",") if e.strip())

    @property
    def cors_origins(self) -> list[str]:
        # Only the configured web origin. WEB_ORIGIN defaults to http://localhost:3000, so local
        # development works unchanged, while a deployed API never also trusts localhost.
        return [self.WEB_ORIGIN]
