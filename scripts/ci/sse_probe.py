"""One bounded look at a Server-Sent Events stream, over http.client.

The release smoke must never leave a stream open behind it: the gateway holds one stream per
Cloud Run instance, and Cloud Run does not tell the instance when a client goes away, so an
abandoned stream holds its instance until the gateway's idle close (240 s; seen in production on
2026-10-19, when it made the post-promotion check fail). The read is bounded on this side by a
deadline and a socket timeout (``seconds``), after which the connection is closed; the gateway
also ends the smoke identity's stream itself after its catch-up (reason "probe"), which is what
actually frees the instance.

No subprocess and no shell: the request goes through http.client over TLS, to an https URL whose
host is a Cloud Run address (``*.run.app``), with no whitespace or control characters anywhere in
the URL. A URL that does not pass is not requested at all (status 0). Headers are set on the
request and never printed, so the IAM token and the assertion do not appear in any output.
Standard library only.
"""

from __future__ import annotations

import http.client
import re
import socket
import ssl
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from urllib.parse import urlsplit

_RUN_APP = re.compile(r"[a-z0-9-]+(\.[a-z0-9-]+)*\.run\.app")
_BAD_CHARS = re.compile(r"[\s\x00-\x1f\x7f]")
CHUNK = 65536


@dataclass
class Probe:
    status: int
    body: str
    frames: list[dict[str, str]] = field(default_factory=list)
    # True when the read stopped at the deadline rather than the server closing the stream.
    timed_out: bool = False

    def first(self, event: str) -> dict[str, str] | None:
        return next((f for f in self.frames if f.get("event") == event), None)


def parse_frames(text: str) -> list[dict[str, str]]:
    frames: list[dict[str, str]] = []
    cur: dict[str, str] = {}
    for line in text.splitlines():
        if line == "":
            if cur:
                frames.append(cur)
            cur = {}
        elif line.startswith(":"):
            continue
        else:
            name, _, value = line.partition(": ")
            if name in ("id", "event", "data"):
                cur[name] = value
    if cur:
        frames.append(cur)
    return frames


def _valid(url: str, host_ok: Callable[[str], bool]) -> tuple[str, int, str] | None:
    """(host, port, path) for an acceptable https URL, else None."""
    if not url or _BAD_CHARS.search(url):
        return None
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
        return None
    if not host_ok(parts.hostname):
        return None
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    try:
        port = parts.port or 443
    except ValueError:
        return None
    return parts.hostname, port, path


def probe(
    url: str,
    headers: dict[str, str],
    seconds: float = 5.0,
    *,
    connect: Callable[[str, int, float], http.client.HTTPConnection] | None = None,
    host_ok: Callable[[str], bool] | None = None,
) -> Probe:
    """GET url as an event stream for at most `seconds`, then close it.

    `connect` and `host_ok` are seams for tests (a plain-HTTP stand-in on a free port); the defaults
    are TLS and a ``*.run.app`` host.
    """
    ok = host_ok or (lambda h: _RUN_APP.fullmatch(h) is not None)
    target = _valid(url, ok)
    if target is None:
        return Probe(status=0, body="")
    host, port, path = target
    deadline = time.monotonic() + seconds

    def default_connect(h: str, p: int, timeout: float) -> http.client.HTTPConnection:
        return http.client.HTTPSConnection(h, p, timeout=timeout, context=ssl.create_default_context())

    conn: http.client.HTTPConnection | None = None
    chunks: list[bytes] = []
    status = 0
    timed_out = False
    try:
        conn = (connect or default_connect)(host, port, seconds)
        conn.request("GET", path, headers={"Accept": "text/event-stream", **headers})
        resp = conn.getresponse()
        status = resp.status
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                break
            if conn.sock is not None:
                conn.sock.settimeout(remaining)
            try:
                data = resp.read1(CHUNK)
            except (TimeoutError, socket.timeout):
                timed_out = True
                break
            if not data:
                break  # the server closed the stream
            chunks.append(data)
    except (TimeoutError, socket.timeout):
        timed_out = True
    except (OSError, http.client.HTTPException, ValueError):
        pass  # unreachable or refused: status stays what it was (0 before a response)
    finally:
        if conn is not None:
            conn.close()
    body = b"".join(chunks).decode("utf-8", "replace")
    return Probe(status=status, body=body, frames=parse_frames(body), timed_out=timed_out)
