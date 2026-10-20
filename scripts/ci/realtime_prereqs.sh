#!/usr/bin/env bash
#
# What ship-realtime needs that only a person can provide, checked first so a missing step fails
# the job with the exact command to run instead of a mysterious error from gcloud later.
#
#   realtime_prereqs.sh                 before the deploy: the secret has a version
#   realtime_prereqs.sh --after-deploy  after it: the service exists and only the admin app and the
#                                       smoke identity may invoke it
#
# The CI deployer holds no setIamPolicy, by design, so the invoker bindings are made once by a
# person with `infra/bootstrap.sh invoker`. Read-only gcloud, always with --project and --region.
set -euo pipefail

PROJECT="${GOOGLE_PROJECT_ID:?set GOOGLE_PROJECT_ID}"
REGION="${REGION:-us-east4}"
SERVICE="${SERVICE:-clinic-realtime}"
MODE="${1:-before}"

die() { echo "FAIL (prerequisite): $*" >&2; exit 1; }

if [ "$MODE" = "--after-deploy" ]; then
  members="$(gcloud run services get-iam-policy "$SERVICE" --region "$REGION" --project "$PROJECT" --format=json |
    jq -r '[.bindings[]? | select(.role == "roles/run.invoker") | .members[]] | sort | .[]')"
  want="serviceAccount:clinic-admin@${PROJECT}.iam.gserviceaccount.com
serviceAccount:clinic-smoke@${PROJECT}.iam.gserviceaccount.com"
  if [ "$members" != "$want" ]; then
    die "run.invoker on $SERVICE is [$(printf '%s' "$members" | tr '\n' ' ')], want exactly clinic-admin and clinic-smoke.
The deployer cannot set IAM. A person with setIamPolicy runs, once (and again after any change):
  bash infra/bootstrap.sh invoker
which binds roles/run.invoker on $SERVICE to clinic-admin and clinic-smoke only (no public access, never clinic-web)."
  fi
  echo "invoker bindings on $SERVICE are exactly the admin app and the smoke identity"
  exit 0
fi

n="$(gcloud secrets versions list clinic-database-url-realtime --project "$PROJECT" --filter='state=ENABLED' --format=json | jq length)"
[ "$n" -ge 1 ] || die "secret clinic-database-url-realtime has no enabled version.
Create the clinic_realtime login on Neon and add the URL: https://clinic.ericgitangu.com/architecture#neon, section 'Optional realtime feature'."
echo "secret clinic-database-url-realtime has $n enabled version(s)"
