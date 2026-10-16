"""Liveness (/healthz, never touches the DB) and readiness (/readyz, runs SELECT 1)."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel
from sqlalchemy import text

from app.db.session import get_engine
from app.schemas.problem import problem_responses

router = APIRouter(tags=["health"])


class Health(BaseModel):
    status: Literal["ok"]


@router.get("/healthz", response_model=Health)
async def healthz() -> Health:
    """Liveness. Never touches the DB, so it never wakes Neon."""
    return Health(status="ok")


@router.get("/readyz", response_model=Health, responses=problem_responses(503))
async def readyz(request: Request) -> Health:
    """Readiness. A failed SELECT 1 propagates to the DB_UNAVAILABLE handler (503)."""
    engine = get_engine(request.app.state.settings)
    async with engine.connect() as conn:
        await conn.execute(text("SELECT 1"))
    return Health(status="ok")
