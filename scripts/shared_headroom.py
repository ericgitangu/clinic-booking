#!/usr/bin/env python3
"""Read-only: how much of the SHARED Cloud Run free tier do the other projects use?

The billing account 01C382-12CD13-DCA6EF is shared (PLAN 11.1 Q14), so its monthly free tier
(180,000 vCPU-s, 360,000 GiB-s, 2M requests, 1 GiB North America egress) is spent by every
project on it. This reads the last 30 days of Cloud Run metrics from Cloud Monitoring
(allocation time, request count, bytes sent) for each `project:account` pair given, adds this
project's worst case from PLAN 13.4, and prints the headroom. It changes nothing.

  python3 scripts/shared_headroom.py nanolend-api:developer.ericgitangu@gmail.com \\
      master-crossing-435409-r1:developer.ericgitangu@gmail.com \\
      pawacloud-assessment:the.ace.guru@gmail.com unicorns-484301:developer.ericgitangu@gmail.com

Exit 1 when the combined usage would exceed the free tier (so $0 no longer holds).
Conservative: allocation time (>= billable time) priced at the request-based rates, which are
the higher of the two Cloud Run CPU/memory rates (catalog read 2026-10-16).
"""

from __future__ import annotations

import collections
import datetime
import json
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

FREE = {"cpu": 180_000.0, "mem": 360_000.0, "req": 2_000_000.0, "na_egress": 1024**3}
PRICE = {"cpu": 2.4e-5, "mem": 2.5e-6}  # USD per vCPU-s / GiB-s, request-based billing
# PLAN 13.4 worst month for sil-clinic-booking (DEDUCED).
OURS = {"cpu": 94_400.0, "mem": 90_400.0, "req": 24_400.0, "na_egress": 655e6}
METRICS = {
    "cpu": "run.googleapis.com/container/cpu/allocation_time",
    "mem": "run.googleapis.com/container/memory/allocation_time",
    "req": "run.googleapis.com/request_count",
    "egress": "run.googleapis.com/container/network/sent_bytes_count",
}


def token(account: str) -> str:
    return subprocess.check_output(
        ["gcloud", "auth", "print-access-token", "--account", account], text=True
    ).strip()


def total(project: str, tok: str, metric: str) -> tuple[float, float]:
    """(all bytes/seconds/requests, of which in africa-*) summed over the last 30 days."""
    end = datetime.datetime.now(datetime.UTC).replace(microsecond=0)
    start = end - datetime.timedelta(days=30)
    params = {
        "filter": f'metric.type="{metric}"',
        "interval.startTime": start.isoformat().replace("+00:00", "Z"),
        "interval.endTime": end.isoformat().replace("+00:00", "Z"),
        "aggregation.alignmentPeriod": "2592000s",
        "aggregation.perSeriesAligner": "ALIGN_SUM",
        "aggregation.crossSeriesReducer": "REDUCE_SUM",
        "aggregation.groupByFields": ["resource.label.location"],
    }
    url = (
        f"https://monitoring.googleapis.com/v3/projects/{project}/timeSeries?"
        + urllib.parse.urlencode(params, doseq=True)
    )
    acc = collections.Counter()
    while True:
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok}"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.load(resp)
        for ts in body.get("timeSeries", []):
            loc = ts.get("resource", {}).get("labels", {}).get("location", "?")
            for p in ts["points"]:
                v = p["value"]
                acc[loc] += float(v.get("doubleValue", v.get("int64Value", 0)))
        nxt = body.get("nextPageToken")
        if not nxt:
            break
        url = url.split("&pageToken=")[0] + "&pageToken=" + nxt
    return sum(acc.values()), sum(v for k, v in acc.items() if k.startswith("africa-"))


def main(argv: list[str]) -> int:
    pairs = [a.split(":", 1) for a in argv if ":" in a]
    if not pairs:
        print(__doc__)
        return 2
    rows, tot = [], collections.Counter()
    africa_egress = 0.0
    for project, account in pairs:
        tok = token(account)
        try:
            cpu = total(project, tok, METRICS["cpu"])[0]
            mem = total(project, tok, METRICS["mem"])[0]
            req = total(project, tok, METRICS["req"])[0]
            eg, eg_africa = total(project, tok, METRICS["egress"])
        except urllib.error.HTTPError as e:
            print(
                f"FAIL {project}: monitoring read returned HTTP {e.code}",
                file=sys.stderr,
            )
            return 2
        rows.append((project, cpu, mem, req, eg - eg_africa, eg_africa))
        tot.update({"cpu": cpu, "mem": mem, "req": req, "na_egress": eg - eg_africa})
        africa_egress += eg_africa

    print(
        f"{'project (last 30 days)':30s} {'vCPU-s':>10s} {'GiB-s':>10s} {'requests':>9s} {'NA egress MB':>13s} {'Africa MB':>10s}"
    )
    for p, c, m, r, e, a in rows:
        print(f"{p:30s} {c:10.0f} {m:10.0f} {r:9.0f} {e / 1e6:13.2f} {a / 1e6:10.2f}")
    print(
        f"{'others, total':30s} {tot['cpu']:10.0f} {tot['mem']:10.0f} {tot['req']:9.0f} {tot['na_egress'] / 1e6:13.2f} {africa_egress / 1e6:10.2f}"
    )
    print(
        f"{'this project, worst case':30s} {OURS['cpu']:10.0f} {OURS['mem']:10.0f} {OURS['req']:9.0f} {OURS['na_egress'] / 1e6:13.2f} {0:10.2f}"
    )
    comb = {k: tot[k] + OURS[k] for k in FREE}
    print(
        f"{'combined':30s} {comb['cpu']:10.0f} {comb['mem']:10.0f} {comb['req']:9.0f} {comb['na_egress'] / 1e6:13.2f}"
    )
    print(
        f"{'free tier':30s} {FREE['cpu']:10.0f} {FREE['mem']:10.0f} {FREE['req']:9.0f} {FREE['na_egress'] / 1e6:13.2f}"
    )
    print(
        f"{'headroom':30s} {FREE['cpu'] - comb['cpu']:10.0f} {FREE['mem'] - comb['mem']:10.0f} {FREE['req'] - comb['req']:9.0f} {(FREE['na_egress'] - comb['na_egress']) / 1e6:13.2f}"
    )

    gross = comb["cpu"] * PRICE["cpu"] + comb["mem"] * PRICE["mem"]
    discount = FREE["cpu"] * PRICE["cpu"] + FREE["mem"] * PRICE["mem"]
    africa_usd = africa_egress / 1e9 * 0.12
    print(
        f"\ngross compute ${gross:.2f} of ${discount:.2f} free-tier discount; Africa egress billed from byte 0: about ${africa_usd:.4f}"
    )
    over = [k for k in FREE if comb[k] > FREE[k]] + (
        ["gross"] if gross > discount else []
    )
    print(
        "VERDICT: "
        + (
            "FAIL, over the free tier on " + ", ".join(over)
            if over
            else "PASS, within the free tier (not a guarantee for next month)"
        )
    )
    return 1 if over else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
