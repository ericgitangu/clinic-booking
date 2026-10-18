"""Application configuration (pydantic-settings).

A single ``Settings`` object is the system of record for runtime config. Values come from
the environment; ``.env.example`` documents every one. There are no secrets in the repo.
"""

from __future__ import annotations

from urllib.parse import parse_qs, urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import Field, SecretStr, ValidationInfo, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# asyncpg does not accept these DSN query params; libpq-style users expect them, so we
# reject them loudly rather than letting asyncpg raise an opaque error at connect time.
_BANNED_DSN_PARAMS = ("sslmode", "channel_binding")
_MIN_SIGNING_KEY_CHARS = 32

# Hard ceiling on publishes to the push service per calendar month, enforced by this API (table
# realtime_publish_budget), so the free-tier bound does not rest on how the push service behaves
# when its own cap is reached. Each publish is delivered to every connected subscriber, and the
# service caps connections at 200 (that cap is refused by the service), so one publish costs at
# most 1 + 200 messages: 25,000 x (1 + 200) = 5,025,000, below the 6,000,000 messages a month of
# the free package. Raising it past this value is refused at start-up; the independent monitor
# in CI asserts the same arithmetic.
REALTIME_PUBLISH_CAP_CEILING = 25_000
ABLY_FREE_MONTHLY_MESSAGES = 6_000_000
ABLY_FREE_CONNECTIONS = 200


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
    # The email provider's free plan allows 100 a day, shared by acknowledgements and reminders. A
    # reminder run claims at most REMINDER_RUN_LIMIT, and never more than what is left of the day.
    EMAIL_DAILY_LIMIT: int = 100
    # ... and 3,000 a month (https://resend.com/docs/knowledge-base/account-quotas-and-limits),
    # counted by calendar month (UTC) in ``email_month_counter``; the same reserve is kept.
    EMAIL_MONTHLY_LIMIT: int = 3000
    REMINDER_RUN_LIMIT: int = 50
    # Kept free of reminders so acknowledgements sent later in the day always have room.
    EMAIL_ACK_RESERVE: int = 20
    REMINDER_LEASE_MINUTES: int = 15
    WEB_ORIGIN: str = "http://localhost:3000"
    PUBLIC_BASE_URL: str = "http://localhost:8080"
    # Zone for timestamps that belong to no clinic, and nothing else: a patient's created_at and
    # staff access granted_at/revoked_at. Appointments, availability, lineage and the dashboard's
    # day ranges all use their own doctor's clinics.timezone.
    DEFAULT_CLINIC_TZ: str = "Africa/Nairobi"
    LOG_LEVEL: str = "info"
    GIT_SHA: str = "unknown"
    # HMAC key shared with the web apps' server side. Unset means every /internal/* call is
    # refused (fail closed), so a deployment without the key cannot be reached by accident.
    INTERNAL_SIGNING_KEY: SecretStr | None = None
    # A second, separate HMAC key held only by the release pipeline's smoke test. It signs the one
    # call that may create a synthetic patient (/internal/smoke/patients) and nothing else, so a
    # leak of it cannot forge an admin or patient assertion. Unset means that call is refused.
    SMOKE_SIGNING_KEY: SecretStr | None = None
    # Comma-separated owner emails. An owner is always `owner`, needs no staff_access row and can
    # never be granted, changed or revoked through the API. Must match the admin app's variable.
    ADMIN_EMAILS: str = ""

    # Push service (Ably). Unset means "push disabled, polling only": a real configuration state,
    # not a failure. The key is a secret and is never logged.
    ABLY_API_KEY: SecretStr | None = None
    ABLY_REST_URL: str = "https://main.realtime.ably.net"
    ABLY_STREAM_URL: str = "https://main.realtime.ably.net/event-stream"
    REALTIME_PUBLISH_CAP_PER_MONTH: int = REALTIME_PUBLISH_CAP_CEILING
    # The relay runs inline after a committing write; it must never hold the response for long.
    REALTIME_RELAY_TIMEOUT_SECONDS: float = 2.0
    # An event older than this is not pushed (clients' safety-net poll covers it): after a long
    # outage or a period with push disabled the backlog is dropped, not replayed.
    REALTIME_MAX_EVENT_AGE_SECONDS: int = 600
    REALTIME_TOKEN_PER_MINUTE: int = 10
    REALTIME_TOKEN_DAILY_CAP: int = 500

    @field_validator("ABLY_API_KEY", mode="before")
    @classmethod
    def _empty_key_is_unset(cls, value: object) -> object:
        return None if value is None or (isinstance(value, str) and value.strip() == "") else value

    @field_validator("REALTIME_PUBLISH_CAP_PER_MONTH")
    @classmethod
    def _cap_within_ceiling(cls, value: int) -> int:
        if not 0 <= value <= REALTIME_PUBLISH_CAP_CEILING:
            raise ValueError(
                "REALTIME_PUBLISH_CAP_PER_MONTH must be between 0 and "
                f"{REALTIME_PUBLISH_CAP_CEILING}"
                " (the free-tier message arithmetic is recorded in app/core/config.py)."
            )
        return value

    @field_validator("INTERNAL_SIGNING_KEY", "SMOKE_SIGNING_KEY", mode="before")
    @classmethod
    def _signing_key_strength(cls, value: object, info: ValidationInfo) -> object:
        # An empty variable (compose passes `${VAR:-}`) means "not configured", never an empty key.
        if value is None or (isinstance(value, str) and value == ""):
            return None
        raw = value.get_secret_value() if isinstance(value, SecretStr) else value
        if not isinstance(raw, str) or len(raw) < _MIN_SIGNING_KEY_CHARS:
            raise ValueError(
                f"{info.field_name} must be at least {_MIN_SIGNING_KEY_CHARS} characters."
            )
        return value

    @model_validator(mode="after")
    def _keys_differ(self) -> Settings:
        # One key per power: the smoke key must never also open the admin and patient endpoints.
        if (
            self.SMOKE_SIGNING_KEY is not None
            and self.INTERNAL_SIGNING_KEY is not None
            and self.SMOKE_SIGNING_KEY.get_secret_value()
            == self.INTERNAL_SIGNING_KEY.get_secret_value()
        ):
            raise ValueError("SMOKE_SIGNING_KEY must differ from INTERNAL_SIGNING_KEY.")
        return self

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
