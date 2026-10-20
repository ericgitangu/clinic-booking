#!/usr/bin/env bash
#
# Measure what one connected hour of the live feed costs in vCPU-seconds, on the deployed service.
#
#   bash scripts/ops/measure_realtime_cost.sh                 hold streams, read Cloud Monitoring, judge, write the evidence file
#   bash scripts/ops/measure_realtime_cost.sh --judge CONNECTED_SECONDS VCPU_SECONDS
#                                                             only the judgement (no cloud), for tests
#   bash scripts/ops/measure_realtime_cost.sh --readme-line   the sentence the README carries, from the evidence file
#   bash scripts/ops/measure_realtime_cost.sh --update-readme  put that sentence into README.md (between the realtime-cost markers)
#
# The run is deliberately small and billable: SESSIONS x HOLD_SECONDS of one 0.25 vCPU instance
# (default 3 x 120 s = 360 connected seconds = about 90 vCPU-seconds). Everything it reads is
# read-only (Cloud Monitoring and Cloud Run metadata, always --project/--region explicit); the
# only writes are the evidence file and the streams themselves. It opens streams as the release
# smoke identity, which sees only synthetic events.
#
# Metric: run.googleapis.com/container/cpu/allocation_time (unit s{CPU}), the CPU time Cloud Run
# allocated to the service; with request-based billing that is the billed CPU. It lags by a few
# minutes, so the script polls until the window is covered or gives up (and then fails closed).
# Verified readable on clinic-api on 2026-10-19; the same query shape serves clinic-realtime.
#
# Budget (fails closed above it): BUDGET_VCPU_S_PER_HOUR, default 1100 = the 900 a quarter-vCPU
# instance holds for an hour plus about 20% for the cold start. Derivation: the shared account's
# request-based free tier had 21,619 vCPU-seconds of headroom after every other project and the API
# (the figure last measured; `make shared-headroom` re-measures it); at 1100 vCPU-s per connected hour that is
# about 19 connected hours a month, and the gateway should be given no more than a quarter of the
# headroom (about 5 hours), which is what the idle close and the visible-tab rule are for.
set -euo pipefail

PROJECT=sil-clinic-booking
REGION=us-east4
SERVICE=clinic-realtime
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
EVIDENCE="${EVIDENCE:-$ROOT/docs/evidence/realtime-cost.json}"
BUDGET="${BUDGET_VCPU_S_PER_HOUR:-1100}"
HEADROOM="${SHARED_HEADROOM_VCPU_S:-21619}"
MIN_CONNECTED_SECONDS=120

# judge <connected seconds> <vcpu seconds>: prints the rate and exits 0 only within budget.
judge() {
  local connected="$1" vcpu="$2"
  case "$connected$vcpu" in *[!0-9.]*|'') echo "FAIL: connected '$connected' and vCPU '$vcpu' must be numbers" >&2; return 1 ;; esac
  awk -v c="$connected" -v v="$vcpu" -v b="$BUDGET" -v h="$HEADROOM" -v m="$MIN_CONNECTED_SECONDS" 'BEGIN {
    if (c + 0 < m) { printf "FAIL: only %s connected seconds measured (need >= %d); the sample is too small to trust\n", c, m; exit 1 }
    if (v + 0 <= 0) { print "FAIL: no CPU allocation was recorded for the window"; exit 1 }
    rate = v / c * 3600
    printf "vcpu_seconds_per_connected_hour=%.0f budget=%s hours_of_shared_headroom=%.1f\n", rate, b, h / rate
    if (rate > b + 0) { printf "FAIL: %.0f vCPU-s per connected hour exceeds the budget of %s\n", rate, b; exit 1 }
  }'
}

readme_line() {
  if [ ! -f "$EVIDENCE" ]; then
    echo "Measured cost of one connected hour: to be measured after the first deploy."
    return
  fi
  jq -r '"Measured on the deployed service (\(.measured_at[0:10]), \(.connected_seconds) connected seconds): \(.vcpu_seconds_per_connected_hour) vCPU-seconds per connected hour against a budget of \(.budget), about \(.hours_of_shared_headroom) connected hours a month from the shared headroom."' "$EVIDENCE"
}

case "${1:-}" in
  --judge) judge "${2:?connected seconds}" "${3:?vcpu seconds}"; exit $? ;;
  --readme-line) readme_line; exit 0 ;;
  --update-readme)
    # Rewrites the text between the realtime-cost markers in README.md from the evidence file.
    README="${README:-$ROOT/README.md}"
    line="$(readme_line)"
    python3 - "$README" "$line" <<'PY'
import re, sys
path, line = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
new, n = re.subn(r"(<!-- realtime-cost:start -->).*?(<!-- realtime-cost:end -->)",
                 lambda m: m.group(1) + line + m.group(2), text, flags=re.S)
