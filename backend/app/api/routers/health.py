"""Liveness endpoint. ``/readyz`` (DB check) is added in WP-06."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(tags=["health"])


class Health(BaseModel):
    status: Literal["ok"]


@router.get("/healthz", response_model=Health)
async def healthz() -> Health:
    """Never touches the DB."""
    return Health(status="ok")
