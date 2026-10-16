"""Shared schema helpers.

``AwareDatetime`` input is a str with an offset (§6). A BeforeValidator rejects any
non-str value with a VALIDATION_ERROR; a naive string is then caught by pydantic's
timezone-aware check, which the handler maps to TIMEZONE_REQUIRED.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from pydantic import AwareDatetime, BeforeValidator


def _require_str(value: object) -> object:
    if not isinstance(value, str):
        raise ValueError("must be an RFC 3339 datetime string with an offset")
    return value


# A string-only aware datetime: numbers/objects -> VALIDATION_ERROR; naive -> TIMEZONE_REQUIRED.
StrAwareDatetime = Annotated[datetime, BeforeValidator(_require_str), AwareDatetime]
