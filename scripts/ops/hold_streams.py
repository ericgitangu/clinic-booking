"""Hold live-feed streams open for a controlled window and report how long each stayed connected.

Part of scripts/ops/measure_realtime_cost.sh. It authenticates as the release smoke identity (the
same way scripts/ci/realtime_smoke.py does), so it sees only synthetic events and reads no staff
row. Each session opens one stream, keeps it for HOLD_SECONDS, and closes it from the client side.

    REALTIME_URL=... REALTIME_TOKEN=<id token, audience clinic-realtime> SMOKE_SIGNING_KEY=... \
    SESSIONS=3 HOLD_SECONDS=120 python3 -I scripts/ops/hold_streams.py

Prints one JSON document on stdout: the window in UTC and the connected seconds of each session.
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import UTC, datetime
from urllib.parse import urlsplit

import httpx

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ci"))
import realtime_smoke  # the assertion signer shared with the release smoke

SERVER_LIMIT_SECONDS = 290  # the gateway closes a stream itself at this age


def hold(base: str, token: str, key: str, seconds: float) -> float:
    target = "/stream"
    header = realtime_smoke.stream_assertion(key, f"{urlsplit(base).path.rstrip('/')}{target}")
    client = httpx.Client(
        base_url=base,
        headers={realtime_smoke.IAM_HEADER: f"Bearer {token}"},
        timeout=httpx.Timeout(realtime_smoke.COLD_START_SECONDS, read=None),
    )
    started = time.monotonic()
    with client.stream("GET", target, headers={"X-Internal-Assertion": header}) as resp:
        if resp.status_code != 200:
            raise SystemExit(f"stream refused: {resp.status_code}")
        started = time.monotonic()  # connected from the moment the response is open
        for _ in resp.iter_lines():
            if time.monotonic() - started >= seconds:
                break
    return time.monotonic() - started


def main() -> int:
    base = os.environ["REALTIME_URL"].rstrip("/")
    token, key = os.environ["REALTIME_TOKEN"], os.environ["SMOKE_SIGNING_KEY"]
    sessions = int(os.environ.get("SESSIONS", "3"))
    seconds = min(float(os.environ.get("HOLD_SECONDS", "120")), SERVER_LIMIT_SECONDS - 10)
    window_start = datetime.now(UTC)
    out = []
    for n in range(sessions):
        begin = datetime.now(UTC)
        connected = hold(base, token, key, seconds)
        out.append({"session": n + 1, "started": begin.isoformat(), "connected_seconds": round(connected, 1)})
    json.dump(
        {
            "window_start": window_start.isoformat(),
            "window_end": datetime.now(UTC).isoformat(),
            "sessions": out,
            "connected_seconds_total": round(sum(s["connected_seconds"] for s in out), 1),
        },
        sys.stdout,
        indent=2,
    )
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
