"""CORS configuration. Starlette's CORSMiddleware is pure ASGI (not BaseHTTPMiddleware)."""

from __future__ import annotations

from fastapi import FastAPI
from starlette.middleware.cors import CORSMiddleware

from app.core.config import Settings


def add_cors(app: FastAPI, settings: Settings) -> None:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST", "PATCH", "OPTIONS"],
        allow_headers=["Content-Type", "Idempotency-Key", "X-Request-ID"],
        expose_headers=["Location", "X-Request-ID", "Retry-After", "Idempotent-Replayed"],
        allow_credentials=False,
    )
