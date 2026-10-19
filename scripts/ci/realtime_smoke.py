"""Release smoke for the live-feed gateway: one stream, one event, then close.

Run by ship-realtime against the TAGGED, no-traffic revision of clinic-realtime, after ship-api
has made the new API live. It checks, in order, that:

1. /health answers through Cloud Run IAM (the invoker token works);
2. /stream without an assertion, and with one signed by a wrong key, is refused with 401;
3. a stream opened with the smoke identity's assertion starts (the ``hello`` frame arrives);
4. a booking made for a SYNTHETIC patient through the live API shows up on that stream as a
   ``booked`` event, then is cancelled (the smoke identity sees synthetic events only, in the
   minimised shape, so no personal data is involved);
5. the stream closes cleanly when the client leaves.

It opens exactly one stream and receives one event: no polling loop, no keep-warm. Exit 0 only if
every step passed.

    REALTIME_URL=https://sha-abc1234---clinic-realtime-....run.app API_URL=https://clinic-api-....run.app \
    REALTIME_TOKEN=<id token, audience clinic-realtime> API_TOKEN=<id token, audience clinic-api> \
    SMOKE_SIGNING_KEY=<key> python3 scripts/ci/realtime_smoke.py
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import sys
import threading
import time
from urllib.parse import urlsplit

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import verify_claims

AUDIENCE = "clinic-api/internal"
SMOKE_SUB = verify_claims.SMOKE_SUB
IAM_HEADER = "X-Serverless-Authorization"
COLD_START_SECONDS = 60  # Cloud Run start + Neon wake for the first request
EVENT_SECONDS = 15


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def stream_assertion(key: str, target: str, *, now: int | None = None) -> str:
    """The X-Internal-Assertion value for GET <target> (backend/app/core/assertion.py wire format)."""
    iat = int(time.time()) if now is None else now
    claims = {
        "aud": AUDIENCE,
        "sub": SMOKE_SUB,
        "email": "smoke@verify-claims.invalid",
        "role": "smoke",
        "iat": iat,
        "exp": iat + 30,
        "m": "GET",
        "p": target,
        "bh": hashlib.sha256(b"").hexdigest(),
    }
    canonical = json.dumps(claims, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    payload = _b64(canonical.encode("utf-8"))
    mac = _b64(hmac.new(key.encode("utf-8"), payload.encode("ascii"), hashlib.sha256).digest())
    return f"v1.{payload}.{mac}"


def check(ok: bool, label: str) -> bool:
    print(("PASS  " if ok else "FAIL  ") + label, flush=True)
    return ok


class Frames:
    """Reads an SSE response on a thread, so the main thread can wait for a frame with a deadline."""

    def __init__(self, response: httpx.Response) -> None:
        self.response = response
        self.items: list[dict[str, str]] = []
        self.ended = threading.Event()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        cur: dict[str, str] = {}
        try:
            for line in self.response.iter_lines():
                if line == "":
                    if cur:
                        self.items.append(cur)
                    cur = {}
                elif line.startswith("event: "):
                    cur["event"] = line[7:]
                elif line.startswith("data: "):
                    cur["data"] = line[6:]
                elif line.startswith("id: "):
                    cur["id"] = line[4:]
        except (httpx.HTTPError, OSError):
            pass
        finally:
            self.ended.set()

    def wait_for(self, event: str, seconds: float, start: int = 0) -> dict[str, str] | None:
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            for item in self.items[start:]:
                if item.get("event") == event:
                    return item
            time.sleep(0.05)
        return None


def run(realtime_url: str, api_url: str, realtime_token: str, api_token: str, smoke_key: str) -> bool:
    ok = True
    iam = {IAM_HEADER: f"Bearer {realtime_token}"}
    rt = httpx.Client(base_url=realtime_url, headers=iam, timeout=COLD_START_SECONDS)

    r = rt.get("/health")
    ok &= check(r.status_code == 200, f"/health through IAM -> {r.status_code}")

    r = rt.get("/stream")
    ok &= check(r.status_code == 401, f"/stream without an assertion -> {r.status_code} (want 401)")
    forged = stream_assertion("x" * 40, "/stream")
    r = rt.get("/stream", headers={"X-Internal-Assertion": forged})
    ok &= check(r.status_code == 401, f"/stream with a wrong-key assertion -> {r.status_code} (want 401)")
    if not ok:
        return False

    target = "/stream"
    prefix = urlsplit(realtime_url).path.rstrip("/")
    header = stream_assertion(smoke_key, f"{prefix}{target}")
    stream = httpx.Client(base_url=realtime_url, headers=iam, timeout=httpx.Timeout(COLD_START_SECONDS, read=None))
    with stream.stream("GET", target, headers={"X-Internal-Assertion": header}) as resp:
        if not check(resp.status_code == 200, f"/stream with the smoke identity -> {resp.status_code}"):
            return False
        frames = Frames(resp)
        hello = frames.wait_for("hello", COLD_START_SECONDS)
        if not check(hello is not None, "first frame (hello) arrived"):
            return False

        api = httpx.Client(
            base_url=api_url, headers={IAM_HEADER: f"Bearer {api_token}"}, timeout=30
        )
        patient = verify_claims._new_patient(api, 1, smoke_key)  # a synthetic patient
        doctor, _day, slot, _other = verify_claims._pick_slots(api)
        mark = len(frames.items)
        booked = api.post(
            "/appointments", json={"doctor_id": doctor, "patient_id": patient, "starts_at": slot}
        )
        if not check(booked.status_code == 201, f"booking through the live API -> {booked.status_code}"):
            return False
        event = frames.wait_for("booked", EVENT_SECONDS, start=mark)
        ok &= check(event is not None, f"the booking reached the stream within {EVENT_SECONDS} s")
        if event is not None:
            data = json.loads(event["data"])
            ok &= check(
                set(data) == {"event_type", "doctor_id", "local_date", "from_local_date",
                              "from_starts_at", "to_starts_at", "seq"},
                "the event has exactly the minimised shape",
            )
        appointment = booked.json()["id"]
        cancelled = api.patch(f"/appointments/{appointment}/cancel", json={"reason": "release smoke"})
        ok &= check(cancelled.status_code == 200, f"smoke booking cancelled -> {cancelled.status_code}")
    ok &= check(True, "stream closed by the client")
    return ok


def main() -> int:
    need = ["REALTIME_URL", "API_URL", "REALTIME_TOKEN", "API_TOKEN", "SMOKE_SIGNING_KEY"]
    missing = [n for n in need if not os.environ.get(n)]
    if missing:
        print(f"missing environment: {', '.join(missing)}", file=sys.stderr)
        return 2
    passed = run(
        os.environ["REALTIME_URL"].rstrip("/"),
        os.environ["API_URL"].rstrip("/"),
        os.environ["REALTIME_TOKEN"],
        os.environ["API_TOKEN"],
        os.environ["SMOKE_SIGNING_KEY"],
    )
    print("RESULT:", "PASS" if passed else "FAIL")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
