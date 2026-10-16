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


from app.api.deps import get_clock  # noqa: E402
from app.db.session import dispose_engine  # noqa: E402

FIXED_NOW = datetime(2026, 10, 19, 4, 0, tzinfo=UTC)  # Mon 07:00 EAT


def app_sqlalchemy_url(dbname: str = TEST_DB_NAME) -> str:
    return f"postgresql+asyncpg://{APP_USER}:{APP_PASSWORD}@{TEST_DB_HOST}:{TEST_DB_PORT}/{dbname}"


def make_settings(**overrides: object) -> Settings:
    # The app runs as the clinic_app role, like prod.
    base: dict[str, object] = {
        "DATABASE_URL": app_sqlalchemy_url(),
        "PUBLIC_BASE_URL": TEST_PUBLIC_BASE_URL,
        "WEB_ORIGIN": "http://localhost:3000",
    }
    base.update(overrides)
    return Settings(**base)  # type: ignore[arg-type]


@pytest_asyncio.fixture(autouse=True)
async def _dispose_engine_between_tests() -> AsyncIterator[None]:
    # The engine is a module global; pytest-asyncio gives each test a fresh event loop, so
    # dispose it after every test to avoid reusing a pool bound to a closed loop.
    yield
    await dispose_engine()


@pytest_asyncio.fixture
async def app_with_clock() -> AsyncIterator[object]:
    app = create_app(make_settings())
    app.dependency_overrides[get_clock] = lambda: FakeClock(FIXED_NOW)
    yield app
    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def client(app_with_clock: object) -> AsyncIterator[httpx.AsyncClient]:
    # raise_app_exceptions=False so a handled 500 comes back as a response (real-server
    # behaviour) instead of being re-raised into the test by Starlette's error middleware.
    transport = httpx.ASGITransport(app=app_with_clock, raise_app_exceptions=False)  # type: ignore[arg-type]
    async with httpx.AsyncClient(transport=transport, base_url=TEST_PUBLIC_BASE_URL) as c:
        yield c


@pytest_asyncio.fixture
async def reset_appointments() -> None:
    # Clear only the mutable appointment tables (owner); seed rows are untouched.
    conn = await asyncpg.connect(owner_dsn())
    try:
        await conn.execute("TRUNCATE appointment_events, appointments RESTART IDENTITY CASCADE")
    finally:
        await conn.close()


@pytest_asyncio.fixture
def clock() -> FakeClock:
    return FakeClock(FIXED_NOW)


# --- WP-07 helpers ----------------------------------------------------------------------
import uuid as _uuid  # noqa: E402

import httpx as _httpx  # noqa: E402

from app.scripts.seed import NAMESPACE  # noqa: E402


def seeded_doctor_id(key: str) -> _uuid.UUID:
    return _uuid.uuid5(NAMESPACE, f"doctor:{key}")


def seeded_patient_id(key: str) -> _uuid.UUID:
    return _uuid.uuid5(NAMESPACE, f"patient:{key}")


async def first_available(
    client: _httpx.AsyncClient, doctor_id: _uuid.UUID
) -> tuple[str, dict[str, str]]:
    """First clinic-local date (from the FakeClock's tomorrow) with >= 1 slot, and slot[0]."""
    day = datetime(2026, 10, 20, tzinfo=UTC).date()
    for _ in range(14):
        resp = await client.get(f"/doctors/{doctor_id}/availability?date={day.isoformat()}")
        slots = resp.json()["slots"]
        if slots:
            return day.isoformat(), slots[0]
        day = day.fromordinal(day.toordinal() + 1)
    raise AssertionError("no availability in the next 14 days")
