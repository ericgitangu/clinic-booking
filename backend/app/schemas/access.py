"""Staff access: who may use the admin app, and as what."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, StringConstraints

from app.schemas.common import ClinicDatetime

Role = Literal["owner", "admin", "viewer"]
# The owner is configuration, never a grant: only these two can be given.
GrantableRole = Literal["admin", "viewer"]

Email = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        to_lower=True,
        min_length=3,
        max_length=254,
        pattern=r"^[^@\s,]+@[^@\s,]+\.[^@\s,]+$",
    ),
]


class GrantRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: Email
    role: GrantableRole


class ChangeRoleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: GrantableRole


class AccessEntry(BaseModel):
    email: str
    role: Role
    granted_by: str
    granted_at: ClinicDatetime | None
    revoked_at: ClinicDatetime | None
    # "env": the owner, fixed by configuration. "db": granted through the API.
    source: Literal["env", "db"]


class AccessList(BaseModel):
    items: list[AccessEntry]


class SessionInfo(BaseModel):
    email: str
    role: Role | None
