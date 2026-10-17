"""Shared schema helpers.

``AwareDatetime`` input is a str with an offset. A BeforeValidator rejects any
non-str value with a VALIDATION_ERROR; a naive string is then caught by pydantic's
timezone-aware check, which the handler maps to TIMEZONE_REQUIRED.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from pydantic import AwareDatetime, BeforeValidator, PlainSerializer

from app.core.clinic_zone import current_clinic_zone


def _require_str(value: object) -> object:
    if not isinstance(value, str):
        raise ValueError("must be an RFC 3339 datetime string with an offset")
    return value


# A string-only aware datetime: numbers/objects -> VALIDATION_ERROR; naive -> TIMEZONE_REQUIRED.
# AwareDatetime must sit next to datetime; the str guard wraps it (runs first on input).
StrAwareDatetime = Annotated[datetime, AwareDatetime, BeforeValidator(_require_str)]

# Output instants rendered in the clinic's offset, consistently for fresh writes and DB reads
# alike. The zone is the one bound for the request from clinics.timezone (see bind_clinic_zone).
# Stays a date-time in the schema (return_type=datetime).
ClinicDatetime = Annotated[
    datetime,
    PlainSerializer(
        lambda d: d.astimezone(current_clinic_zone()), return_type=datetime, when_used="json"
    ),
]
