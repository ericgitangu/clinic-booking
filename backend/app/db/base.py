"""Declarative base. Models are mapped for the app; the schema itself is owned by the
hand-written migrations in ``migrations/versions`` (autogenerate is never used)."""

from __future__ import annotations

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass
