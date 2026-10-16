"""Shared FastAPI dependencies."""

from __future__ import annotations

from collections.abc import AsyncIterator

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import Clock, SystemClock
from app.core.config import Settings
from app.db.session import get_sessionmaker


def get_settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    sessionmaker = get_sessionmaker(request.app.state.settings)
    async with sessionmaker() as session:
        yield session


def get_clock() -> Clock:
    # Overridden with a FakeClock in tests via app.dependency_overrides.
    return SystemClock()
