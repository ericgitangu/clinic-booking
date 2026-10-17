"""Prove that SSE frames flush through a public base URL and measure how.

Opens one stream, makes one real booking through the same base URL, waits for the matching
appointment.booked frame, cancels the booking, closes the stream and prints timings.
Exit 0 only if the first frame arrives and the booking event is flushed within --max-latency.

Standard library only. Run it as `python3 -I stream_proof.py ...`.

  # local, through apps/booking's proxy, ticket signed with the gateway's local key
  STREAM_TICKET_KEY=... python3 -I stream_proof.py --base http://localhost:3116/api

  # production: the ticket comes from POST <base>/admin/stream-ticket
  python3 -I stream_proof.py --base https://<booking-host>/api
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import http.client
import json
import os
import secrets
import sys
import threading
import time
import urllib.parse
import urllib.request


def sign_ticket(key: str, life: int) -> str:
    def b64(raw: bytes) -> bytes:
        return base64.urlsafe_b64encode(raw).rstrip(b"=")

    payload = {"v": 1, "aud": "clinic-realtime", "exp": int(time.time()) + 60, "life": life}
    body = b64(json.dumps(payload, separators=(",", ":")).encode())
    return (body + b"." + b64(hmac.new(key.encode(), body, hashlib.sha256).digest())).decode()


def call(base: str, method: str, path: str, body: dict | None = None, want: int = 200) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        base + path,
        data=data,
        method=method,
        headers={"content-type": "application/json", "idempotency-key": secrets.token_hex(16)},
    )
    if not base.startswith(("http://", "https://")):
        sys.exit("--base must be an http(s) URL")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            status, raw = resp.status, resp.read()
    except urllib.error.HTTPError as err:
        status, raw = err.code, err.read()
    if status != want:
        sys.exit(f"{method} {path} -> {status}, want {want}: {raw[:300]!r}")
    return json.loads(raw) if raw else {}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True, help="public API base, e.g. https://host/api")
    ap.add_argument("--max-latency", type=float, default=2.0, help="seconds from booking response to frame")
    ap.add_argument("--life", type=int, default=60, help="local ticket lifetime in seconds")
    args = ap.parse_args()
    base = args.base.rstrip("/")

    key = os.environ.get("STREAM_TICKET_KEY")
    if key:
        ticket = sign_ticket(key, args.life)
    else:
        ticket = call(base, "POST", "/admin/stream-ticket", {}, want=200)["ticket"]

    parts = urllib.parse.urlsplit(base)
    conn_cls = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    conn = conn_cls(parts.netloc, timeout=120)
    t0 = time.monotonic()
    conn.request("GET", f"{parts.path}/stream?ticket={urllib.parse.quote(ticket)}", headers={"accept": "text/event-stream"})
    resp = conn.getresponse()
    t_headers = time.monotonic() - t0
    print(f"stream status={resp.status} content-type={resp.getheader('content-type')} "
          f"cache-control={resp.getheader('cache-control')} headers-after={t_headers:.3f}s")
    if resp.status != 200:
        sys.exit(f"stream refused: {resp.read()[:300]!r}")

    lines: list[tuple[float, str]] = []
    done = threading.Event()

    def reader() -> None:
        while not done.is_set():
            line = resp.fp.readline()
            if not line:
                return
            lines.append((time.monotonic() - t0, line.decode().rstrip("\n")))

    threading.Thread(target=reader, daemon=True).start()

    def wait_for(needle: str, within: float, since: int = 0) -> tuple[float, str] | None:
        end = time.monotonic() + within
        while time.monotonic() < end:
            for stamp, text in lines[since:]:
                if needle in text:
                    return stamp, text
            time.sleep(0.02)
        return None

    hello = wait_for("event: hello", 10)
    if not hello:
        sys.exit("no hello frame within 10 s: the proxy buffered the stream or it never opened")
    print(f"first frame (hello) at +{hello[0]:.3f}s")

    suffix = secrets.token_hex(4)
    doctor = call(base, "GET", "/doctors")["items"][0]["id"]
    patient = call(base, "POST", "/patients", {
        "full_name": f"Stream Proof {suffix}", "email": f"proof-{suffix}@realtime-tests.org",
    }, want=201)["id"]
    slot = None
    for offset in range(3, 40):
        day = time.strftime("%Y-%m-%d", time.gmtime(time.time() + offset * 86400))
        slots = call(base, "GET", f"/doctors/{doctor}/availability?date={day}")["slots"]
        if slots:
            slot = slots[len(slots) // 2]["starts_at"]
            break
    if slot is None:
        sys.exit("no free slot in 40 days")
    mark = len(lines)
    appt = call(base, "POST", "/appointments", {"doctor_id": doctor, "patient_id": patient, "starts_at": slot}, want=201)
    t_booked = time.monotonic() - t0
    got = wait_for("event: appointment.booked", 15, since=mark)
    ok = bool(got) and (got[0] - t_booked) <= args.max_latency
    if got:
        latency = got[0] - t_booked
        print(f"appointment.booked frame at +{got[0]:.3f}s, {latency:.3f}s after the booking response "
              f"(limit {args.max_latency}s)")
        data_line = next((t for s, t in lines if s >= got[0] and t.startswith("data: ")), "")
        print("payload:", data_line[6:])
        if "appointment_id" in data_line:
            ok = False
            print("FAIL: payload carries appointment_id")
    else:
        print("FAIL: no appointment.booked frame within 15 s")

    beats = [s for s, t in lines if t == ": hb"]
    if beats:
        print("heartbeat comments at:", ", ".join(f"+{b:.1f}s" for b in beats[:5]))
    call(base, "PATCH", f"/appointments/{appt['id']}/cancel", {"reason": "stream proof cleanup"})
    connected = time.monotonic() - t0
    done.set()
    conn.close()
    print(f"connected_seconds={connected:.1f} (the gateway logs the same figure as connected_seconds)")
    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
