#!/usr/bin/env bash
#
# The admin scenarios run in CI with `--no-deps`, so one failed project cannot hide the ones after
# it. The order of the projects (the dashboard figures one changes are read by the next) is then
# whatever Playwright schedules, not what the `dependencies` chain says. This fails the job if
# the order `playwright test --no-deps --list` reports differs from the order the config declares.
#
# Usage: check_project_order.sh [list.json]
#   With a file, it reads that `--reporter=json` listing; without one it runs the listing in
#   apps/admin. Exit 0 only if the two orders are identical.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$#" -ge 1 ]; then
  listing="$1"
else
  listing="$(mktemp)"
  trap 'rm -f "$listing"' EXIT
  # The config imports the stack settings at load; a listing needs their names set, not their values.
  export E2E_API_URL="${E2E_API_URL:-http://127.0.0.1:8080}"
  export INTERNAL_SIGNING_KEY="${INTERNAL_SIGNING_KEY:-listing-only}"
  export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-listing-only}"
  export ADMIN_EMAILS="${ADMIN_EMAILS:-listing-only@clinic.example}"
  (cd "$HERE/../../apps/admin" && pnpm exec playwright test --no-deps --list --reporter=json) > "$listing"
fi

if [ "$(jq '.errors | length' "$listing")" != "0" ]; then
  echo "playwright could not list the tests:" >&2
  jq -r '.errors[].message' "$listing" | sort -u >&2
  exit 1
fi

declared="$(jq -r '.config.projects | map(.name) | join(" ")' "$listing")"
# first appearance of each project among the listed tests, in the order they are listed
listed="$(jq -r '[.. | objects | select(has("projectName")) | .projectName]
  | reduce .[] as $p ([]; if index($p) then . else . + [$p] end) | join(" ")' "$listing")"

if [ -z "$listed" ]; then
  echo "the listing has no tests" >&2
  exit 1
fi
if [ "$declared" != "$listed" ]; then
  echo "project order under --no-deps differs from the config:" >&2
  echo "  config: $declared" >&2
  echo "  listed: $listed" >&2
  exit 1
fi
echo "project order matches the config: $listed"
