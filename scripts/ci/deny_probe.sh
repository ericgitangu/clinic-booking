#!/usr/bin/env bash
#
# IAM deny-proof probes (the rule is "proof required"; the IAM-only front door is /decisions#hosting-and-cost). Each mode attempts something that
# MUST be refused and writes a redacted evidence record that CI stores as an artifact.
#
#   run-app  anonymous and junk-bearer requests to the direct run.app URL: 403 and 401 expected.
#            No credential of any kind. Runs in smoke-public after a release.
#   wif      the STS token exchange from a job on the empty oidc-probe context: refused expected.
#            Runs only on the test/wif-deny branch (workflow wif-deny).
#   context  the gcp-deploy and vercel-prod variables must be ABSENT in this job.
#
# Usage: deny_probe.sh <mode> <output file>
# Env (tests/dry runs only): PROBE_RUN_APP_URL, PROBE_STS_URL override the real endpoints.
#
# Redaction: the record holds the mode, a UTC time, the commit, expected/observed HTTP codes and
# the error code from the response. Tokens are never written; any long opaque string in a quoted
# response is replaced by [redacted], as is any number of 10+ digits (a project number).
# Exit 0 when every probe was refused as expected, 1 otherwise, 2 for bad usage.
set -uo pipefail
cd "$(dirname "$0")/../.."

mode="${1:-}"; out="${2:-}"
case "$mode" in run-app|wif|context) ;; *) echo "usage: $0 run-app|wif|context <output file>" >&2; exit 2 ;; esac
[ -n "$out" ] || { echo "usage: $0 $mode <output file>" >&2; exit 2; }
mkdir -p "$(dirname "$out")"

FAILS=0
redact() { sed -E 's/[A-Za-z0-9_.-]{24,}/[redacted]/g; s/[0-9]{10,}/[redacted]/g' | tr -d '\r' | cut -c1-200; }
emit() { printf '%s\n' "$*" | tee -a "$out"; }
verdict() { # <probe> <expected> <observed> [detail]
  local v=PASS
  [ "$2" = "$3" ] || { v=FAIL; FAILS=$((FAILS + 1)); }
  emit "probe=$1 expected=$2 observed=$3 result=$v${4:+ detail=$4}"
}

: > "$out"
emit "# deny-proof probe record (redacted)"
emit "mode=$mode"
emit "time_utc=$(date -u +%FT%TZ)"
emit "commit=${CIRCLE_SHA1:-unknown}"
emit "pipeline=${CIRCLE_BUILD_URL:-local}"

case "$mode" in
  run-app)
    . scripts/ci/public-urls.env
    url="${PROBE_RUN_APP_URL:-$RUN_APP_URL}"
    emit "target=direct run.app URL (no front door)"
    c1="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$url/ready")"
    verdict run-app-anonymous 403 "$c1"
    c2="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -H 'X-Serverless-Authorization: Bearer junk' "$url/ready")"
    verdict run-app-junk-bearer 401 "$c2"
    ;;
  wif)
    sts="${PROBE_STS_URL:-https://sts.googleapis.com/v1/token}"
    : "${CIRCLE_OIDC_TOKEN_V2:?no OIDC token in this job}"
    . scripts/ci/wif-probe.env
    body="$(mktemp)"; trap 'rm -f "$body"' EXIT
    aud="//iam.googleapis.com/projects/${WIF_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}/providers/${WIF_PROVIDER}"
    code="$(curl -s -o "$body" -w '%{http_code}' --max-time 20 -X POST "$sts" \
      --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
      --data-urlencode "audience=$aud" \
      --data-urlencode "requested_token_type=urn:ietf:params:oauth:token-type:access_token" \
      --data-urlencode "subject_token_type=urn:ietf:params:oauth:token-type:jwt" \
      --data-urlencode "scope=https://www.googleapis.com/auth/cloud-platform" \
      --data-urlencode "subject_token=$CIRCLE_OIDC_TOKEN_V2")"
    if jq -e 'has("access_token")' "$body" >/dev/null 2>&1; then
      emit "probe=wif-exchange-on-oidc-probe-context expected=denied observed=ISSUED result=FAIL"
      FAILS=$((FAILS + 1))
    else
      err="$(jq -r '[.error // empty, .error_description // empty] | join(": ")' "$body" 2>/dev/null | redact)"
      case "$code" in
        400|401|403) verdict wif-exchange-on-oidc-probe-context denied denied "http=$code ${err:+error=\"$err\"}" ;;
        *) verdict wif-exchange-on-oidc-probe-context denied "inconclusive-http-$code" ;;
      esac
    fi
    ;;
  context)
    for v in GOOGLE_PROJECT_ID GOOGLE_PROJECT_NUMBER DEPLOYER_SA PUBLIC_BASE_URL VERCEL_TOKEN VERCEL_ORG_ID VERCEL_PROJECT_ID; do
      if [ -z "${!v:-}" ]; then verdict "context-var-$v" absent absent; else verdict "context-var-$v" absent present; fi
    done
    ;;
esac

emit "summary=$([ "$FAILS" -eq 0 ] && echo all-refused || echo "$FAILS-not-refused")"
[ "$FAILS" -eq 0 ]
