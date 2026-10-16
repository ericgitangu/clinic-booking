"""Classify database errors by SQLSTATE.

The asyncpg dialect raises most server errors as a plain ``sqlalchemy.exc.DBAPIError``: the
translated error sits at ``exc.orig`` (with ``.sqlstate``) and the original asyncpg error is
chained at ``exc.orig.__cause__`` (with ``.sqlstate`` and, for constraint violations,
``.constraint_name``). Every decision about retrying or reporting a database outage goes
through this module so the SQLSTATE sets live in one place.
"""

from __future__ import annotations

from sqlalchemy.exc import DBAPIError, InterfaceError

SERIALIZATION_FAILURE = "40001"
DEADLOCK_DETECTED = "40P01"

# Server is unreachable or refusing connections: class 08 (connection exception), too many
# connections, admin shutdown / crash shutdown, cannot connect now.
_UNAVAILABLE_EXACT = frozenset({"53300", "57P01", "57P02", "57P03"})


def extract_sqlstate_constraint(exc: BaseException) -> tuple[str | None, str | None]:
    orig = getattr(exc, "orig", None)
    cause = getattr(orig, "__cause__", None)
    sqlstate = getattr(orig, "sqlstate", None) or getattr(cause, "sqlstate", None)
    constraint = getattr(cause, "constraint_name", None)
    return sqlstate, constraint


def is_retryable_conflict(exc: BaseException) -> bool:
    """A deadlock or serialization failure: safe to retry the whole transaction."""
    sqlstate, _ = extract_sqlstate_constraint(exc)
    return sqlstate in (SERIALIZATION_FAILURE, DEADLOCK_DETECTED)


def is_db_unavailable(exc: BaseException) -> bool:
    """The database is down or refusing connections (report 503, not 500)."""
    if not isinstance(exc, DBAPIError):
        return False
    if exc.connection_invalidated or isinstance(exc, InterfaceError):
        return True
    sqlstate, _ = extract_sqlstate_constraint(exc)
    if sqlstate is None:
        return False
    return sqlstate.startswith("08") or sqlstate in _UNAVAILABLE_EXACT
