"""Shared schema helpers.

``AwareDatetime`` input is a str with an offset. A BeforeValidator rejects any
non-str value with a VALIDATION_ERROR; a naive string is then caught by pydantic's
timezone-aware check, which the handler maps to TIMEZONE_REQUIRED.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Self
from zoneinfo import ZoneInfo

from pydantic import AwareDatetime, BaseModel, BeforeValidator, PlainSerializer, model_validator

from app.core.clinic_zone import default_zone


def _require_str(value: object) -> object:
    if not isinstance(value, str):
        raise ValueError("must be an RFC 3339 datetime string with an offset")
    return value


# A string-only aware datetime: numbers/objects -> VALIDATION_ERROR; naive -> TIMEZONE_REQUIRED.
# AwareDatetime must sit next to datetime; the str guard wraps it (runs first on input).
StrAwareDatetime = Annotated[datetime, AwareDatetime, BeforeValidator(_require_str)]

# Output instants for resources that belong to no clinic (a patient's created_at, a staff grant),
# rendered in the configured default zone. Stays a date-time in the schema (return_type=datetime).
ClinicDatetime = Annotated[
    datetime,
    PlainSerializer(lambda d: d.astimezone(default_zone()), return_type=datetime, when_used="json"),
]


class ClinicZoned(BaseModel):
    """A response model whose instants are rendered in the zone it names.

    ``timezone`` is the IANA name of the clinic the record belongs to (through its doctor); every
    datetime field is converted to that zone on construction, so the offset in the JSON always
    agrees with ``timezone``.
    """

    timezone: str

    @model_validator(mode="after")
    def _render_in_zone(self) -> Self:
        zone = ZoneInfo(self.timezone)
        for name in type(self).model_fields:
            value = getattr(self, name)
            if isinstance(value, datetime):
                setattr(self, name, value.astimezone(zone))
        return self
