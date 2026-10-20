"""FastAPI dependencies for the staff write routes: see ``app/services/write_guard.py``.

Add one as the LAST parameter of a write route (after the role dependency), so a caller who is
refused for their role is refused before anything is recorded:

    _guard: None = Depends(guard_staff_write)

``guard_replay_only`` is for a signed write that has its own attempt limit (accepting an
invitation): the assertion may not be reused, but nothing is counted against the person's writes.
"""

from __future__ import annotations

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_clock, get_session, get_settings, require_identity
from app.core.assertion import Principal
from app.core.clock import Clock
from app.core.config import Settings
from app.services import write_guard

_SAFE = frozenset({"GET", "HEAD", "OPTIONS"})


async def _guard(
    request: Request,
    who: Principal,
    session: AsyncSession,
    settings: Settings,
    clock: Clock,
    *,
    throttle: bool,
) -> None:
    if request.method in _SAFE:
        return
    await write_guard.guard(
        session,
        settings,
        clock.now(),
        jti=who.jti,
        valid_until=who.valid_until,
        email=who.email,
        throttle=throttle,
    )


async def guard_staff_write(
    request: Request,
    who: Principal = Depends(require_identity),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
    clock: Clock = Depends(get_clock),
) -> None:
    """Replay check and per-person throttle."""
    await _guard(request, who, session, settings, clock, throttle=True)


async def guard_replay_only(
    request: Request,
    who: Principal = Depends(require_identity),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
    clock: Clock = Depends(get_clock),
) -> None:
    """Replay check only."""
    await _guard(request, who, session, settings, clock, throttle=False)
