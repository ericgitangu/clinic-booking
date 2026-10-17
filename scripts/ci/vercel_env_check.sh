#!/usr/bin/env bash
#
# Refuse to ship a web app whose Vercel project lacks a variable it needs.
#
#   vercel_env_check.sh <booking|admin> [production]
#
# Needs VERCEL_TOKEN, VERCEL_ORG_ID and VERCEL_PROJECT_ID like the rest of the ship job. Reads only
# the variable NAMES and their target environments from the project's env API (the same
# authenticated `vercel api` path vercel_prod.sh uses); values are never kept, printed or compared. The Vercel CLI comes from PATH ($VERCEL overrides it in tests).
# A non-zero CLI exit always means "cannot verify", even if the body parses.
set -euo pipefail

cd "$(dirname "$0")/../.."
VERCEL="${VERCEL:-vercel}"
APP="${1:?usage: vercel_env_check.sh <booking|admin> [production]}"
TARGET="${2:-production}"

required="$(awk -v app="$APP" '$1 == app { print $2 }' scripts/ci/required_env.txt)"
[ -n "$required" ] || { echo "vercel_env_check: no required variables listed for '$APP'" >&2; exit 2; }

: "${VERCEL_PROJECT_ID:?set VERCEL_PROJECT_ID}"
: "${VERCEL_ORG_ID:?set VERCEL_ORG_ID}"

present="$(VERCEL="$VERCEL" TARGET="$TARGET" python3 - <<'PY'
import json, os, re, subprocess, sys

# Fail closed with a reason that can never carry a value: only a parsed error.code / error.message,
# a short letters-and-spaces CLI error line, or the size of what came back.
def fail(code, why):
    sys.stderr.write("vercel_env_check: could not read the project variables: " + why + "\n")
    sys.exit(code)

def explain(rc, text):
    body = text[text.find("{"):text.rfind("}") + 1] if "{" in text else ""
    try:
        err = json.loads(body).get("error") if body else None
    except ValueError:
        err = None
    if isinstance(err, dict) and (err.get("code") or err.get("message")):
        return "exit %d, %s: %s" % (rc, str(err.get("code", ""))[:60], str(err.get("message", ""))[:160])
    line = next((l.strip() for l in text.splitlines() if l.strip().startswith("Error:")), "")
    if re.fullmatch(r"Error: [A-Za-z ]{1,80}", line):
        return "exit %d, %s" % (rc, line)
    return "exit %d, unreadable response (%d bytes)" % (rc, len(text.encode()))

project = os.environ["VERCEL_PROJECT_ID"]
team = os.environ["VERCEL_ORG_ID"]
target = os.environ["TARGET"]
keys, until, hidden = [], None, 0
for _ in range(50):  # bounded: a project does not have 50 pages of variables
    path = "/v10/projects/%s/env?teamId=%s" % (project, team) + ("&until=%s" % until if until else "")
    run = subprocess.run([os.environ["VERCEL"], "api", path, "--raw"], capture_output=True, text=True)
    text = run.stdout + run.stderr
    if run.returncode != 0:
        fail(3, explain(run.returncode, text))
    try:
        data = json.loads("{" + text.split("{", 1)[1].rsplit("}", 1)[0] + "}")
        envs = data["envs"]
    except Exception:
        fail(3, explain(0, text))
    hidden += int(data.get("hiddenProductionEnvCount") or 0)
    for e in envs:
        if not isinstance(e, dict) or not isinstance(e.get("key"), str):
            fail(3, "malformed variable record in the response")
        t = e.get("target") or []
        t = [t] if isinstance(t, str) else t
        if target in t:
            keys.append(e["key"])
    nxt = (data.get("pagination") or {}).get("next")
    if not nxt:
        break
    until = nxt
else:
    fail(3, "more than 50 pages of variables")
if target == "production" and hidden:
    sys.stderr.write("vercel_env_check: %d production variables are hidden from this token, so the list cannot be verified\n" % hidden)
    sys.exit(4)
print("\n".join(keys))
PY
)" || { echo "vercel_env_check: FAIL, cannot verify the $TARGET variables for $APP; nothing was promoted." >&2; exit 1; }

missing=""
for name in $required; do
  grep -qx "$name" <<<"$present" || missing="$missing $name"
done

if [ -n "$missing" ]; then
  echo "vercel_env_check: FAIL, $APP has no $TARGET value for:${missing}. Add them in the Vercel project before shipping; nothing was promoted." >&2
  exit 1
fi
echo "vercel_env_check: $APP has every required $TARGET variable ($(wc -w <<<"$required" | tr -d ' ') checked)"
