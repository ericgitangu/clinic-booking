#!/usr/bin/env bash
#
# Lighthouse CI over the booking app's production build (docs/adr/0026). Serves `next start` on its
# own port against the API already running, then runs @lhci/cli (exact version below, released
# 2025-06-25) with the budgets in scripts/ci/lighthouserc.cjs. Zero cost: it runs inside the
# e2e-real job's machine, after the build and the Playwright scenarios, and calls no public URL.
#
# Needs: apps/booking already built (pnpm -C apps/booking build), the API at $E2E_API_URL, and a
# Chrome: $LH_CHROME_PATH, else the Chromium Playwright installed.
# Output: $LHCI_OUTPUT_DIR (default /tmp/lighthouse) holds one HTML and one JSON report per run.
# lhci keeps its raw runs in ./.lighthouseci of the working directory, so it runs from the output
# directory and the repository stays clean.
set -euo pipefail
cd "$(dirname "$0")/../.."

LHCI_VERSION=0.15.1
PORT="${LH_PORT:-3101}"
export LHCI_BASE_URL="http://localhost:${PORT}"
ROOT="$PWD"
export LHCI_OUTPUT_DIR="${LHCI_OUTPUT_DIR:-/tmp/lighthouse}"
rm -rf "$LHCI_OUTPUT_DIR"; mkdir -p "$LHCI_OUTPUT_DIR"

if [ -n "${LH_CHROME_PATH:-}" ]; then
  export CHROME_PATH="$LH_CHROME_PATH"
else
  CHROME_PATH="$(cd apps/booking && node -p "require('@playwright/test').chromium.executablePath()")"
  export CHROME_PATH
fi
[ -x "$CHROME_PATH" ] || { echo "no Chrome at $CHROME_PATH"; exit 1; }

LOG="$(mktemp)"
(
  cd apps/booking
  API_URL="${E2E_API_URL:-http://127.0.0.1:8080}" E2E=1 RECAPTCHA_ENFORCE=false \
    INTERNAL_SIGNING_KEY="${INTERNAL_SIGNING_KEY:-}" BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-}" \
    BETTER_AUTH_URL="$LHCI_BASE_URL" GOOGLE_CLIENT_ID=lh-google-client-id GOOGLE_CLIENT_SECRET=lh-google-client-secret \
    exec pnpm exec next start -p "$PORT"
) > "$LOG" 2>&1 &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null || true; wait "$SERVER" 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  curl -sf -o /dev/null "$LHCI_BASE_URL/about" && break
  kill -0 "$SERVER" 2>/dev/null || { echo "next start exited:"; cat "$LOG"; exit 1; }
  sleep 2
done
curl -sf -o /dev/null "$LHCI_BASE_URL/about" || { echo "next start never answered:"; cat "$LOG"; exit 1; }

cd "$LHCI_OUTPUT_DIR"
pnpm dlx "@lhci/cli@${LHCI_VERSION}" autorun --config="$ROOT/scripts/ci/lighthouserc.cjs"
