"""DATABASE_URL must be the asyncpg form, without libpq-only query parameters."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.core.config import Settings

GOOD = "postgresql+asyncpg://user:pw@host.example/clinic?ssl=require"


def test_accepts_the_asyncpg_form() -> None:
    assert Settings(DATABASE_URL=GOOD).DATABASE_URL == GOOD


@pytest.mark.parametrize(
    "url",
    [
        # What the Neon console hands out: selects the psycopg driver, which is not installed.
        "postgresql://user:pw@host.example/clinic?sslmode=require",
        "postgresql://user:pw@host.example/clinic?ssl=require",
        "postgres://user:pw@host.example/clinic",
        "bogus",
        "",
    ],
)
def test_rejects_other_schemes(url: str) -> None:
    with pytest.raises(ValidationError) as exc:
        Settings(DATABASE_URL=url)
    assert "postgresql+asyncpg://" in str(exc.value)


@pytest.mark.parametrize("param", ["sslmode=require", "channel_binding=require"])
def test_rejects_libpq_only_parameters(param: str) -> None:
    with pytest.raises(ValidationError) as exc:
        Settings(DATABASE_URL=f"postgresql+asyncpg://user:pw@host/clinic?ssl=require&{param}")
    assert param.split("=")[0] in str(exc.value)


def test_a_rejected_url_never_echoes_the_password() -> None:
    with pytest.raises(ValidationError) as exc:
        Settings(DATABASE_URL="postgresql://user:s3cr3t-pw@host/clinic?sslmode=require")
    assert "s3cr3t-pw" not in str(exc.value)


def test_the_email_limits_must_cover_the_reserve() -> None:
    import pytest
    from pydantic import ValidationError

    from tests.conftest import make_settings

    make_settings(EMAIL_DAILY_LIMIT=20, EMAIL_ACK_RESERVE=20)  # exactly the reserve is allowed
    # The reserve is a day reserve: a small month limit is not refused because of it.
    make_settings(EMAIL_MONTHLY_LIMIT=10, EMAIL_ACK_RESERVE=20)
    for bad in (
        {"EMAIL_DAILY_LIMIT": 19, "EMAIL_ACK_RESERVE": 20},
        {"EMAIL_ACK_RESERVE": -1},
    ):
        with pytest.raises(ValidationError):
            make_settings(**bad)
