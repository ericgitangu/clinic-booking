#!/usr/bin/env bash
#
# Production-alias helpers for one web app: VERCEL_APP=booking (default) or admin picks the host. Needs VERCEL_TOKEN, VERCEL_ORG_ID (the team id) and
# scripts/ci/public-urls.env; the Vercel CLI comes from PATH ($VERCEL overrides it in tests).
#
#   vercel_prod.sh id-of <host-or-url>   print the deployment id behind a host
#   vercel_prod.sh current               print the id of the deployment serving the app host right now
#   vercel_prod.sh previous              print the newest READY production deployment that is not the
#                                        current one (empty when there is none)
#   vercel_prod.sh ensure <id>           make the app host serve <id>: promote it if it does not, then fail
#                                        unless it does (a rollback switches off auto-assignment,
#                                        so a later deploy can land without taking the alias)
#   vercel_prod.sh rollback <id>         point production at <id> explicitly, then check it took
set -euo pipefail

cd "$(dirname "$0")/../.."
VERCEL="${VERCEL:-vercel}"
. scripts/ci/public-urls.env
case "${VERCEL_APP:-booking}" in
  booking) HOST="${WEB#https://}" ;;
  admin)   HOST="${ADMIN#https://}" ;;
  *) echo "vercel_prod: VERCEL_APP must be booking or admin" >&2; exit 2 ;;
esac

# Run a Vercel API call and print its JSON body. The CLI prints a telemetry notice before the body
# and an error as plain text, so the JSON is cut out by position; when there is none, say what the
# CLI said instead of failing inside the parser.
vercel_json() {
  local out
  out="$("$VERCEL" api "$1" --raw 2>&1)" || true
  case "$out" in
    *"Not authorized"*)
      echo "vercel_prod: the Vercel token was refused (403) for $1. It needs access to this team and to the project behind the host; see https://clinic.ericgitangu.com/decisions#rollback." >&2
      return 1 ;;
    *"{"*) printf '{%s' "${out#*\{}" ;;
    *)
      echo "vercel_prod: no JSON from the Vercel API for $1: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-240)" >&2
      return 1 ;;
  esac
}

id_of() {
  local host body
  host="${1#https://}"; host="${host%%/*}"
  body="$(vercel_json "/v13/deployments/${host}?teamId=${VERCEL_ORG_ID:?set VERCEL_ORG_ID}")" || return 1
  printf '%s' "$body" | python3 -c 'import sys,json
try:
    print(json.load(sys.stdin)["id"])
except Exception as e:
    sys.exit("vercel_prod: no deployment id in the response for this host (%s)" % type(e).__name__)'
}

case "${1:-}" in
  id-of)    id_of "${2:?usage: id-of <host-or-url>}" ;;
  current)  id_of "$HOST" ;;
  previous)
    now="$(id_of "$HOST")"
    body="$(vercel_json "/v6/deployments?projectId=${VERCEL_PROJECT_ID:?set VERCEL_PROJECT_ID}&teamId=${VERCEL_ORG_ID:?}&target=production&state=READY&limit=10")" || exit 1
    printf '%s' "$body" | NOW="$now" python3 -c 'import os,sys,json
try:
    d=json.load(sys.stdin)
except Exception as e:
    sys.exit("vercel_prod: the deployments list was not JSON (%s)" % type(e).__name__)
ids=[x["uid"] for x in d.get("deployments",[]) if x["uid"]!=os.environ["NOW"]]
print(ids[0] if ids else "")' ;;
  ensure)
    want="${2:?usage: ensure <deployment-id>}"
    have="$(id_of "$HOST")"
    if [ "$have" != "$want" ]; then
      echo "vercel_prod: $HOST serves $have, not $want; promoting $want" >&2
      "$VERCEL" promote "$want" --yes >&2
      have="$(id_of "$HOST")"
    fi
    [ "$have" = "$want" ] || { echo "vercel_prod: FAIL, $HOST serves $have, expected $want" >&2; exit 1; }
    echo "$have"
    ;;
  rollback)
    want="${2-}"
    [ -n "$want" ] || { echo "vercel_prod: no previous deployment recorded; refusing to guess" >&2; exit 2; }
    "$VERCEL" rollback "$want" --yes >&2
    have="$(id_of "$HOST")"
    [ "$have" = "$want" ] || { echo "vercel_prod: FAIL, $HOST serves $have after the rollback, expected $want" >&2; exit 1; }
    echo "$have"
    ;;
  *) echo "usage: $0 id-of <host> | current | previous | ensure <id> | rollback <id>" >&2; exit 2 ;;
esac
