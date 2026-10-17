"""The clinic's IANA zone for the current request (the zone is data, not code).

``bind_clinic_zone`` reads it from ``clinics.timezone`` once per request; response timestamps are
then rendered in that zone's offset. The context variable is set in the request's own task, so
concurrent requests never see each other's value.
"""

from __future__ import annotations

from contextvars import ContextVar
from zoneinfo import ZoneInfo

_UTC = ZoneInfo("UTC")
_zone: ContextVar[ZoneInfo | None] = ContextVar("clinic_zone", default=None)


def set_clinic_zone(zone: ZoneInfo) -> None:
    _zone.set(zone)


def current_clinic_zone() -> ZoneInfo:
    """The zone bound for this request; UTC outside a request that bound one."""
    return _zone.get() or _UTC
