#!/usr/bin/env bash
# End-to-end tests for the admin app against the real stack: the production build of the app, the
# real API and the real Postgres from docker compose. Only Google's sign-in is replaced (see
# apps/admin/e2e/support/test-auth.ts). Secrets are made fresh for each run and never written down.
#
#   DB_HOST_PORT=5433 make e2e-admin      # when 5432 is busy
#   KEEP_STACK=1 make e2e-admin           # leave the containers up afterwards
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# A project of its own, so this never touches the volumes of a dev stack.
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-clinic-e2e}"
INTERNAL_SIGNING_KEY="$(openssl rand -hex 24)"
BETTER_AUTH_SECRET="$(openssl rand -hex 24)"
export INTERNAL_SIGNING_KEY BETTER_AUTH_SECRET
export ADMIN_EMAILS="owner@clinic.example"
export E2E_API_URL="${E2E_API_URL:-http://127.0.0.1:8080}"

cleanup() {
  if [ "${KEEP_STACK:-}" != "1" ]; then docker compose down -v >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

docker compose up -d --build --wait api
pnpm -C apps/admin build
pnpm -C apps/admin test:e2e
