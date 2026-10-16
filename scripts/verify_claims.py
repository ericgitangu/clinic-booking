#!/usr/bin/env python3
"""Verify the live API's claims end to end (WP-12).

Creates its own patients, drives the real booking flow against --base-url, prints a PASS/FAIL
table and exits non-zero on any FAIL. The same script runs in CI (with a CI-only invoker
token via --header) and from a reviewer's laptop against the public URL.
"""

from __future__ import annotations

import argparse
import sys
from datetime import UTC, datetime
from urllib.parse import urljoin

import httpx

RESULTS: list[tuple[bool, str]] = []


def check(ok: bool, label: str) -> bool:
    RESULTS.append((ok, label))
    return ok


def _headers(pairs: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for p in pairs:
        name, _, value = p.partition(":")
        out[name.strip()] = value.strip()
    return out


def _new_patient(client: httpx.Client, n: int) -> str:
    ts = datetime.now(UTC).strftime("%Y%m%dT%H%M%S")
    resp = client.post("/patients", json={"full_name": f"verify-claims {ts} {n}"})
    resp.raise_for_status()
    return str(resp.json()["id"])


def _first_availability(client: httpx.Client) -> tuple[str, str, list[dict[str, str]]]:
    doctors = client.get("/doctors").json()["items"]
    today = datetime.now(UTC).date()
    for doctor in doctors:
        did = doctor["id"]
        for offset in range(1, 15):
            day = today.fromordinal(today.toordinal() + offset).isoformat()
            slots = client.get(f"/doctors/{did}/availability?date={day}").json()["slots"]
            if len(slots) >= 2:
                return did, day, slots
    raise SystemExit("no doctor has >= 2 slots in the next 14 days")


def run(base_url: str, extra_headers: dict[str, str]) -> None:
    with httpx.Client(base_url=base_url, headers=extra_headers, timeout=30) as client:
        did, day, slots = _first_availability(client)
        booked_id: str | None = None
        try:
            p1 = _new_patient(client, 1)
            p2 = _new_patient(client, 2)

            # book slots[0]
            r = client.post(
                "/appointments",
                json={"doctor_id": did, "patient_id": p1, "starts_at": slots[0]["starts_at"]},
            )
            check(r.status_code == 201, "book slots[0] -> 201")
            if r.status_code == 201:
                booked_id = r.json()["id"]
                check(r.json()["status"] == "booked", "booked appointment status == booked")
                loc = r.headers.get("location", "")
                g = client.get(urljoin(base_url + "/", loc.lstrip("/")))
                check(
                    g.status_code == 200 and g.json().get("id") == booked_id,
                    "GET Location -> 200 with the created id",
                )

            # second patient, same slot -> 409 SLOT_TAKEN
            r = client.post(
                "/appointments",
                json={"doctor_id": did, "patient_id": p2, "starts_at": slots[0]["starts_at"]},
            )
            check(
                r.status_code == 409 and r.json()["code"] == "SLOT_TAKEN",
                "double-book same slot -> 409 SLOT_TAKEN",
            )

            # the slot is gone from availability
            avail = client.get(f"/doctors/{did}/availability?date={day}").json()["slots"]
            check(
                all(s["starts_at"] != slots[0]["starts_at"] for s in avail),
                "booked slot removed from availability",
            )

            # validation errors
            naive = slots[0]["starts_at"].replace("+03:00", "").replace("Z", "")
            r = client.post(
                "/appointments", json={"doctor_id": did, "patient_id": p1, "starts_at": naive}
            )
            check(
                r.status_code == 422 and r.json()["code"] == "TIMEZONE_REQUIRED",
                "naive datetime -> 422 TIMEZONE_REQUIRED",
            )
            r = client.post(
                "/appointments",
                json={"doctor_id": did, "patient_id": p1, "starts_at": "2000-01-01T09:00:00+03:00"},
            )
            check(
                r.status_code == 422 and r.json()["code"] == "SLOT_IN_PAST",
                "past slot -> 422 SLOT_IN_PAST",
            )
            offhours = slots[0]["starts_at"][:11] + "02:00:00+03:00"
            r = client.post(
                "/appointments", json={"doctor_id": did, "patient_id": p1, "starts_at": offhours}
            )
            check(
                r.status_code == 422
                and r.json()["code"] in ("OUTSIDE_WORKING_HOURS", "BOOKING_TOO_SOON"),
                "off-hours time -> 422",
            )

            # reschedule to slots[1] -> 200, old slot returns to availability
            if booked_id:
                r = client.patch(
                    f"/appointments/{booked_id}/reschedule",
                    json={"starts_at": slots[1]["starts_at"]},
                )
                check(r.status_code == 200, "reschedule -> 200")
                avail = client.get(f"/doctors/{did}/availability?date={day}").json()["slots"]
                check(
                    any(s["starts_at"] == slots[0]["starts_at"] for s in avail),
                    "old slot back in availability after reschedule",
                )
                up = client.get(f"/patients/{p1}/appointments").json()["items"]
                starts = [i["starts_at"] for i in up]
                check(starts == sorted(starts), "upcoming list sorted")
                check(any(i["id"] == booked_id for i in up), "upcoming contains the appointment")

                # cancel -> 200; cancel again -> 409; reschedule after cancel -> 409
                r = client.patch(
                    f"/appointments/{booked_id}/cancel", json={"reason": "verify-claims cleanup"}
                )
                check(r.status_code == 200, "cancel -> 200")
                r = client.patch(
                    f"/appointments/{booked_id}/cancel", json={"reason": "again"}
                )
                check(
                    r.status_code == 409 and r.json()["code"] == "APPOINTMENT_ALREADY_CANCELLED",
                    "cancel again -> 409 APPOINTMENT_ALREADY_CANCELLED",
                )
                r = client.patch(
                    f"/appointments/{booked_id}/reschedule",
                    json={"starts_at": slots[1]["starts_at"]},
                )
                check(r.status_code == 409, "reschedule after cancel -> 409")
                booked_id = None

            # unknown appointment -> 404 problem+json
            r = client.get("/appointments/00000000-0000-0000-0000-000000000000")
            check(
                r.status_code == 404
                and r.headers["content-type"].startswith("application/problem+json"),
                "unknown appointment -> 404 problem+json",
            )

            # openapi title (follow redirects: $PUBLIC_API/openapi.json 308s to the web root)
            r = client.get("/openapi.json", follow_redirects=True)
            check(
                r.status_code == 200 and r.json()["info"]["title"] == "Clinic Booking API",
                "/openapi.json title",
            )
        finally:
            if booked_id:
                client.patch(
                    f"/appointments/{booked_id}/cancel", json={"reason": "verify-claims teardown"}
                )


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
