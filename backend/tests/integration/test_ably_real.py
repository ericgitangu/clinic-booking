"""The adapter and the tokens against the real push service (Ably).

These run only when ABLY_API_KEY is set in the environment (a CI-only app key, or your own). Without
it they are skipped with an explicit reason; they are never replaced by a fake. They publish through
the real REST API with AblyPublisher and read the messages back over the real SSE endpoint with a
JWT minted by app.services.realtime_tokens, which is the credential the browser gets.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import timedelta

import httpx
import pytest

from app.core.clock import SystemClock
from app.domain.realtime import ADMIN_CHANNEL, OutboundMessage, patient_channel
from app.services.publisher import AblyPublisher
from app.services.realtime_tokens import admin_token, patient_token

KEY = os.environ.get("ABLY_API_KEY", "")
REST = os.environ.get("ABLY_REST_URL", "https://main.realtime.ably.net")
STREAM = os.environ.get("ABLY_STREAM_URL", "https://main.realtime.ably.net/event-stream")

pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.skipif(
        not KEY,
        reason="needs ABLY_API_KEY (the real push service is never faked); set it to run these",
    ),
]


@asynccontextmanager
async def _open(
    token: str, channel: str, *, rewind: str | None = None
) -> AsyncIterator[httpx.Response]:
    params = {"channels": channel, "v": "1.2"}
    if rewind:
        params["rewind"] = rewind
    # A stream is long-lived by design: the reads are bounded by asyncio.wait_for in the tests.
    async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=None)) as client:
        async with client.stream(
            "GET",
            STREAM,
            params=params,
            headers={"Authorization": f"Bearer {token}", "Accept": "text/event-stream"},
        ) as response:
            yield response


async def _events(response: httpx.Response) -> AsyncIterator[tuple[str, str]]:
    name = "message"
    data: list[str] = []
    async for line in response.aiter_lines():
        if line == "":
            if data:
                yield name, "\n".join(data)
            name, data = "message", []
        elif line.startswith("event:"):
            name = line.removeprefix("event:").strip()
        elif line.startswith("data:"):
            data.append(line.removeprefix("data:").strip())


async def _next_message(response: httpx.Response, within: float = 15.0) -> dict[str, object]:
    async def read() -> dict[str, object]:
        async for name, data in _events(response):
            if name == "message":
                parsed: dict[str, object] = json.loads(data)
                return parsed
        raise AssertionError("the stream ended before a message arrived")

    return await asyncio.wait_for(read(), within)


def _message(channel: str, mid: str) -> OutboundMessage:
    return OutboundMessage(channel=channel, id=mid, name="slot_taken", data={"seq": mid})


def _channel() -> str:
    return patient_channel(uuid.uuid4(), SystemClock().now().date())


def _token(channel: str, *, age: timedelta = timedelta(0)) -> str:
    doctor, day = channel.split(":")[1], channel.split(":")[2]
    now = SystemClock().now() - age
    return patient_token(
        KEY, STREAM, uuid.UUID(doctor), SystemClock().now().date().fromisoformat(day), now
    ).token


async def test_a_published_message_reaches_a_subscribe_only_stream_with_its_id() -> None:
    channel = _channel()
    publisher = AblyPublisher(KEY, REST)
    async with _open(_token(channel), channel) as stream:
        assert stream.status_code == 200, await stream.aread()
        await asyncio.sleep(2)  # attached
        await publisher.publish([_message(channel, "9001.1.1")])
        got = await _next_message(stream)
    assert got["name"] == "slot_taken" and got["id"] == "9001.1.1"
    assert json.loads(str(got["data"])) == {"seq": "9001.1.1"}


async def test_the_same_id_published_twice_inside_the_window_is_delivered_once() -> None:
    channel = _channel()
    publisher = AblyPublisher(KEY, REST)
    async with _open(_token(channel), channel) as stream:
        assert stream.status_code == 200
        await asyncio.sleep(2)
        await publisher.publish([_message(channel, "9002.1.1")])
        await publisher.publish([_message(channel, "9002.1.1")])  # a relay retry
        await _next_message(stream)
        with pytest.raises(TimeoutError):
            await _next_message(stream, within=4.0)


async def test_a_patient_token_is_refused_on_the_admin_channel() -> None:
    token = _token(_channel())
    async with _open(token, ADMIN_CHANNEL) as stream:
        assert stream.status_code in (401, 403) or "40160" in (await stream.aread()).decode()


async def test_an_expired_token_is_refused() -> None:
    channel = _channel()
    async with _open(_token(channel, age=timedelta(hours=1)), channel) as stream:
        assert stream.status_code == 401, await stream.aread()


async def test_the_admin_token_reads_the_admin_channel() -> None:
    token = admin_token(KEY, STREAM, SystemClock().now()).token
    publisher = AblyPublisher(KEY, REST)
    async with _open(token, ADMIN_CHANNEL) as stream:
        assert stream.status_code == 200, await stream.aread()
        await asyncio.sleep(2)
        await publisher.publish([_message(ADMIN_CHANNEL, "9003.1")])
        got = await _next_message(stream)
    assert got["id"] == "9003.1"
