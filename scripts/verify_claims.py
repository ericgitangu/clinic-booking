#!/usr/bin/env python3
"""Verify the live API's claims end to end.

Creates its own patients, drives the real booking flow against --base-url, prints a PASS/FAIL
table and exits non-zero on any FAIL. The same script runs in CI (with a CI-only invoker
token via --header) and from a reviewer's laptop against the public URL.
"""

from __future__ import annotations

import argparse
import random
import sys
from datetime import datetime
from typing import Any
from urllib.parse import urljoin
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


def _new_patient(client: httpx.Client, n: int) -> str:
    ts = datetime.now(CLINIC_TZ).strftime("%Y%m%dT%H%M%S")
    resp = client.post("/patients", json={"full_name": f"verify-claims {ts} {n}"})
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


def run(base_url: str, extra_headers: dict[str, str]) -> None:
    with httpx.Client(base_url=base_url, headers=extra_headers, timeout=30) as client:
        booked_id: str | None = None
        try:
            p1 = _new_patient(client, 1)
            p2 = _new_patient(client, 2)

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
                and jbody(r).get("info", {}).get("title") == "Clinic Booking API",
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
    args = parser.parse_args()

    run(args.base_url.rstrip("/"), _headers(args.header))

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
