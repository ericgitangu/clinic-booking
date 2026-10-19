#!/usr/bin/env bash
#
# The live check after promoting clinic-realtime: does the promoted revision answer /health?
#
#   URL=<service url> TOKEN=<id token, audience clinic-realtime> PROMOTE_DIR=/tmp/promoted-realtime \
#     bash scripts/ci/realtime_live_check.sh
#
# Exit 0 when the revision is healthy, 1 when it is not (the caller rolls back).
#
# The gateway runs at most two instances with one stream each (docs/adr/0021), and /health needs an
# instance like any other request. When two people have the live feed open, Cloud Run has nowhere
# to send /health and answers it itself: 429, or 500/503 "no available instance". That is a full
# service, not a broken one, so:
#
# - /health is retried with backoff (2, 4, 8, 16, 16 ... s) for up to LIVE_CHECK_SECONDS (60);
# - 200 {"status":"ok"} passes at once;
# - 401, 403 and 404 fail at once (the identity or the URL is wrong; waiting will not fix it);
# - if the last answer is still "full" when time is up, a stream-free probe decides: the Cloud Run
#   API must say the service is Ready and serves 100% of its traffic from the promoted revision,
#   and that revision is the latest ready one. That reads no instance, so a full service cannot
#   fail it, and a revision that is not ready cannot pass it;
# - anything else at the deadline (5xx without "no available instance", no answer) fails.
set -uo pipefail

: "${URL:?URL is required}"
: "${TOKEN:?TOKEN is required}"
SERVICE="${SERVICE:-clinic-realtime}"
REGION="${REGION:-us-east4}"
OUT="${PROMOTE_DIR:-/tmp/promoted-realtime}"
BUDGET="${LIVE_CHECK_SECONDS:-60}"
CURL="${CURL:-curl}"

current="$(jq -r '.current // empty' "$OUT/keep.json" 2>/dev/null)"
if [ -z "$current" ]; then
  echo "FAIL live check: $OUT/keep.json does not name the promoted revision"
  exit 1
fi

body="$(mktemp)"
trap 'rm -f "$body"' EXIT

# full | ok | fatal | other
classify() { # <http code>
  case "$1" in
    200) grep -q '"status":"ok"' "$body" && echo ok || echo other ;;
    429) echo full ;;
    500|503) grep -qi 'no available instance' "$body" && echo full || echo other ;;
    401|403|404) echo fatal ;;
    *) echo other ;;
  esac
}

waited=0
delay=2
attempt=0
last=other
while :; do
  attempt=$((attempt + 1))
  : > "$body"
  code="$("$CURL" -sS -o "$body" -w '%{http_code}' --max-time 10 \
    -H "X-Serverless-Authorization: Bearer ${TOKEN}" "${URL%/}/health" 2>/dev/null)" || true
  code="${code:-000}"
  last="$(classify "$code")"
  echo "live check $attempt: /health -> $code ($last)"
  case "$last" in
    ok) echo "PASS live check: the promoted revision answers /health"; exit 0 ;;
    fatal) echo "FAIL live check: /health -> $code; retrying cannot fix this"; exit 1 ;;
  esac
  if [ "$waited" -ge "$BUDGET" ]; then break; fi
  sleep "$delay"
  waited=$((waited + delay))
  delay=$((delay * 2 > 16 ? 16 : delay * 2))
done

if [ "$last" != full ]; then
  echo "FAIL live check: no healthy answer in ${waited} s (last: /health -> $code)"
  exit 1
fi

echo "live check: every instance is busy after ${waited} s; asking the Cloud Run API instead"
svc="$(gcloud run services describe "$SERVICE" --region "$REGION" --format=json 2>/dev/null)" || svc=""
verdict="$(jq -r --arg c "$current" '
  def ready: [.status.conditions[]? | select(.type == "Ready") | .status][0] == "True";
  def serving: [.status.traffic[]? | select((.percent // 0) == 100) | .revisionName][0] == $c;
  def latest: (.status.latestReadyRevisionName // "") == $c;
  if (ready and serving and latest) then "ready" else "not-ready" end' <<<"${svc:-null}" 2>/dev/null)"
if [ "$verdict" = ready ]; then
  echo "PASS live check: $current is Ready and serves all traffic; /health was refused only because the live feed is full"
  exit 0
fi
echo "FAIL live check: /health stayed refused and the Cloud Run API does not report $current Ready and serving"
exit 1
