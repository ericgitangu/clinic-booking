"""One bounded look at a Server-Sent Events stream, with curl.

The release smoke must never leave a stream open behind it: the gateway holds one stream per
Cloud Run instance, and Cloud Run does not tell the instance when a client goes away, so an
abandoned stream holds its instance until the gateway's idle close (240 s; seen in production on
2026-10-19, when it made the post-promotion check fail). curl's --max-time bounds the read on this
side; the gateway also ends the smoke identity's stream itself after its catch-up (reason
"probe"), which is what actually frees the instance.

Headers go to curl on stdin (``-H @-``), so the IAM token and the assertion never appear in a
process listing. Standard library only.
"""

from __future__ import annotations

import os
import re
import subprocess
from dataclasses import dataclass, field

_STATUS = re.compile(r"probe-http-status:(\d{3})")


@dataclass
class Probe:
    status: int
    body: str
    frames: list[dict[str, str]] = field(default_factory=list)
    # True when curl stopped at --max-time rather than the server closing the stream.
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


def probe(url: str, headers: dict[str, str], seconds: float = 5.0) -> Probe:
    """GET url as an event stream for at most `seconds`, then close it."""
    curl = os.environ.get("SSE_PROBE_CURL", "curl")
    lines = "".join(f"{k}: {v}\n" for k, v in {"Accept": "text/event-stream", **headers}.items())
    # A fixed argv and no shell; the URL is the smoke's own target.
    proc = subprocess.run(
        [
            curl,
            "-sS",
            "-N",
            "--max-time",
            f"{seconds:g}",
            "-H",
            "@-",
            "-o",
            "-",
            "-w",
            "%{stderr}probe-http-status:%{http_code}\n",
            url,
        ],
        input=lines.encode("utf-8"),
        capture_output=True,
        timeout=seconds + 10,
        check=False,
    )
    match = _STATUS.search(proc.stderr.decode("utf-8", "replace"))
    body = proc.stdout.decode("utf-8", "replace")
    return Probe(
        status=int(match.group(1)) if match else 0,
        body=body,
        frames=parse_frames(body),
        timed_out=proc.returncode == 28,
    )
