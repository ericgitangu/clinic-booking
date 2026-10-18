"""Helpers for the realtime tests.

``RecordingPublisher`` is the one stand-in here, and it stands in for the push service's network
API only (a third party): it implements the same port as the real adapter and keeps what it was
asked to publish. Everything else, the outbox, the cursor, the budget, the transactions, is the real
code on the real database. The real service is exercised by test_ably_real.py when a key is present.
"""

from __future__ import annotations

import asyncio
import secrets
from collections.abc import Sequence

from fastapi import FastAPI

from app.api.deps import get_clock
from app.core.clock import FakeClock
from app.domain.realtime import OutboundMessage
from app.main import create_app
from app.services.publisher import EventPublisher, PublishError
from tests.conftest import FIXED_NOW, make_settings

# A throwaway key in the push service's <name>:<secret> shape; the secret is random per run.
TEST_KEY = f"testapp.testkey:{secrets.token_urlsafe(24)}"


class RecordingPublisher:
    enabled = True

    def __init__(self, *, fail: bool = False, delay: float = 0.0) -> None:
        self.batches: list[list[OutboundMessage]] = []
        self.fail = fail
        self.delay = delay

    @property
    def messages(self) -> list[OutboundMessage]:
        return [m for batch in self.batches for m in batch]

    async def publish(self, messages: Sequence[OutboundMessage]) -> None:
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.fail:
            raise PublishError("push service answered 503", sent=True)
        self.batches.append(list(messages))


def make_realtime_app(
    publisher: EventPublisher | None = None,
    *,
    key: str | None = TEST_KEY,
    clock: FakeClock | None = None,
    **settings: object,
) -> FastAPI:
    base: dict[str, object] = {"REALTIME_MAX_EVENT_AGE_SECONDS": 10**9}
    if key is not None:
        base["ABLY_API_KEY"] = key
    base.update(settings)
    app = create_app(make_settings(**base))
    if publisher is not None:
        app.state.publisher = publisher
    fake = clock or FakeClock(FIXED_NOW)
    app.dependency_overrides[get_clock] = lambda: fake
    return app
