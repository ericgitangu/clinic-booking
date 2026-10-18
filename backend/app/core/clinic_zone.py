"""The zone used for timestamps that belong to no clinic.

Appointments and availability are rendered in their own doctor's clinic zone (``clinics.timezone``,
resolved in the same query that loads them). A few resources have no clinic at all (a patient's
``created_at``, staff access grants); those use ``DEFAULT_CLINIC_TZ`` from configuration. It is
set once by ``create_app``.
"""

from __future__ import annotations

from zoneinfo import ZoneInfo

_default: ZoneInfo = ZoneInfo("UTC")


def set_default_zone(name: str) -> None:
    global _default
    _default = ZoneInfo(name)


def default_zone() -> ZoneInfo:
    return _default
