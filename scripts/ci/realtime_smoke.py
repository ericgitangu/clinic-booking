"""Release smoke for the live-feed gateway: short, bounded stream probes, then nothing left open.

Run by ship-realtime against the TAGGED, no-traffic revision of clinic-realtime, after ship-api
has made the new API live. It checks, in order, that:

1. /health answers through Cloud Run IAM (the invoker token works);
2. /stream without an assertion, and with one signed by a wrong key, is refused with 401;
3. a stream opened with the smoke identity's assertion starts: the first bytes are the ``hello``
   frame with its cursor, and the gateway then ends the stream itself (reason ``probe``);
4. a booking made for a SYNTHETIC patient through the live API is read back as a ``booked`` event
   by resuming from that cursor, in the minimised shape (the smoke identity sees synthetic events
   only, so no personal data is involved), and is then cancelled.

Every stream read is a bounded read of STREAM_SECONDS (sse_probe.py), and the gateway closes
the smoke's streams after their catch-up, so no stream outlives its step. On 2026-10-19 this smoke
held a stream open for 242 s (Cloud Run never told the instance it had gone), and the live check
after promotion found no free instance and rolled the release back.

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
import time
from urllib.parse import urlsplit

import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sse_probe
import verify_claims

AUDIENCE = "clinic-api/internal"
SMOKE_SUB = verify_claims.SMOKE_SUB
IAM_HEADER = "X-Serverless-Authorization"
COLD_START_SECONDS = 60  # Cloud Run start + Neon wake for the first request
STREAM_SECONDS = 5  # the most any one stream read may take
HELLO_ATTEMPTS = 3  # the first stream may wait for Neon to wake
RESUME_ATTEMPTS = 6  # the booking may not be behind the snapshot horizon yet
RESUME_PAUSE_SECONDS = 1.0
MINIMISED = {"event_type", "doctor_id", "local_date", "from_local_date", "from_starts_at",
             "to_starts_at", "seq"}


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


def _probe(realtime_url: str, token: str, key: str, target: str) -> sse_probe.Probe:
    prefix = urlsplit(realtime_url).path.rstrip("/")
    return sse_probe.probe(
        realtime_url + target,
        {IAM_HEADER: f"Bearer {token}", "X-Internal-Assertion": stream_assertion(key, prefix + target)},
        STREAM_SECONDS,
    )


def ended_as_probe(p: sse_probe.Probe) -> bool:
    end = p.first("reconnect")
    return end is not None and '"reason":"probe"' in end.get("data", "")


def run(realtime_url: str, api_url: str, realtime_token: str, api_token: str, smoke_key: str) -> bool:
    ok = True
    iam = {IAM_HEADER: f"Bearer {realtime_token}"}
    with httpx.Client(base_url=realtime_url, headers=iam, timeout=COLD_START_SECONDS) as rt:
        r = rt.get("/health")
        ok &= check(r.status_code == 200, f"/health through IAM -> {r.status_code}")
        r = rt.get("/stream")
        ok &= check(r.status_code == 401, f"/stream without an assertion -> {r.status_code} (want 401)")
        forged = stream_assertion("x" * 40, "/stream")
        r = rt.get("/stream", headers={"X-Internal-Assertion": forged})
        ok &= check(r.status_code == 401, f"/stream with a wrong-key assertion -> {r.status_code} (want 401)")
    if not ok:
        return False

    first = None
    for _ in range(HELLO_ATTEMPTS):
        first = _probe(realtime_url, realtime_token, smoke_key, "/stream")
        if first.status == 200 and first.frames:
            break
    assert first is not None
    if not check(first.status == 200, f"/stream with the smoke identity -> {first.status}"):
        return False
    hello = first.frames[0] if first.frames else {}
    if not check(
        first.body.startswith("id: ") and hello.get("event") == "hello" and bool(hello.get("id")),
        "the first bytes are the hello frame, with its cursor",
    ):
        return False
    ok &= check(ended_as_probe(first) and not first.timed_out,
                f"the gateway closed the smoke stream itself, within {STREAM_SECONDS} s")

    with httpx.Client(base_url=api_url, headers={IAM_HEADER: f"Bearer {api_token}"}, timeout=30) as api:
        patient = verify_claims._new_patient(api, 1, smoke_key)  # a synthetic patient
        doctor, _day, slot, _other = verify_claims._pick_slots(api)
        booked = api.post(
            "/appointments", json={"doctor_id": doctor, "patient_id": patient, "starts_at": slot}
        )
        if not check(booked.status_code == 201, f"booking through the live API -> {booked.status_code}"):
            return False
        try:
            event = None
            target = f"/stream?cursor={hello['id']}"
            for _ in range(RESUME_ATTEMPTS):
                again = _probe(realtime_url, realtime_token, smoke_key, target)
                event = again.first("booked")
                if event is not None or again.status != 200:
                    break
                time.sleep(RESUME_PAUSE_SECONDS)
            ok &= check(event is not None, "the booking is read back by resuming from the hello cursor")
            if event is not None:
                ok &= check(set(json.loads(event["data"])) == MINIMISED,
                            "the event has exactly the minimised shape")
        finally:
            appointment = booked.json()["id"]
            cancelled = api.patch(f"/appointments/{appointment}/cancel", json={"reason": "release smoke"})
            ok &= check(cancelled.status_code == 200, f"smoke booking cancelled -> {cancelled.status_code}")
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
