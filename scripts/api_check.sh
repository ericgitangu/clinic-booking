#!/usr/bin/env bash
#
# Runs the reviewer collection (docs/api/) with newman.
#
#   bash scripts/api_check.sh local        its own compose stack, the whole journey, then down -v
#   bash scripts/api_check.sh production   the read-only requests against the public /api proxy
#
# Local: brings up a separate compose project (own ports and volume, so a running `make up` stack
# is never touched) with a second API whose lead time is 100 days (scripts/api_check.compose.yml,
# for folder 08), runs every folder and removes the stack. KEEP_STACK=1 leaves it up and prints
# the values to paste into Postman.
#
# Production: GET requests only. API_WRITES=1 also runs the booking writes against the live
# database, which keeps what they make: two patients and one cancelled appointment. Nothing else
# turns them on.
#
# Only Docker is needed: newman runs from its published image, pinned by digest.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
TARGET="${1:-local}"
# The one place the newman image is pinned (tag and digest). Image pins live beside the code that
# runs them, as with the ZAP digest in scripts/ci/zap_prod_baseline.sh; scripts/ci/test_ci_scripts.sh
# checks the pin's form and that no other file names a newman image. 6.1.3 is the newest published
# image; the collection also passes on newman 6.2.3.
NEWMAN_IMAGE="postman/newman:6.1.3-alpine@sha256:d9b5e780ead0026bbb37f3759cd7b10fc8a88cd4030c8266a7c5e343d75a5198"
# JUnit output. CI points REPORT_DIR at the directory it stores as test results; otherwise it is a
# temporary directory removed on exit.
CLEANUP=()
cleanup() { local c; for c in "${CLEANUP[@]}"; do eval "$c" || true; done; }
trap cleanup EXIT
if [ -z "${REPORT_DIR:-}" ]; then
  REPORT_DIR="$(mktemp -d)"
  CLEANUP+=("rm -rf '$REPORT_DIR'")
fi
mkdir -p "$REPORT_DIR"

node_check() { # the committed collection must match a fresh build from the contract
  docker run --rm -v "$ROOT:/repo:ro" -w /repo --entrypoint node "$NEWMAN_IMAGE" scripts/api_collection.mjs --check
}

newman() { # newman <docker network> <newman args...>
  local net="$1"; shift
  docker run --rm --network "$net" -v "$ROOT/docs/api:/etc/newman:ro" -v "$REPORT_DIR:/reports" "$NEWMAN_IMAGE" \
    run clinic-booking.postman_collection.json --color auto --reporters cli,junit \
    --reporter-junit-export "/reports/newman-$RUN_NAME.xml" "$@"
}

case "$TARGET" in
  local)
    PROJECT="${API_CHECK_PROJECT:-clinic-apicheck}"
    RUN_NAME="$PROJECT"
    # Host ports: API_CHECK_API_PORT, API_CHECK_DB_PORT and API_CHECK_LONG_LEAD_PORT when set,
    # otherwise the first free port from 18180, 15532 and 18181 (stepping by 10), so two runs on
    # one machine, or another stack on the defaults, do not collide.
    in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
    free_port() { local p="$1"; while in_use "$p"; do p=$((p + 10)); done; echo "$p"; }
    export API_HOST_PORT="${API_CHECK_API_PORT:-$(free_port 18180)}"
    export DB_HOST_PORT="${API_CHECK_DB_PORT:-$(free_port 15532)}"
    export API_CHECK_LONG_LEAD_PORT="${API_CHECK_LONG_LEAD_PORT:-$(free_port $((API_HOST_PORT + 1)))}"
    compose() { docker compose -p "$PROJECT" -f docker-compose.yml -f scripts/api_check.compose.yml "$@"; }
    if [ "${KEEP_STACK:-0}" != 1 ]; then CLEANUP+=("compose down -v >/dev/null 2>&1"); fi
    node_check
    # Docker gives each compose network a subnet from a fixed set of pools (about 30 by default).
    # When other stacks on this machine hold them all, `up` fails with a message that does not say
    # why, so check first and name the cause.
    if ! docker network inspect "${PROJECT}_default" >/dev/null 2>&1; then
      if ! docker network create "${PROJECT}_probe" >/dev/null 2>&1; then
        echo "Docker has no free network address space: $(docker network ls -q | wc -l | tr -d ' ') networks exist." >&2
        echo "Free some: 'docker network prune' removes networks no container uses; 'docker compose -p <name> down -v' removes a stack you no longer need. Then run this again." >&2
        exit 1
      fi
      docker network rm "${PROJECT}_probe" >/dev/null
    fi
    compose up -d --build --wait
    out="$(mktemp)"; CLEANUP+=("rm -f '$out'")
    newman "${PROJECT}_default" -e local.postman_environment.json \
      --env-var baseUrl=http://api:8080 --env-var writeBaseUrl=http://api:8080 \
      --env-var longLeadBaseUrl=http://api-long-lead:8080 | tee "$out"
    # Locally every request must run: a skip means an earlier step failed to set what it needed,
    # and newman alone would still report the run as passed.
    if grep -q "skipped (" "$out"; then
      echo "api-check: requests were skipped in a local run:" >&2
      grep "skipped (" "$out" >&2
      exit 1
    fi
    if [ "${KEEP_STACK:-0}" = 1 ]; then
      cat <<EOF

The stack is still up (project $PROJECT). To send requests from Postman against it, set these in
the local environment (the defaults point at the \`make up\` stack on port 8080 instead):
  baseUrl          http://localhost:$API_HOST_PORT
  writeBaseUrl     http://localhost:$API_HOST_PORT
  longLeadBaseUrl  http://localhost:$API_CHECK_LONG_LEAD_PORT   (folder 08: the API with a 100-day lead)
Remove the stack with: docker compose -p $PROJECT -f docker-compose.yml -f scripts/api_check.compose.yml down -v
EOF
    fi
    ;;
  production)
    RUN_NAME=production
    node_check
    args=(-e production.postman_environment.json)
    if [ "${API_WRITES:-0}" = 1 ]; then
      echo "API_WRITES=1: the booking writes run against production and leave two patients and a cancelled appointment there"
      args+=(--env-var "writeBaseUrl=$(jq -r '.values[] | select(.key == "baseUrl") | .value' docs/api/production.postman_environment.json)")
    fi
    newman bridge "${args[@]}"
    ;;
  *)
    echo "usage: $0 local|production" >&2
    exit 2
    ;;
esac
