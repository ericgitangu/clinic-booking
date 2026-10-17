#!/usr/bin/env bash
#
# Refuse to ship a web app whose Vercel project lacks a variable it needs.
#
#   vercel_env_check.sh <booking|admin> [production]
#
# Needs VERCEL_TOKEN, VERCEL_ORG_ID and VERCEL_PROJECT_ID like the rest of the ship job. Reads only
# the variable NAMES and the environment column from `vercel env ls`; the value column is never
# kept, printed or compared. The Vercel CLI comes from PATH ($VERCEL overrides it in tests).
set -euo pipefail

cd "$(dirname "$0")/../.."
VERCEL="${VERCEL:-vercel}"
APP="${1:?usage: vercel_env_check.sh <booking|admin> [production]}"
TARGET="${2:-production}"

required="$(awk -v app="$APP" '$1 == app { print $2 }' scripts/ci/required_env.txt)"
[ -n "$required" ] || { echo "vercel_env_check: no required variables listed for '$APP'" >&2; exit 2; }

listing="$("$VERCEL" env ls "$TARGET" 2>&1)" || {
  echo "vercel_env_check: could not list the $TARGET variables for $APP (the Vercel token may lack access to this project)" >&2
  exit 1
}

# Table rows only: " NAME  value  type  environments  created". Keep the name and, as a flag, whether
# the row covers the target; throw the rest away before anything is stored.
present="$(printf '%s\n' "$listing" | awk -v t="$TARGET" '
  $1 ~ /^[A-Za-z_][A-Za-z0-9_]*$/ && $1 != "name" {
    line = tolower($0)
    if (index(line, tolower(t)) || index(line, "all environments")) print $1
  }')"

missing=""
for name in $required; do
  grep -qx "$name" <<<"$present" || missing="$missing $name"
done

if [ -n "$missing" ]; then
  echo "vercel_env_check: FAIL, $APP has no $TARGET value for:${missing}. Add them in the Vercel project before shipping; nothing was promoted." >&2
  exit 1
fi
echo "vercel_env_check: $APP has every required $TARGET variable ($(wc -w <<<"$required" | tr -d ' ') checked)"
