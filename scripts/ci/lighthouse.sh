#!/usr/bin/env bash
#
# Lighthouse CI over the booking app's production build (docs/adr/0026). Serves `next start` on its
# own port against the API already running, then runs @lhci/cli (exact version in
# scripts/ci/lighthouse/package.json and its lockfile, released 2025-06-25) with the budgets in scripts/ci/lighthouserc.cjs. Zero cost: it runs inside the
# e2e-real job's machine, after the build and the Playwright scenarios, and calls no public URL.
#
# Runs on every push to main. On other branches it is skipped unless apps/, packages/ui/ or the
# Lighthouse files changed relative to main (fails open: any git problem runs it).
#
# Needs: apps/booking already built (pnpm -C apps/booking build), the API at $E2E_API_URL, and a
# Chrome: $LH_CHROME_PATH, else the Chromium Playwright installed.
# Output: $LHCI_OUTPUT_DIR (default /tmp/lighthouse) holds one HTML and one JSON report per run,
# and is the only directory CI stores. lhci's raw runs stay in scripts/ci/lighthouse/.lighthouseci,
# which is git-ignored and never uploaded, so every report exists once.
set -euo pipefail
cd "$(dirname "$0")/../.."

LH_DIR=scripts/ci/lighthouse   # holds the exact @lhci/cli version and its lockfile
LH_WATCH="apps/ packages/ui/ scripts/ci/lighthouse scripts/ci/lighthouserc.cjs"
if [ "${CIRCLE_BRANCH:-main}" != main ]; then
  git fetch origin main --quiet 2>/dev/null || true
  if base="$(git merge-base origin/main HEAD 2>/dev/null)" \
     && changed="$(git diff --name-only "$base" HEAD -- $LH_WATCH 2>/dev/null)" \
     && [ -z "$changed" ]; then
    echo "no changes under: $LH_WATCH; skipping Lighthouse"
    exit 0
  fi
fi
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
# LH_SERVER_CMD and LH_RUN_CMD exist so scripts/ci/test_ci_scripts.sh can drive this script with a
# fake server and a fake runner; in CI both are unset.
(
  cd apps/booking
  export API_URL="${E2E_API_URL:-http://127.0.0.1:8080}" E2E=1 RECAPTCHA_ENFORCE=false \
    INTERNAL_SIGNING_KEY="${INTERNAL_SIGNING_KEY:-}" BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-}" \
    BETTER_AUTH_URL="$LHCI_BASE_URL" GOOGLE_CLIENT_ID=lh-google-client-id GOOGLE_CLIENT_SECRET=lh-google-client-secret
  # shellcheck disable=SC2086 # LH_SERVER_CMD is a command line on purpose
  if [ -n "${LH_SERVER_CMD:-}" ]; then exec $LH_SERVER_CMD; fi
  exec pnpm exec next start -p "$PORT"
) > "$LOG" 2>&1 &
SERVER=$!
echo "$SERVER" > "$LOG.pid"

# `pnpm exec next start` is a tree (pnpm, next, the server): take the children first, then the
# recorded PID, so nothing else on the machine is touched.
kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}
trap 'kill_tree "$(cat "$LOG.pid" 2>/dev/null || echo "$SERVER")"; wait "$SERVER" 2>/dev/null || true; rm -f "$LOG.pid"' EXIT

for _ in $(seq 1 30); do
  curl -sf -o /dev/null "$LHCI_BASE_URL/about" && break
  kill -0 "$SERVER" 2>/dev/null || { echo "next start exited:"; cat "$LOG"; exit 1; }
  sleep 2
done
curl -sf -o /dev/null "$LHCI_BASE_URL/about" || { echo "next start never answered:"; cat "$LOG"; exit 1; }

rc=0
if [ -n "${LH_RUN_CMD:-}" ]; then
  bash -c "$LH_RUN_CMD" || rc=$?
else
  rm -rf "$LH_DIR/.lighthouseci"
  pnpm --dir "$LH_DIR" install --frozen-lockfile --ignore-scripts
  pnpm --dir "$LH_DIR" exec lhci autorun --config="$ROOT/scripts/ci/lighthouserc.cjs" || rc=$?
  node "$LH_DIR/summary.mjs" "$LHCI_OUTPUT_DIR" || true
fi
exit "$rc"
