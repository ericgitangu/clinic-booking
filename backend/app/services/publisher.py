"""The EventPublisher port and its two adapters.

``AblyPublisher`` posts to the push service's REST batch endpoint; ``DisabledPublisher`` is the
real state when no key is configured ("push disabled, polling only"). Neither ever logs the key.
"""

from __future__ import annotations

import base64
import json
import logging
from collections.abc import Sequence
from typing import Protocol

import httpx

from app.core.logging import APP_LOGGER
from app.domain.realtime import OutboundMessage

_log = logging.getLogger(APP_LOGGER)


class PublishError(Exception):
    """The push service did not accept the batch. ``sent`` is False when no request left us."""

    def __init__(self, message: str, *, sent: bool) -> None:
        super().__init__(message)
        self.sent = sent


class EventPublisher(Protocol):
    enabled: bool

    async def publish(self, messages: Sequence[OutboundMessage]) -> None:
        """Deliver every message or raise PublishError. Safe to repeat: ids are deterministic."""
        ...


class DisabledPublisher:
    enabled = False

    async def publish(self, messages: Sequence[OutboundMessage]) -> None:
        return None


class AblyPublisher:
    enabled = True

    def __init__(
        self,
        key: str,
        rest_url: str,
        *,
        timeout: float = 2.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._auth = "Basic " + base64.b64encode(key.encode("utf-8")).decode("ascii")
        self._url = rest_url.rstrip("/") + "/messages"
        self._timeout = timeout
        self._transport = transport

    @staticmethod
    def body(messages: Sequence[OutboundMessage]) -> list[dict[str, object]]:
        # One BatchSpec per message holding ONE message: the push service's atomic multi-message
        # publish wants ids of the form "<base>:<index>", and a single message carries its own
        # deterministic id, which is what its duplicate detection works on.
        return [
            {
                "channels": [m.channel],
                "messages": [
                    {
                        "id": m.id,
                        "name": m.name,
                        "data": json.dumps(m.data, separators=(",", ":"), sort_keys=True),
                    }
                ],
            }
            for m in messages
        ]

    async def publish(self, messages: Sequence[OutboundMessage]) -> None:
        if not messages:
            return
        try:
            async with httpx.AsyncClient(timeout=self._timeout, transport=self._transport) as c:
                resp = await c.post(
                    self._url,
                    json=self.body(messages),
                    headers={"Authorization": self._auth, "Accept": "application/json"},
                )
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            raise PublishError("push service unreachable", sent=False) from exc
        except httpx.HTTPError as exc:
            raise PublishError(f"push request failed: {type(exc).__name__}", sent=True) from exc
        if resp.status_code // 100 != 2:
            # Never put the request (it holds the key) in the message; the status is enough.
            raise PublishError(f"push service answered {resp.status_code}", sent=True)


def build_publisher(key: str | None, rest_url: str, *, timeout: float) -> EventPublisher:
    if not key:
        _log.info("push disabled: no ABLY_API_KEY is set, clients poll")
        return DisabledPublisher()
    return AblyPublisher(key, rest_url, timeout=timeout)
