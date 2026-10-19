"""Credentials for live updates: subscribe-only tokens for the push service.

``POST /realtime/token/patient`` is public (the proxy reaches it like the other public routes) and
guarded by an Origin check, a per-address rate limit and a durable daily cap per address. The admin
token needs a staff assertion (owner or admin). Both refuse with REALTIME_UNAVAILABLE when push is
off, so clients fall back to polling at once.
"""

from __future__ import annotations

import ipaddress
from datetime import timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CAN_MANAGE, get_clock, get_relay, get_session, get_settings
from app.core.clock import Clock
from app.core.config import Settings
from app.domain.errors import (
    ClientAddressUnknown,
    DateOutOfRange,
    DoctorNotFound,
    Forbidden,
    RateLimited,
    RealtimeUnavailable,
)
from app.repositories import doctors as doctor_repo
from app.schemas.events import PatientTokenRequest, RealtimeToken
from app.schemas.problem import problem_responses
from app.services import realtime_tokens as tokens
from app.services.relay import Relay

router = APIRouter(tags=["realtime"])
admin_router = APIRouter(
    prefix="/internal/realtime",
    tags=["realtime"],
    dependencies=[Depends(CAN_MANAGE)],
    responses=problem_responses(401, 403),
)

_NO_STORE = {"Cache-Control": "no-store"}


def _client_ip(request: Request) -> str:
    """The address the proxy saw. It sets x-client-ip itself and drops any the caller sent; the API
    is reachable only through it (IAM). A missing or unparsable value is refused, never replaced by
    the socket peer, which is the shared upstream and would put every visitor in one bucket."""
    forwarded = request.headers.get("x-client-ip", "").strip()
    try:
        ipaddress.ip_address(forwarded)
    except ValueError:
        raise ClientAddressUnknown() from None
    return forwarded


def _require_key(settings: Settings) -> str:
    if settings.ABLY_API_KEY is None:
        raise RealtimeUnavailable()
    return settings.ABLY_API_KEY.get_secret_value()


@router.post(
    "/realtime/token/patient",
    response_model=RealtimeToken,
    responses=problem_responses(400, 403, 404, 422, 429, 503),
)
async def patient_token(
    body: PatientTokenRequest,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_session),
    clock: Clock = Depends(get_clock),
    settings: Settings = Depends(get_settings),
    relay: Relay = Depends(get_relay),
) -> RealtimeToken:
    """A five-minute, subscribe-only token for one doctor's slots on one day."""
    response.headers.update(_NO_STORE)
    origin = request.headers.get("origin")
    if origin is not None and origin not in settings.cors_origins:
        raise Forbidden("this origin may not ask for a live-updates token")
    key = _require_key(settings)
    now = clock.now()
    ip = _client_ip(request)
    if not request.app.state.patient_token_limiter.allow(tokens.address_key(ip), now):
        raise RateLimited(60)
    if not await tokens.take_daily(
        relay.sessionmaker,
        ip,
        now.date(),
        settings.REALTIME_TOKEN_DAILY_CAP,
    ):
        tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
        raise RateLimited(max(int((tomorrow - now).total_seconds()), 1))
    doctor = await doctor_repo.get_active_doctor(session, body.doctor_id)
    if doctor is None:
        raise DoctorNotFound()
    clinic = await doctor_repo.get_clinic(session, doctor.clinic_id)
    zone = ZoneInfo(clinic.timezone) if clinic else ZoneInfo("UTC")
    today = now.astimezone(zone).date()
    await session.rollback()
    if not today <= body.date <= today + timedelta(days=settings.BOOKING_HORIZON_DAYS):
        raise DateOutOfRange()
    if await relay.budget.exhausted(now):
        raise RealtimeUnavailable("This month's live-update budget is spent. Poll instead.")
    await relay.run(clock)  # flush what a busy moment stranded; bounded, never raises
    return tokens.patient_token(key, settings.ABLY_STREAM_URL, body.doctor_id, body.date, now)


@admin_router.post(
    "/token/admin",
    response_model=RealtimeToken,
    responses=problem_responses(503),
)
async def admin_token(
    response: Response,
    clock: Clock = Depends(get_clock),
    settings: Settings = Depends(get_settings),
    relay: Relay = Depends(get_relay),
) -> RealtimeToken:
    """A five-minute, subscribe-only token for the staff dashboard's event channel."""
    response.headers.update(_NO_STORE)
    key = _require_key(settings)
    now = clock.now()
    if await relay.budget.exhausted(now):
        raise RealtimeUnavailable("This month's live-update budget is spent. Poll instead.")
    await relay.run(clock)
    return tokens.admin_token(key, settings.ABLY_STREAM_URL, now)
