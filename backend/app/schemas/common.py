"""Shared schema helpers.

``AwareDatetime`` input is a str with an offset. A BeforeValidator rejects any
non-str value with a VALIDATION_ERROR; a naive string is then caught by pydantic's
timezone-aware check, which the handler maps to TIMEZONE_REQUIRED.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated
from zoneinfo import ZoneInfo

from pydantic import AwareDatetime, BeforeValidator, PlainSerializer

# v1 is single-clinic; its zone is the output offset (timestamps are rendered in the clinic offset).
# TD: a multi-clinic API would thread each appointment's clinic tz instead of this constant.
CLINIC_TZ = ZoneInfo("Africa/Nairobi")


def _require_str(value: object) -> object:
    if not isinstance(value, str):
        raise ValueError("must be an RFC 3339 datetime string with an offset")
    return value


# A string-only aware datetime: numbers/objects -> VALIDATION_ERROR; naive -> TIMEZONE_REQUIRED.
# AwareDatetime must sit next to datetime; the str guard wraps it (runs first on input).
StrAwareDatetime = Annotated[datetime, AwareDatetime, BeforeValidator(_require_str)]

# Output instants rendered in the clinic offset (+03:00), consistently for fresh writes and
# DB reads alike. Stays a date-time in the schema (return_type=datetime).
ClinicDatetime = Annotated[
    datetime,
    PlainSerializer(lambda d: d.astimezone(CLINIC_TZ), return_type=datetime, when_used="json"),
]
