#!/usr/bin/env python3
"""Verify the live API's claims end to end.

Creates its own patients, drives the real booking flow against --base-url, prints a PASS/FAIL
table and exits non-zero on any FAIL. The same script runs in CI (with a CI-only invoker
token via --header) and from a reviewer's laptop against the public URL.

Synthetic patients. The booking flow writes real rows, so against production every run would show
up in the admin dashboard. When SMOKE_SIGNING_KEY is in the environment the script creates its
patients through the signed internal smoke endpoint, which stores them with synthetic = true; the
admin views leave those out. CI passes --require-synthetic, so a pipeline without the key fails
instead of quietly writing unmarked rows. Without the key (a reviewer's laptop) it uses the public
POST /patients and says so: those rows are ordinary patients. The key is read from the environment
only, never from argv.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import random
import sys
import time
import uuid
from datetime import datetime
from typing import Any
from urllib.parse import urljoin, urlsplit
from zoneinfo import ZoneInfo

import httpx

CLINIC_TZ = ZoneInfo("Africa/Nairobi")
BOOK_ATTEMPTS = 3
RESULTS: list[tuple[bool, str]] = []
_rng = random.SystemRandom()


def check(ok: bool, label: str) -> bool:
    RESULTS.append((ok, label))
    return ok


def location_url(base_url: str, location: str) -> str:
    """Resolve a Location header against the API base URL.

    The API emits a root-relative Location (/appointments/{id}); the web proxy rewrites it to
    /api/appointments/{id}. A root-relative reference replaces the whole path of the base, so
    joining it to the base as-is is correct at both origins (do not strip the leading slash:
    that appends the already-prefixed path to the base's own prefix).
    """
    return urljoin(base_url, location)


def _headers(pairs: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for p in pairs:
        name, _, value = p.partition(":")
        out[name.strip()] = value.strip()
    return out


def jbody(resp: httpx.Response) -> dict[str, Any]:
    """The JSON object in a response, or {} when the body is not JSON (an HTML error page)."""
    try:
        body = resp.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


SMOKE_ENV = "SMOKE_SIGNING_KEY"
SMOKE_PATH = "/internal/smoke/patients"
SMOKE_AUDIENCE = "clinic-api/internal"
SMOKE_SUB = "smoke:verify-claims"
SMOKE_TTL_SECONDS = 30


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def smoke_assertion(key: str, *, path: str, body: bytes, now: int | None = None) -> str:
    """The ``X-Internal-Assertion`` value for the smoke endpoint: the wire format of
    backend/app/core/assertion.py (``v1.<payload>.<mac>``, bound to method, path and body)."""
    iat = int(time.time()) if now is None else now
    claims = {
        "aud": SMOKE_AUDIENCE,
        "sub": SMOKE_SUB,
        "email": "smoke@verify-claims.invalid",
        "role": "smoke",
        "iat": iat,
        "exp": iat + SMOKE_TTL_SECONDS,
        "m": "POST",
        "p": path,
        "bh": hashlib.sha256(body).hexdigest(),
        "jti": uuid.uuid4().hex,
    }
    canonical = json.dumps(claims, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    payload = _b64(canonical.encode("utf-8"))
    mac = _b64(hmac.new(key.encode("utf-8"), payload.encode("ascii"), hashlib.sha256).digest())
    return f"v1.{payload}.{mac}"


def _new_patient(client: httpx.Client, n: int, smoke_key: str | None = None) -> str:
    ts = datetime.now(CLINIC_TZ).strftime("%Y%m%dT%H%M%S")
    name = {"full_name": f"verify-claims {ts} {n}"}
    if smoke_key is None:
        resp = client.post("/patients", json=name)
    else:
        body = json.dumps(name, separators=(",", ":")).encode("utf-8")
        # The assertion binds the path as the server sees it, so include any prefix in the base URL.
        prefix = urlsplit(str(client.base_url)).path.rstrip("/")
        header = smoke_assertion(smoke_key, path=f"{prefix}{SMOKE_PATH}", body=body)
        resp = client.post(
            SMOKE_PATH,
            content=body,
            headers={"Content-Type": "application/json", "X-Internal-Assertion": header},
        )
    resp.raise_for_status()
    return str(resp.json()["id"])


def _pick_slots(client: httpx.Client) -> tuple[str, str, str, str]:
    """A doctor, a clinic-local day with >= 2 free slots, and two distinct slots chosen at
    random so overlapping runs (CI, reviewers) rarely pick the same slot."""
    doctors = client.get("/doctors").json()["items"]
    today = datetime.now(CLINIC_TZ).date()
    for doctor in doctors:
        did = doctor["id"]
        for offset in range(1, 15):
            day = today.fromordinal(today.toordinal() + offset).isoformat()
            slots = client.get(f"/doctors/{did}/availability?date={day}").json()["slots"]
            if len(slots) >= 2:
                first, second = _rng.sample(slots, 2)
                return did, day, first["starts_at"], second["starts_at"]
    raise SystemExit("no doctor has >= 2 slots in the next 14 clinic-local days")


def run(base_url: str, extra_headers: dict[str, str], smoke_key: str | None = None) -> None:
    with httpx.Client(base_url=base_url, headers=extra_headers, timeout=30) as client:
        booked_id: str | None = None
        try:
            p1 = _new_patient(client, 1, smoke_key)
            p2 = _new_patient(client, 2, smoke_key)

            # Book a random free slot. Another run may take it first (409): pick again.
            did = day = s0 = s1 = ""
            r: httpx.Response | None = None
            for _ in range(BOOK_ATTEMPTS):
                did, day, s0, s1 = _pick_slots(client)
                r = client.post(
                    "/appointments", json={"doctor_id": did, "patient_id": p1, "starts_at": s0}
                )
                if r.status_code != 409:
                    break
            assert r is not None
            check(r.status_code == 201, "book a free slot -> 201")
            if r.status_code == 201:
                booked_id = str(jbody(r).get("id"))
                check(jbody(r).get("status") == "booked", "booked appointment status == booked")
                g = client.get(location_url(base_url, r.headers.get("location", "")))
                check(
                    g.status_code == 200 and jbody(g).get("id") == booked_id,
                    "GET Location -> 200 with the created id",
                )

            # second patient, same slot -> 409 SLOT_TAKEN
            r = client.post(
                "/appointments", json={"doctor_id": did, "patient_id": p2, "starts_at": s0}
            )
            check(
                r.status_code == 409 and jbody(r).get("code") == "SLOT_TAKEN",
                "double-book same slot -> 409 SLOT_TAKEN",
            )

            # the slot is gone from availability
            avail = client.get(f"/doctors/{did}/availability?date={day}").json()["slots"]
            check(all(s["starts_at"] != s0 for s in avail), "booked slot removed from availability")

            # validation errors
            naive = s0.replace("+03:00", "").replace("Z", "")
            r = client.post(
                "/appointments", json={"doctor_id": did, "patient_id": p1, "starts_at": naive}
            )
            check(
                r.status_code == 422 and jbody(r).get("code") == "TIMEZONE_REQUIRED",
                "naive datetime -> 422 TIMEZONE_REQUIRED",
            )
            r = client.post(
                "/appointments",
                json={"doctor_id": did, "patient_id": p1, "starts_at": "2000-01-01T09:00:00+03:00"},
            )
            check(
                r.status_code == 422 and jbody(r).get("code") == "SLOT_IN_PAST",
                "past slot -> 422 SLOT_IN_PAST",
            )
            offhours = s0[:11] + "02:00:00+03:00"
            r = client.post(
                "/appointments", json={"doctor_id": did, "patient_id": p1, "starts_at": offhours}
            )
            check(
                r.status_code == 422
                and jbody(r).get("code") in ("OUTSIDE_WORKING_HOURS", "BOOKING_TOO_SOON"),
                "off-hours time -> 422",
            )

            if booked_id:
                # reschedule -> 200, the old slot returns to availability
                r = client.patch(f"/appointments/{booked_id}/reschedule", json={"starts_at": s1})
                check(r.status_code == 200, "reschedule -> 200")
                avail = client.get(f"/doctors/{did}/availability?date={day}").json()["slots"]
                check(
                    any(s["starts_at"] == s0 for s in avail),
                    "old slot back in availability after reschedule",
                )
                up = client.get(f"/patients/{p1}/appointments").json().get("items", [])
                starts = [i["starts_at"] for i in up]
                check(starts == sorted(starts), "upcoming list sorted")
                check(any(i["id"] == booked_id for i in up), "upcoming contains the appointment")

                # cancel -> 200; cancel again -> 409; reschedule after cancel -> 409
                cancelled_id = booked_id
                r = client.patch(
                    f"/appointments/{cancelled_id}/cancel", json={"reason": "verify-claims cleanup"}
                )
                cancel_ok = check(r.status_code == 200, "cancel -> 200")
                if cancel_ok:
                    booked_id = None  # only a confirmed cancel clears the cleanup obligation
                    r = client.patch(
                        f"/appointments/{cancelled_id}/cancel", json={"reason": "again"}
                    )
                    check(
                        r.status_code == 409
                        and jbody(r).get("code") == "APPOINTMENT_ALREADY_CANCELLED",
                        "cancel again -> 409 APPOINTMENT_ALREADY_CANCELLED",
                    )
                    r = client.patch(
                        f"/appointments/{cancelled_id}/reschedule", json={"starts_at": s1}
                    )
                    check(r.status_code == 409, "reschedule after cancel -> 409")
                else:
                    check(False, "cancel again -> 409 (not run: the first cancel failed)")
                    check(
                        False, "reschedule after cancel -> 409 (not run: the first cancel failed)"
                    )

            # unknown appointment -> 404 problem+json
            r = client.get("/appointments/00000000-0000-0000-0000-000000000000")
            check(
                r.status_code == 404
                and r.headers.get("content-type", "").startswith("application/problem+json"),
                "unknown appointment -> 404 problem+json",
            )

            # openapi title (follow redirects: $PUBLIC_API/openapi.json 308s to the web root)
            r = client.get("/openapi.json", follow_redirects=True)
            check(
                r.status_code == 200
                and jbody(r).get("info", {}).get("title")
                in ("Idyllic Clinic API", "Clinic Booking API"),  # old name until the release carries the new
                "/openapi.json title",
            )
        finally:
            if booked_id:
                cleanup = client.patch(
                    f"/appointments/{booked_id}/cancel", json={"reason": "verify-claims teardown"}
                )
                check(cleanup.status_code == 200, "cleanup cancel of a leftover booking -> 200")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--header", action="append", default=[], help="repeatable 'Name: value'")
    parser.add_argument(
        "--require-synthetic",
        action="store_true",
        help=f"fail unless {SMOKE_ENV} is set, so no unmarked rows are written (CI)",
    )
    args = parser.parse_args()

    smoke_key = os.environ.get(SMOKE_ENV) or None
    if smoke_key is None:
        if args.require_synthetic:
            print(f"FAIL  {SMOKE_ENV} is not set; refusing to write unmarked rows", file=sys.stderr)
            return 2
        print(
            f"note: {SMOKE_ENV} is not set, so the patients this run creates are ordinary "
            "(not marked synthetic) and will show in the admin dashboard.",
            file=sys.stderr,
        )
    run(args.base_url.rstrip("/"), _headers(args.header), smoke_key)

    width = max(len(label) for _, label in RESULTS)
    failed = 0
    for ok, label in RESULTS:
        status = "PASS" if ok else "FAIL"
        if not ok:
            failed += 1
        print(f"{status}  {label.ljust(width)}")
    print(f"\n{len(RESULTS) - failed}/{len(RESULTS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
