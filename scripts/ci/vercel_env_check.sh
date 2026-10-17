#!/usr/bin/env bash
#
# Refuse to ship a web app whose Vercel project lacks a variable it needs.
#
#   vercel_env_check.sh <booking|admin> [production]
#
# Needs VERCEL_TOKEN, VERCEL_ORG_ID and VERCEL_PROJECT_ID like the rest of the ship job. Reads only
# the variable NAMES and their target environments from the project's env API (the same
# authenticated `vercel api` path vercel_prod.sh uses); values are never kept, printed or compared. The Vercel CLI comes from PATH ($VERCEL overrides it in tests).
set -euo pipefail

cd "$(dirname "$0")/../.."
VERCEL="${VERCEL:-vercel}"
APP="${1:?usage: vercel_env_check.sh <booking|admin> [production]}"
TARGET="${2:-production}"

required="$(awk -v app="$APP" '$1 == app { print $2 }' scripts/ci/required_env.txt)"
[ -n "$required" ] || { echo "vercel_env_check: no required variables listed for '$APP'" >&2; exit 2; }

raw="$("$VERCEL" api "/v10/projects/${VERCEL_PROJECT_ID:?set VERCEL_PROJECT_ID}/env?teamId=${VERCEL_ORG_ID:?set VERCEL_ORG_ID}" --raw 2>&1)" || true

# Keep only key + target from the JSON; on anything else say what the CLI said (error text, so no
# values) and fail closed, because an unreadable list must not read as "all present".
present="$(printf '%s' "$raw" | TARGET="$TARGET" python3 -c '
import json, os, sys
text = sys.stdin.read()
try:
    data = json.loads("{" + text.split("{", 1)[1].rsplit("}", 1)[0] + "}")
    envs = data["envs"]
except Exception:
    reason = " ".join(text.split())[:240] or "empty response"
    sys.stderr.write("vercel_env_check: could not read the project variables: " + reason + "\n")
    sys.exit(3)
hidden = int(data.get("hiddenProductionEnvCount") or 0)
if os.environ["TARGET"] == "production" and hidden:
    sys.stderr.write("vercel_env_check: %d production variables are hidden from this token, so the list cannot be verified\n" % hidden)
    sys.exit(4)
target = os.environ["TARGET"]
for e in envs:
    t = e.get("target") or []
    t = [t] if isinstance(t, str) else t
    if target in t:
        print(e["key"])
')" || { echo "vercel_env_check: FAIL, cannot verify the $TARGET variables for $APP; nothing was promoted." >&2; exit 1; }

missing=""
for name in $required; do
  grep -qx "$name" <<<"$present" || missing="$missing $name"
done

if [ -n "$missing" ]; then
  echo "vercel_env_check: FAIL, $APP has no $TARGET value for:${missing}. Add them in the Vercel project before shipping; nothing was promoted." >&2
  exit 1
fi
echo "vercel_env_check: $APP has every required $TARGET variable ($(wc -w <<<"$required" | tr -d ' ') checked)"
