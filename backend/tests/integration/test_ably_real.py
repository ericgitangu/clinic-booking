"""The adapter and the tokens against the real push service (Ably).

These run only when ABLY_API_KEY is set in the environment (a CI-only app key, or your own). Without
it they are skipped with an explicit reason; they are never replaced by a fake. They publish through
the real REST API with AblyPublisher and read the messages back over the real SSE endpoint with a
JWT minted by app.services.realtime_tokens, which is the credential the browser gets.

What the service really does (observed by these tests, not assumed):
- the JWT is accepted as a raw ``Authorization: Bearer`` value on the event-stream endpoint;
- a refused or expired token does NOT give an HTTP error status: the stream opens with 200 and its
  first frame is ``event: error`` with a JSON body ``{"code": ..., "statusCode": ...}``.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from contextlib import AsyncExitStack
from datetime import date, timedelta
from types import TracebackType

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

Frame = tuple[str, str]  # (event name, data)
WAIT = 15.0


class Stream:
    """An open SSE stream with one reader task, so frames can be awaited one after another."""

    def __init__(self, token: str, channel: str) -> None:
        self._token = token
        self._channel = channel
        self._stack = AsyncExitStack()
        self._frames: asyncio.Queue[Frame | None] = asyncio.Queue()
        self._reader: asyncio.Task[None] | None = None
        self.status = 0

    async def __aenter__(self) -> Stream:
        # A stream is long-lived by design: reads are bounded by the waits in next(), not by httpx.
        client = await self._stack.enter_async_context(
            httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=None))
        )
        response = await self._stack.enter_async_context(
            client.stream(
                "GET",
                STREAM,
                params={"channels": self._channel, "v": "1.2"},
                headers={"Authorization": f"Bearer {self._token}", "Accept": "text/event-stream"},
            )
        )
        self.status = response.status_code
        self._reader = asyncio.create_task(self._pump(response))
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        if self._reader is not None:
            self._reader.cancel()
            await asyncio.gather(self._reader, return_exceptions=True)
        await self._stack.aclose()

    async def _pump(self, response: httpx.Response) -> None:
        name = "message"
        data: list[str] = []
        try:
            async for line in response.aiter_lines():
                if line == "":
                    if data:
                        await self._frames.put((name, "\n".join(data)))
                    name, data = "message", []
                elif line.startswith("event:"):
                    name = line.removeprefix("event:").strip()
                elif line.startswith("data:"):
                    data.append(line.removeprefix("data:").strip())
        finally:
            await self._frames.put(None)  # the stream ended

    async def next(self, within: float = WAIT) -> Frame | None:
        """The next frame, or None if the stream ended. TimeoutError if nothing arrives."""
        return await asyncio.wait_for(self._frames.get(), within)

    async def next_message(self, within: float = WAIT) -> dict[str, object]:
        while True:
            frame = await self.next(within)
            assert frame is not None, "the stream ended before a message arrived"
            if frame[0] == "message":
                parsed: dict[str, object] = json.loads(frame[1])
                return parsed
            assert frame[0] != "error", f"an error frame arrived instead of a message: {frame[1]}"


def _message(channel: str, mid: str) -> OutboundMessage:
    return OutboundMessage(channel=channel, id=mid, name="slot_taken", data={"seq": mid})


def _channel() -> str:
    return patient_channel(uuid.uuid4(), SystemClock().now().date())


def _token(channel: str, *, age: timedelta = timedelta(0)) -> str:
    doctor, day = channel.split(":")[1], channel.split(":")[2]
    now = SystemClock().now() - age
    return patient_token(KEY, STREAM, uuid.UUID(doctor), date.fromisoformat(day), now).token


async def _error_code(stream: Stream) -> int:
    """The code of the first error frame; refusals arrive as frames on a 200 stream."""
    while True:
        frame = await stream.next(10.0)
        assert frame is not None, "the stream ended without an error frame"
        if frame[0] == "error":
            return int(json.loads(frame[1])["code"])


async def test_a_published_message_reaches_a_subscribe_only_stream_with_its_id() -> None:
    channel = _channel()
    publisher = AblyPublisher(KEY, REST)
    async with Stream(_token(channel), channel) as stream:
        assert stream.status == 200
        await asyncio.sleep(2)  # attached
        await publisher.publish([_message(channel, "9001.1.1")])
        got = await stream.next_message()
    assert got["name"] == "slot_taken" and got["id"] == "9001.1.1"
    assert json.loads(str(got["data"])) == {"seq": "9001.1.1"}


async def test_the_same_id_published_twice_inside_the_window_is_delivered_once() -> None:
    channel = _channel()
    publisher = AblyPublisher(KEY, REST)
    async with Stream(_token(channel), channel) as stream:
        assert stream.status == 200
        await asyncio.sleep(2)
        await publisher.publish([_message(channel, "9002.1.1")])
        await publisher.publish([_message(channel, "9002.1.1")])  # a relay retry
        first = await stream.next_message()
        assert first["id"] == "9002.1.1"
        with pytest.raises(TimeoutError):
            await stream.next_message(within=5.0)


async def test_a_patient_token_is_refused_on_the_admin_channel() -> None:
    token = _token(_channel())
    async with Stream(token, ADMIN_CHANNEL) as stream:
        code = await _error_code(stream)
    assert code == 40160, f"the service refused with {code}, not 40160 (action not permitted)"


async def test_an_expired_token_is_refused() -> None:
    channel = _channel()
    async with Stream(_token(channel, age=timedelta(hours=1)), channel) as stream:
        code = await _error_code(stream)
    assert 40140 <= code < 40150, f"expected a token error code 40140-40149, got {code}"


async def test_the_admin_token_reads_the_admin_channel() -> None:
    token = admin_token(KEY, STREAM, SystemClock().now()).token
    publisher = AblyPublisher(KEY, REST)
    async with Stream(token, ADMIN_CHANNEL) as stream:
        assert stream.status == 200
        await asyncio.sleep(2)
        await publisher.publish([_message(ADMIN_CHANNEL, "9003.1")])
        got = await stream.next_message()
    assert got["id"] == "9003.1"
