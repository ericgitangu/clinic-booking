"""Shared FastAPI dependencies."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Awaitable, Callable

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import assertion
from app.core.clock import Clock, SystemClock
from app.core.config import Settings
from app.core.logging import APP_LOGGER
from app.db.session import get_sessionmaker
from app.domain.errors import Forbidden, Unauthenticated
from app.schemas.access import Role
from app.services import access


def get_settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    sessionmaker = get_sessionmaker(request.app.state.settings)
    async with sessionmaker() as session:
        yield session


def get_clock() -> Clock:
    # Overridden with a FakeClock in tests via app.dependency_overrides.
    return SystemClock()


_log = logging.getLogger(APP_LOGGER)

# Who the scheduled reminder run signs as.
SYSTEM_SUB = "system:reminders"


def _refuse(reason: str, status: str) -> None:
    """Record why an internal call was refused. ``reason`` is always one of a fixed set of short
    phrases, never a value taken from the request: no email, no subject, no claim, no signature.
    The access log line for the request carries the same problem code."""
    _log.warning("internal call refused: %s", reason, extra={"code": status})


def _verify(request: Request, clock: Clock, body: bytes) -> assertion.Principal:
    settings: Settings = request.app.state.settings
    secret = settings.INTERNAL_SIGNING_KEY
    if secret is None:
        _refuse("signing key not configured", "UNAUTHENTICATED")
        raise Unauthenticated()
    scope = request.scope
    raw_path = scope.get("raw_path")
    path = raw_path.decode("latin-1") if isinstance(raw_path, bytes) else scope["path"]
    query = scope.get("query_string", b"").decode("latin-1")
    try:
        return assertion.verify(
            request.headers.get(assertion.HEADER),
            key=secret.get_secret_value().encode("utf-8"),
            method=request.method,
            path_with_query=f"{path}?{query}" if query else path,
            body=body,
            now=clock.now(),
        )
    except assertion.InvalidAssertion as exc:
        _refuse(exc.reason, "UNAUTHENTICATED")
        raise Unauthenticated() from exc


async def require_identity(
    request: Request, clock: Clock = Depends(get_clock)
) -> assertion.Principal:
    """A valid, request-bound assertion; the role it carries is not looked at."""
    return _verify(request, clock, await request.body())


async def require_verified_identity(
    request: Request, clock: Clock = Depends(get_clock)
) -> assertion.Principal:
    """A valid, request-bound assertion whose email the sign-in provider verified. Everything a
    patient does with an account (link, book, list, cancel, reschedule) is refused otherwise."""
    principal = _verify(request, clock, await request.body())
    if not principal.email_verified:
        _refuse("email not verified", "FORBIDDEN")
        raise Forbidden()
    return principal


async def require_system(
    request: Request, clock: Clock = Depends(get_clock)
) -> assertion.Principal:
    """For the scheduled reminder run, which acts as no person: the assertion must be valid and
    request-bound and carry the system role and subject the run uses."""
    principal = _verify(request, clock, await request.body())
    if principal.role != "system" or principal.sub != SYSTEM_SUB:
        _refuse("not the system caller", "FORBIDDEN")
        raise Forbidden()
    return principal


def require_role(*allowed: Role) -> Callable[..., Awaitable[assertion.Principal]]:
    """Gate for ``/internal/admin/*``: the assertion must be valid and bound to the request, its
    role must be one of ``allowed``, and the database must agree the caller holds that role right
    now. The second check is what makes a revoke take effect on the next request, even if a web
    app still believed an older role."""

    async def dependency(
        request: Request,
        clock: Clock = Depends(get_clock),
        session: AsyncSession = Depends(get_session),
    ) -> assertion.Principal:
        principal = _verify(request, clock, await request.body())
        if principal.role not in allowed:
            _refuse("role not allowed for this endpoint", "FORBIDDEN")
            raise Forbidden()
        current = await access.resolve_role(session, request.app.state.settings, principal.email)
        # The lookup began a transaction on the request's session; end it so the handler can open
        # its own (booking.cancel and reschedule use session.begin()).
        await session.rollback()
        if current != principal.role:
            _refuse("role is not the one currently held", "FORBIDDEN")
            raise Forbidden()
        return principal

    return dependency


ANY_STAFF = require_role("owner", "admin", "viewer")
OWNER_ONLY = require_role("owner")
CAN_MANAGE = require_role("owner", "admin")
