"""Test fixtures.

DB connection helpers are driven by the environment (CI uses localhost:5432; a local dev DB
on another port is set via TEST_DB_PORT). Also provides the ASGI client and FakeClock.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime
from typing import Any

import asyncpg
import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI

from app.api.deps import get_clock
from app.core.clock import FakeClock
from app.core.config import Settings
from app.db.session import dispose_engine
from app.main import create_app
from app.scripts.seed import DEMO_PATIENTS, NAMESPACE

TEST_DB_HOST = os.environ.get("TEST_DB_HOST", "localhost")
TEST_DB_PORT = int(os.environ.get("TEST_DB_PORT", "5432"))
TEST_DB_NAME = os.environ.get("TEST_DB_NAME", "clinic")

OWNER_USER = os.environ.get("TEST_OWNER_USER", "clinic")
OWNER_PASSWORD = os.environ.get("TEST_OWNER_PASSWORD", "clinic")
APP_USER = os.environ.get("TEST_APP_USER", "clinic_app")
APP_PASSWORD = os.environ.get("TEST_APP_PASSWORD", "clinic_app_local")

TEST_PUBLIC_BASE_URL = "http://testserver"
FIXED_NOW = datetime(2026, 10, 19, 4, 0, tzinfo=UTC)  # Mon 07:00 EAT
# For checking that a test does not depend on how far the wall clock is from FIXED_NOW: run it with
# TEST_FIXED_NOW set to the database's own time. Most tests need the Monday above, so use this on
# a chosen test, not the whole suite.
if "TEST_FIXED_NOW" in os.environ:
    FIXED_NOW = datetime.fromisoformat(os.environ["TEST_FIXED_NOW"])

# Set by the fixtures that open the shared database, so the end-of-session cleanup only ever
# touches a database this run actually used.
_db_used = False


def owner_dsn(dbname: str = TEST_DB_NAME) -> str:
    return f"postgresql://{OWNER_USER}:{OWNER_PASSWORD}@{TEST_DB_HOST}:{TEST_DB_PORT}/{dbname}"


def app_dsn(dbname: str = TEST_DB_NAME) -> str:
    return f"postgresql://{APP_USER}:{APP_PASSWORD}@{TEST_DB_HOST}:{TEST_DB_PORT}/{dbname}"


def owner_sqlalchemy_url(dbname: str = TEST_DB_NAME) -> str:
    return (
        f"postgresql+asyncpg://{OWNER_USER}:{OWNER_PASSWORD}@{TEST_DB_HOST}:{TEST_DB_PORT}/{dbname}"
    )


def app_sqlalchemy_url(dbname: str = TEST_DB_NAME) -> str:
    return f"postgresql+asyncpg://{APP_USER}:{APP_PASSWORD}@{TEST_DB_HOST}:{TEST_DB_PORT}/{dbname}"


def _mark_db_used() -> None:
    global _db_used
    _db_used = True


async def _remove_test_rows() -> None:
    """Drop everything the suite created, keeping only the seeded reference data."""
    conn = await asyncpg.connect(owner_dsn())
    try:
        await conn.execute("TRUNCATE appointment_events, appointments RESTART IDENTITY CASCADE")
        await conn.execute("TRUNCATE staff_access, staff_access_audit RESTART IDENTITY")
        await conn.execute("TRUNCATE patient_accounts")
        await conn.execute("TRUNCATE realtime_publish_budget, realtime_token_cap")
        keep = [uuid.uuid5(NAMESPACE, f"patient:{key}") for key, _ in DEMO_PATIENTS]
        await conn.execute("DELETE FROM patients WHERE id <> ALL($1::uuid[])", keep)
    finally:
        await conn.close()


@pytest.fixture(scope="session", autouse=True)
def _clean_database_after_session() -> Iterator[None]:
    # Race, fuzz and contract tests create patients and appointments in the shared database;
    # without this they accumulate across runs.
    yield
    if _db_used:
        asyncio.run(_remove_test_rows())


@pytest_asyncio.fixture
async def owner_conn() -> AsyncIterator[asyncpg.Connection]:
    _mark_db_used()
    conn = await asyncpg.connect(owner_dsn())
    try:
        yield conn
    finally:
        await conn.close()


@pytest_asyncio.fixture
async def app_conn() -> AsyncIterator[asyncpg.Connection]:
    _mark_db_used()
    conn = await asyncpg.connect(app_dsn())
    try:
        yield conn
    finally:
        await conn.close()


# --- ASGI client + FakeClock ------------------------------------------------------------


def make_settings(**overrides: object) -> Settings:
    # The app runs as the clinic_app role, like prod.
    _mark_db_used()
    base: dict[str, Any] = {
        "DATABASE_URL": app_sqlalchemy_url(),
        "PUBLIC_BASE_URL": TEST_PUBLIC_BASE_URL,
        "WEB_ORIGIN": "http://localhost:3000",
    }
    base.update(overrides)
    return Settings(**base)


@pytest_asyncio.fixture(autouse=True)
async def _dispose_engine_between_tests() -> AsyncIterator[None]:
    # The engine is a module global; pytest-asyncio gives each test a fresh event loop, so
    # dispose it after every test to avoid reusing a pool bound to a closed loop.
    yield
    await dispose_engine()


@pytest_asyncio.fixture
async def app_with_clock() -> AsyncIterator[FastAPI]:
    _mark_db_used()
    app = create_app(make_settings())
    app.dependency_overrides[get_clock] = lambda: FakeClock(FIXED_NOW)
    yield app
    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def client(app_with_clock: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    # raise_app_exceptions=False so a handled 500 comes back as a response (real-server
    # behaviour) instead of being re-raised into the test by Starlette's error middleware.
    transport = httpx.ASGITransport(app=app_with_clock, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url=TEST_PUBLIC_BASE_URL) as c:
        yield c


@pytest_asyncio.fixture
async def reset_appointments() -> None:
    # Clear only the mutable appointment tables (owner); seed rows are untouched.
    _mark_db_used()
    conn = await asyncpg.connect(owner_dsn())
    try:
        await conn.execute("TRUNCATE appointment_events, appointments RESTART IDENTITY CASCADE")
    finally:
        await conn.close()


@pytest_asyncio.fixture
async def realtime_clean(owner_conn: asyncpg.Connection) -> AsyncIterator[None]:
    """A clean realtime state: no budget or token-cap rows, the relay cursor at the horizon."""
    await owner_conn.execute("TRUNCATE realtime_publish_budget, realtime_token_cap")
    await owner_conn.execute("TRUNCATE appointment_events, appointments RESTART IDENTITY CASCADE")
    await owner_conn.execute(
        "UPDATE event_relay_cursor SET txid = pg_snapshot_xmin(pg_current_snapshot()), id = 0, "
        "debited_txid = pg_snapshot_xmin(pg_current_snapshot()), debited_id = 0"
    )
    yield
    await owner_conn.execute("TRUNCATE realtime_publish_budget, realtime_token_cap")


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock(FIXED_NOW)


# --- Booking-flow helpers ---------------------------------------------------------------


def seeded_doctor_id(key: str) -> uuid.UUID:
    return uuid.uuid5(NAMESPACE, f"doctor:{key}")


def seeded_patient_id(key: str) -> uuid.UUID:
    return uuid.uuid5(NAMESPACE, f"patient:{key}")


async def first_available(
    client: httpx.AsyncClient, doctor_id: uuid.UUID
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
