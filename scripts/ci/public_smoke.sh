#!/usr/bin/env bash
#
# The public smoke: what a reviewer's browser or curl sees, with no GCP or Vercel credential.
# Used by smoke-public (the last gate) and by verify-release (which rolls back when this fails).
set -euo pipefail
cd "$(dirname "$0")/../.."

. scripts/ci/public-urls.env
case "$WEB$ADMIN$RUN_APP_URL" in *REPLACE_BEFORE_FIRST_PUSH*) echo "scripts/ci/public-urls.env still has placeholders"; exit 1 ;; esac
PUBLIC_API="${WEB}/api"

code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }
test "$(code "${PUBLIC_API}/health")" = 200
test "$(code "${PUBLIC_API}/ready")" = 200     # runs SELECT 1 against Neon through the whole path
curl -fsS --max-time 20 "${WEB}/openapi.json" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['servers'][0]['url']=='/api'"
curl -fsS --max-time 20 -o /dev/null "${WEB}/docs"
test "$(code "${PUBLIC_API}/openapi.json")" = 308
test "$(code "${RUN_APP_URL}/health")" = 403   # direct run.app stays an IAM denial
test "$(code -L "${ADMIN}")" = 200         # the admin app serves its sign-in gate
# Read-only: this step has no signing key, so a booking flow here would add ordinary patients to the
# live admin views on every run (and every retry). The signed flow runs on the tag URL before promotion.
python3 scripts/verify_claims.py --base-url "$PUBLIC_API" --read-only
