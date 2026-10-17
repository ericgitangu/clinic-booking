#!/usr/bin/env bash
#
# Production-alias helpers for the web app. Needs VERCEL_TOKEN, VERCEL_ORG_ID (the team id) and
# scripts/ci/public-urls.env; the Vercel CLI comes from PATH ($VERCEL overrides it in tests).
#
#   vercel_prod.sh id-of <host-or-url>   print the deployment id behind a host
#   vercel_prod.sh current               print the id of the deployment serving $WEB right now
#   vercel_prod.sh previous              print the newest READY production deployment that is not the
#                                        current one (empty when there is none)
#   vercel_prod.sh ensure <id>           make $WEB serve <id>: promote it if it does not, then fail
#                                        unless it does (a rollback switches off auto-assignment,
#                                        so a later deploy can land without taking the alias)
#   vercel_prod.sh rollback <id>         point production at <id> explicitly, then check it took
set -euo pipefail

cd "$(dirname "$0")/../.."
VERCEL="${VERCEL:-vercel}"
. scripts/ci/public-urls.env
HOST="${WEB#https://}"

id_of() {
  local host="${1#https://}"; host="${host%%/*}"
  "$VERCEL" api "/v13/deployments/${host}?teamId=${VERCEL_ORG_ID:?set VERCEL_ORG_ID}" --raw |
    python3 -c 'import sys,json; t=sys.stdin.read(); print(json.loads(t[t.index("{"):])["id"])'
}

case "${1:-}" in
  id-of)    id_of "${2:?usage: id-of <host-or-url>}" ;;
  current)  id_of "$HOST" ;;
  previous)
    now="$(id_of "$HOST")"
    "$VERCEL" api "/v6/deployments?projectId=${VERCEL_PROJECT_ID:?set VERCEL_PROJECT_ID}&teamId=${VERCEL_ORG_ID:?}&target=production&state=READY&limit=10" --raw |
      NOW="$now" python3 -c 'import os,sys,json; t=sys.stdin.read(); d=json.loads(t[t.index("{"):]); ids=[x["uid"] for x in d.get("deployments",[]) if x["uid"]!=os.environ["NOW"]]; print(ids[0] if ids else "")' ;;
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
