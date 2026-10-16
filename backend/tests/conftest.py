"""Test fixtures.

WP-04 provides DB connection helpers driven by the environment (CI uses localhost:5432; a
local dev DB on another port is set via TEST_DB_PORT). WP-06 extends this with the ASGI
client and FakeClock.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator

import asyncpg
import pytest_asyncio

TEST_DB_HOST = os.environ.get("TEST_DB_HOST", "localhost")
TEST_DB_PORT = int(os.environ.get("TEST_DB_PORT", "5432"))
TEST_DB_NAME = os.environ.get("TEST_DB_NAME", "clinic")

OWNER_USER = os.environ.get("TEST_OWNER_USER", "clinic")
OWNER_PASSWORD = os.environ.get("TEST_OWNER_PASSWORD", "clinic")
APP_USER = os.environ.get("TEST_APP_USER", "clinic_app")
APP_PASSWORD = os.environ.get("TEST_APP_PASSWORD", "clinic_app_local")


def owner_dsn(dbname: str = TEST_DB_NAME) -> str:
    return f"postgresql://{OWNER_USER}:{OWNER_PASSWORD}@{TEST_DB_HOST}:{TEST_DB_PORT}/{dbname}"


def app_dsn(dbname: str = TEST_DB_NAME) -> str:
    return f"postgresql://{APP_USER}:{APP_PASSWORD}@{TEST_DB_HOST}:{TEST_DB_PORT}/{dbname}"


def owner_sqlalchemy_url(dbname: str = TEST_DB_NAME) -> str:
    return (
        f"postgresql+asyncpg://{OWNER_USER}:{OWNER_PASSWORD}@{TEST_DB_HOST}:{TEST_DB_PORT}/{dbname}"
    )


@pytest_asyncio.fixture
async def owner_conn() -> AsyncIterator[asyncpg.Connection]:
    conn = await asyncpg.connect(owner_dsn())
    try:
        yield conn
    finally:
        await conn.close()


@pytest_asyncio.fixture
async def app_conn() -> AsyncIterator[asyncpg.Connection]:
    conn = await asyncpg.connect(app_dsn())
    try:
        yield conn
    finally:
        await conn.close()


# --- WP-06: ASGI client + FakeClock -----------------------------------------------------
from datetime import UTC, datetime  # noqa: E402

import httpx  # noqa: E402

from app.core.clock import FakeClock  # noqa: E402
from app.core.config import Settings  # noqa: E402

# app.main builds a module-level app from the environment (for the uvicorn CMD); give it a
# value so importing it under pytest never fails. Tests build their own Settings.
os.environ.setdefault("DATABASE_URL", owner_sqlalchemy_url())

from app.main import create_app  # noqa: E402

TEST_PUBLIC_BASE_URL = "http://testserver"


def make_settings(**overrides: object) -> Settings:
    base: dict[str, object] = {
        "DATABASE_URL": owner_sqlalchemy_url(),
        "PUBLIC_BASE_URL": TEST_PUBLIC_BASE_URL,
        "WEB_ORIGIN": "http://localhost:3000",
    }
    base.update(overrides)
    return Settings(**base)  # type: ignore[arg-type]


@pytest_asyncio.fixture
async def client() -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(make_settings())
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url=TEST_PUBLIC_BASE_URL) as c:
        yield c


@pytest_asyncio.fixture
def clock() -> FakeClock:
    return FakeClock(datetime(2026, 10, 19, 4, 0, tzinfo=UTC))  # Mon 07:00 EAT
