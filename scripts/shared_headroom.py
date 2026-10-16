#!/usr/bin/env python3
"""Read-only: how much of the SHARED Cloud Run free tier do the other projects use?

The billing account 01C382-12CD13-DCA6EF is shared (PLAN 11.1 Q14), so its monthly free tier
(180,000 vCPU-s, 360,000 GiB-s, 2M requests, 1 GiB North America egress) is spent by every
project on it. Cloud Run has TWO compute free tiers, one per billing mode (cloud.google.com/run/pricing,
read 2026-10-16): request-based 180,000 vCPU-s and 360,000 GiB-s, instance-based (CPU always
allocated, cpu-throttling=false) 240,000 vCPU-s and 450,000 GiB-s, each priced at its own rates.
Each service is assigned to its mode from the Cloud Run Admin API (`resources.cpuIdle`) and the
usage is checked against its own mode's tier. This reads the last 30 days of Cloud Run metrics from Cloud Monitoring
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

FREE = {
    "request": {"cpu": 180_000.0, "mem": 360_000.0},
    "instance": {"cpu": 240_000.0, "mem": 450_000.0},
}
RATE = {  # USD per vCPU-s / GiB-s, Cloud Billing catalog 2026-10-16 (same in the 3 regions seen)
    "request": {"cpu": 2.4e-5, "mem": 2.5e-6},
    "instance": {"cpu": 1.8e-5, "mem": 2e-6},
}
FREE_REQ, FREE_NA_EGRESS = 2_000_000.0, 1024**3
# PLAN 13.4 worst month for sil-clinic-booking (DEDUCED); request-based (cpu-throttling=true).
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


def get(url: str, tok: str) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok}"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def modes(project: str, tok: str) -> dict[str, str]:
    """service name -> 'instance' | 'request' (cpuIdle false = CPU always allocated)."""
    out: dict[str, str] = {}
    url = f"https://run.googleapis.com/v2/projects/{project}/locations/-/services"
    while url:
        body = get(url, tok)
        for svc in body.get("services", []):
            res = (
                svc.get("template", {}).get("containers", [{}])[0].get("resources", {})
            )
            idle = res.get("cpuIdle", False)  # proto3 omits false: CPU always allocated
            out[svc["name"].rsplit("/", 1)[-1]] = "request" if idle else "instance"
        nxt = body.get("nextPageToken")
        url = url.split("?")[0] + "?pageToken=" + nxt if nxt else ""
    return out


def total(project: str, tok: str, metric: str) -> dict[tuple[str, str], float]:
    """(service, location) -> sum over the last 30 days."""
    end = datetime.datetime.now(datetime.UTC).replace(microsecond=0)
    start = end - datetime.timedelta(days=30)
    params = {
        "filter": f'metric.type="{metric}"',
        "interval.startTime": start.isoformat().replace("+00:00", "Z"),
        "interval.endTime": end.isoformat().replace("+00:00", "Z"),
        "aggregation.alignmentPeriod": "2592000s",
        "aggregation.perSeriesAligner": "ALIGN_SUM",
        "aggregation.crossSeriesReducer": "REDUCE_SUM",
        "aggregation.groupByFields": [
            "resource.label.service_name",
            "resource.label.location",
        ],
    }
    url = (
        f"https://monitoring.googleapis.com/v3/projects/{project}/timeSeries?"
        + urllib.parse.urlencode(params, doseq=True)
    )
    acc: collections.Counter = collections.Counter()
    while True:
        body = get(url, tok)
        for ts in body.get("timeSeries", []):
            lab = ts.get("resource", {}).get("labels", {})
            key = (lab.get("service_name", "?"), lab.get("location", "?"))
            for p in ts["points"]:
                v = p["value"]
                acc[key] += float(v.get("doubleValue", v.get("int64Value", 0)))
        nxt = body.get("nextPageToken")
        if not nxt:
            break
        url = url.split("&pageToken=")[0] + "&pageToken=" + nxt
    return dict(acc)


def main(argv: list[str]) -> int:
    pairs = [a.split(":", 1) for a in argv if ":" in a]
    if not pairs:
        print(__doc__)
        return 2
    # per mode: cpu, mem; shared: req, NA egress, Africa egress
    use = {m: collections.Counter() for m in FREE}
    shared: collections.Counter = collections.Counter()
    rows = []
    for project, account in pairs:
        tok = token(account)
        try:
            try:
                mode_of = modes(project, tok)
            except urllib.error.HTTPError as e:
                if e.code not in (403, 404):  # Run API not enabled: no services
                    raise
                mode_of = {}
            data = {k: total(project, tok, m) for k, m in METRICS.items()}
        except urllib.error.HTTPError as e:
            print(f"FAIL {project}: read returned HTTP {e.code}", file=sys.stderr)
            return 2
        row = collections.Counter()
        for (svc, loc), v in data["cpu"].items():
            m = mode_of.get(
                svc, "request"
            )  # unknown/deleted service: the cheaper-tier guess
            use[m]["cpu"] += v
            row[m + "_cpu"] += v
        for (svc, loc), v in data["mem"].items():
            m = mode_of.get(svc, "request")
            use[m]["mem"] += v
            row[m + "_mem"] += v
        row["req"] = sum(data["req"].values())
        for (svc, loc), v in data["egress"].items():
            row["africa" if loc.startswith("africa-") else "na"] += v
        shared.update({k: row[k] for k in ("req", "na", "africa")})
        rows.append((project, row))

    print(
        f"{'project (30 days, observed)':28s} {'req-based vCPU-s':>16s} {'GiB-s':>9s} {'inst-based vCPU-s':>17s} {'GiB-s':>9s} {'requests':>9s} {'NA MB':>8s} {'Africa MB':>9s}"
    )
    for p, r in rows:
        print(
            f"{p:28s} {r['request_cpu']:16.0f} {r['request_mem']:9.0f} {r['instance_cpu']:17.0f} {r['instance_mem']:9.0f} {r['req']:9.0f} {r['na'] / 1e6:8.2f} {r['africa'] / 1e6:9.2f}"
        )

    over: list[str] = []
    gross_total = 0.0
    for m in ("request", "instance"):
        ours = OURS if m == "request" else {"cpu": 0.0, "mem": 0.0}
        comb = {k: use[m][k] + ours[k] for k in ("cpu", "mem")}
        gross = sum(comb[k] * RATE[m][k] for k in comb)
        disc = sum(FREE[m][k] * RATE[m][k] for k in comb)
        gross_total += max(gross - disc, 0.0)
        print(
            f"\n[{m}-based] others {use[m]['cpu']:.0f} vCPU-s / {use[m]['mem']:.0f} GiB-s"
            f" + ours {ours['cpu']:.0f} / {ours['mem']:.0f} = {comb['cpu']:.0f} / {comb['mem']:.0f}"
            f"; free {FREE[m]['cpu']:.0f} / {FREE[m]['mem']:.0f}"
            f"; headroom {FREE[m]['cpu'] - comb['cpu']:.0f} / {FREE[m]['mem'] - comb['mem']:.0f}"
            f"; gross ${gross:.2f} of ${disc:.2f}"
        )
        over += [f"{m}:{k}" for k in comb if comb[k] > FREE[m][k]]
    req = shared["req"] + OURS["req"]
    na = shared["na"] + OURS["na_egress"]
    print(
        f"\nrequests {req:.0f} of {FREE_REQ:.0f}; NA egress {na / 1e6:.0f} MB of {FREE_NA_EGRESS / 1e6:.0f} MB;"
        f" Africa egress billed from byte 0: about ${shared['africa'] / 1e9 * 0.12:.4f}"
    )
    if req > FREE_REQ:
        over.append("requests")
    if na > FREE_NA_EGRESS:
        over.append("na_egress")
    print(
        "VERDICT: "
        + (
            "FAIL, over the free tier on " + ", ".join(over)
            if over
            else "PASS, within each mode's free tier (not a guarantee for next month)"
        )
    )
    return 1 if over else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
