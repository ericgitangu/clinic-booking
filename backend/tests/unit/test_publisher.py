"""The Ably REST adapter, against httpx's in-process transport.

Stand-in, labelled: the push service's HTTP API is a third party. These tests check the request the
adapter builds and how it maps answers to PublishError; the real service is exercised by
tests/integration/test_ably_real.py whenever ABLY_API_KEY is present.
"""

from __future__ import annotations

import base64
import json
import secrets
import uuid

import httpx
import pytest

from app.domain.realtime import OutboundMessage
from app.services.publisher import AblyPublisher, DisabledPublisher, PublishError, build_publisher

SECRET = secrets.token_urlsafe(16)
KEY = f"app.key:{SECRET}"
MSG = OutboundMessage(
    channel=f"slots:{uuid.UUID(int=1)}:2026-10-26",
    id="770.41.1",
    name="slot_taken",
    data={"kind": "slot_taken", "seq": "770.41.1"},
)
ADMIN = OutboundMessage(channel="admin:events", id="770.41", name="booked", data={"seq": "770.41"})


async def _publish(handler: httpx.MockTransport, *msgs: OutboundMessage) -> None:
    await AblyPublisher(KEY, "https://push.example", transport=handler).publish(msgs)


async def test_posts_one_single_message_batch_spec_per_message_with_its_id() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(201, json=[{"channel": "c", "messageId": "m"}] * 2)

    await _publish(httpx.MockTransport(handler), MSG, ADMIN)
    (request,) = seen
    assert request.method == "POST" and str(request.url) == "https://push.example/messages"
    assert request.headers["authorization"] == "Basic " + base64.b64encode(KEY.encode()).decode()
    body = json.loads(request.content)
    assert [spec["channels"] for spec in body] == [[MSG.channel], ["admin:events"]]
    assert all(len(spec["messages"]) == 1 for spec in body)
    first = body[0]["messages"][0]
    assert first["id"] == "770.41.1" and first["name"] == "slot_taken"
    assert json.loads(first["data"]) == MSG.data  # data travels as a JSON string


async def test_an_empty_batch_sends_nothing() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("no request expected")

    await _publish(httpx.MockTransport(handler))


@pytest.mark.parametrize("status", [400, 401, 403, 429, 500, 503])
async def test_a_non_2xx_answer_is_a_publish_error_that_was_sent_and_hides_the_key(
    status: int,
) -> None:
    transport = httpx.MockTransport(
        lambda r: httpx.Response(status, json={"error": {"code": 40020}})
    )
    with pytest.raises(PublishError) as exc:
        await _publish(transport, MSG)
    assert exc.value.sent is True
    assert str(status) in str(exc.value)
    assert SECRET not in str(exc.value)


async def test_an_unreachable_service_is_a_publish_error_that_was_not_sent() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(PublishError) as exc:
        await _publish(httpx.MockTransport(handler), MSG)
    assert exc.value.sent is False


async def test_a_timeout_after_sending_counts_as_sent() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    with pytest.raises(PublishError) as exc:
        await _publish(httpx.MockTransport(handler), MSG)
    assert exc.value.sent is True


async def test_disabled_publisher_is_off_and_accepts_anything() -> None:
    publisher = DisabledPublisher()
    assert publisher.enabled is False
    await publisher.publish([MSG])


def test_build_publisher_picks_the_adapter_from_the_key() -> None:
    assert build_publisher(None, "https://x", timeout=1).enabled is False
    assert build_publisher("", "https://x", timeout=1).enabled is False
    assert build_publisher(KEY, "https://x", timeout=1).enabled is True
