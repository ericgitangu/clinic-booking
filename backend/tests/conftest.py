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
