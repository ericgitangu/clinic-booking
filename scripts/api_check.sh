#!/usr/bin/env bash
#
# Runs the reviewer collection (docs/api/) with newman.
#
#   bash scripts/api_check.sh local        its own compose stack, the whole journey, then down -v
#   bash scripts/api_check.sh production   the read-only requests against the public /api proxy
#
# Local: brings up a separate compose project (own ports and volume, so a running `make up` stack
# is never touched), writes one appointment starting within the hour straight into the database
# (the API never books one that close, and 08 Change within the hour needs it), runs every folder
# and removes the stack. KEEP_STACK=1 leaves it up for a look in Postman.
#
# Production: GET requests only. API_WRITES=1 also runs the booking writes (a patient, a booking
# that is then cancelled) against the live database; nothing else turns them on.
#
# Only Docker is needed: newman runs from its published image, pinned by digest.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
TARGET="${1:-local}"
NEWMAN_IMAGE="postman/newman:6.1.3-alpine@sha256:d9b5e780ead0026bbb37f3759cd7b10fc8a88cd4030c8266a7c5e343d75a5198"
# JUnit output; CI points this at the directory it stores as test results.
REPORT_DIR="${REPORT_DIR:-$(mktemp -d)}"
mkdir -p "$REPORT_DIR"

node_check() { # the committed collection must match a fresh build from the contract
  docker run --rm -v "$ROOT:/repo:ro" -w /repo --entrypoint node "$NEWMAN_IMAGE" scripts/api_collection.mjs --check
}

newman() { # newman <docker network> <newman args...>
  local net="$1"; shift
  docker run --rm --network "$net" -v "$ROOT/docs/api:/etc/newman" -v "$REPORT_DIR:/reports" "$NEWMAN_IMAGE" \
    run clinic-booking.postman_collection.json --color auto --reporters cli,junit \
    --reporter-junit-export "/reports/newman-$TARGET.xml" "$@"
}

case "$TARGET" in
  local)
    PROJECT="${API_CHECK_PROJECT:-clinic-apicheck}"
    export API_HOST_PORT="${API_CHECK_API_PORT:-18180}" DB_HOST_PORT="${API_CHECK_DB_PORT:-15532}"
    compose() { docker compose -p "$PROJECT" "$@"; }
    if [ "${KEEP_STACK:-0}" != 1 ]; then trap 'compose down -v >/dev/null 2>&1 || true' EXIT; fi
    node_check
    compose up -d --build --wait
    # An appointment 5 to 35 minutes from now, on the 30-minute grid the table's check constraint
    # demands, or one left by an earlier run of a kept stack (KEEP_STACK=1). It may fall outside
    # working hours: the database does not know the hours, and the API refuses the change first.
    SOON_ID="$(compose exec -T db psql -U clinic -d clinic -v ON_ERROR_STOP=1 -qAt <<'SQL'
WITH earlier AS (
  SELECT id FROM appointments
   WHERE status = 'booked' AND starts_at BETWEEN now() + interval '3 minutes' AND now() + interval '55 minutes'
   ORDER BY starts_at DESC LIMIT 1),
     t AS (SELECT to_timestamp(ceil(extract(epoch FROM now() + interval '5 minutes') / 1800) * 1800) AS s),
     d AS (SELECT doctors.id FROM doctors, t
            WHERE NOT EXISTS (SELECT 1 FROM earlier)
              AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.doctor_id = doctors.id AND a.starts_at = t.s AND a.status = 'booked')
            ORDER BY full_name LIMIT 1),
     p AS (INSERT INTO patients (full_name) SELECT 'Starts within the hour' FROM d RETURNING id),
     made AS (INSERT INTO appointments (doctor_id, patient_id, starts_at, ends_at)
              SELECT d.id, p.id, t.s, t.s + interval '30 minutes' FROM d, p, t RETURNING id)
SELECT id FROM earlier UNION ALL SELECT id FROM made;
SQL
)"
    echo "soonAppointmentId=$SOON_ID (paste into the local environment to run folder 08 from Postman)"
    newman "${PROJECT}_default" -e local.postman_environment.json \
      --env-var baseUrl=http://api:8080 --env-var "soonAppointmentId=$SOON_ID"
    ;;
  production)
    node_check
    args=(-e production.postman_environment.json)
    if [ "${API_WRITES:-0}" = 1 ]; then
      echo "API_WRITES=1: the booking writes run against production"
      args+=(--env-var allowWrites=true)
    fi
    newman bridge "${args[@]}"
    ;;
  *)
    echo "usage: $0 local|production" >&2
    exit 2
    ;;
esac