if n != 1:
    sys.exit("README.md must contain exactly one realtime-cost marker pair")
open(path, "w", encoding="utf-8").write(new)
PY
    exit $? ;;
  "") ;;
  *) echo "usage: $0 [--judge CONNECTED VCPU | --readme-line | --update-readme]" >&2; exit 2 ;;
esac

for need in gcloud jq curl python3; do command -v "$need" >/dev/null || { echo "FAIL: $need is required" >&2; exit 2; }; done
SMOKE_SA="clinic-smoke@${PROJECT}.iam.gserviceaccount.com"
URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" --format='value(status.url)')"
[ -n "$URL" ] || { echo "FAIL: $SERVICE does not exist yet" >&2; exit 2; }

REALTIME_URL="$URL"
REALTIME_TOKEN="$(gcloud auth print-identity-token --impersonate-service-account="$SMOKE_SA" --audiences="$SERVICE")"
SMOKE_SIGNING_KEY="$(gcloud secrets versions access latest --secret=clinic-smoke-signing-key --project="$PROJECT")"
export REALTIME_URL REALTIME_TOKEN SMOKE_SIGNING_KEY
python3 -m pip install --quiet httpx >/dev/null 2>&1 || true

run="$(python3 -I "$HERE/hold_streams.py")"
unset REALTIME_TOKEN SMOKE_SIGNING_KEY
connected="$(jq -r '.connected_seconds_total' <<<"$run")"
start="$(jq -r '.window_start' <<<"$run")"
end="$(jq -r '.window_end' <<<"$run")"
echo "held streams for ${connected}s between ${start} and ${end}"

# Cloud Monitoring needs a few minutes; ask for the window padded by the cold start and the lag.
pad_start="$(python3 -c "import sys,datetime as d;print((d.datetime.fromisoformat(sys.argv[1])-d.timedelta(minutes=2)).strftime('%Y-%m-%dT%H:%M:%SZ'))" "$start")"
vcpu=""
for attempt in $(seq 1 12); do
  pad_end="$(python3 -c "import sys,datetime as d;print((d.datetime.fromisoformat(sys.argv[1])+d.timedelta(minutes=8)).strftime('%Y-%m-%dT%H:%M:%SZ'))" "$end")"
  vcpu="$(curl -s -G "https://monitoring.googleapis.com/v3/projects/${PROJECT}/timeSeries" \
      -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "x-goog-user-project: ${PROJECT}" \
      --data-urlencode "filter=metric.type=\"run.googleapis.com/container/cpu/allocation_time\" AND resource.labels.service_name=\"${SERVICE}\"" \
      --data-urlencode "interval.startTime=${pad_start}" --data-urlencode "interval.endTime=${pad_end}" \
      --data-urlencode "aggregation.alignmentPeriod=3600s" --data-urlencode "aggregation.perSeriesAligner=ALIGN_DELTA" \
      --data-urlencode "aggregation.crossSeriesReducer=REDUCE_SUM" |
    jq -r '[.timeSeries[]?.points[]?.value.doubleValue] | add // empty')"
  # allocation_time covers the held streams only once the last sample has landed
  if [ -n "$vcpu" ] && awk -v v="$vcpu" -v c="$connected" 'BEGIN { exit !(v >= c * 0.25 * 0.9) }'; then break; fi
  echo "metric not complete yet (attempt $attempt of 12, vCPU-s so far: ${vcpu:-none}); waiting 60 s"
  sleep 60
done

verdict=pass
if ! summary="$(judge "$connected" "${vcpu:-0}")"; then verdict=fail; summary="$(judge "$connected" "${vcpu:-0}" 2>&1 || true)"; fi
echo "$summary"
rate="$(awk -v c="$connected" -v v="${vcpu:-0}" 'BEGIN { printf "%.0f", (c > 0 ? v / c * 3600 : 0) }')"
mkdir -p "$(dirname "$EVIDENCE")"
jq -n --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg verdict "$verdict" --argjson connected "$connected" \
  --argjson vcpu "${vcpu:-0}" --argjson rate "$rate" --argjson budget "$BUDGET" --argjson headroom "$HEADROOM" \
  --arg service "$SERVICE" --argjson run "$run" \
  '{measured_at: $at, service: $service, verdict: $verdict, connected_seconds: $connected, vcpu_seconds: $vcpu,
    vcpu_seconds_per_connected_hour: $rate, budget: $budget, shared_headroom_vcpu_seconds: $headroom,
    hours_of_shared_headroom: (if $rate > 0 then (($headroom / $rate * 10 | round) / 10) else null end), sessions: $run.sessions}' > "$EVIDENCE"
echo "wrote $EVIDENCE"
[ "$verdict" = pass ]
