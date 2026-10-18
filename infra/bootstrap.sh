#!/usr/bin/env bash
#
# One-time GCP bootstrap, run by the engineer from a laptop. It is split into modes so the
# run order in docs/runbooks/bootstrap-gcp.md can interleave it with Terraform and CircleCI:
#
#   project   create the project, link billing, enable the APIs Terraform itself needs
#   state     create the Terraform state bucket (us-east1)
#   service   create the Cloud Run service shell      (AFTER terraform apply: needs the runtime SA)
#   invoker   grant run.invoker: web, admin and smoke on clinic-api; admin and smoke only on
#             clinic-realtime  (AFTER terraform apply: needs those SAs)
#
# Every mode is safe to re-run. Several modes can be given in one call, e.g.
#   bash infra/bootstrap.sh project state
#
# NOTHING runs on its own. Set DRY_RUN=1 to print each command instead of executing it.
#
# Required env:
#   PROJECT          GCP project id (sil-clinic-booking)
#   GCLOUD_ACCOUNT   the account to act as: the.ace.guru@gmail.com, the project Owner. Use it for
#                    every mode here (IAM, state bucket, Cloud Run). Passed with --account on
#                    every call because the machine's active gcloud account is a different one.
#   BILLING_ACCOUNT  billing account id, used by `project` only: the SHARED account
#                    01C382-12CD13-DCA6EF ("Firebase Payment"); no dedicated one could be opened.
#
# `project` mode is DONE (2026-10-16): sil-clinic-booking (number 291652953712) exists, is linked
# to the shared billing account and has serviceusage, cloudresourcemanager, storage and run
# enabled. It was created as the.ace.guru@gmail.com because developer.ericgitangu@gmail.com hit
# Google's project-creation quota, so the.ace.guru is the Owner and developer holds only
# roles/editor and roles/billing.projectManager. Do not re-run it; it is kept for the record and
# is safe to re-run. Billing and budget steps (infra/billing, `make cost-check` C11/C14) run as
# developer.ericgitangu@gmail.com; nothing in this script needs that account.
#
# Cost rules ($0): us-east1 state bucket (Always Free region), Cloud Run min=0 max=3, no
# allUsers, custom audience clinic-api. See docs/ for the decision records.
set -euo pipefail

: "${PROJECT:?set PROJECT}"
: "${GCLOUD_ACCOUNT:?set GCLOUD_ACCOUNT}"

REGION=us-east4
BUCKET="gs://clinic-tfstate-${PROJECT}"
DRY_RUN="${DRY_RUN:-0}"

# Run a mutating command, or only print it under DRY_RUN.
run() {
  if [ "$DRY_RUN" = 1 ]; then printf '+'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}

# Read-only existence probe. Under DRY_RUN nothing is contacted and nothing "exists", so a dry
# run prints the full create path.
exists() {
  if [ "$DRY_RUN" = 1 ]; then return 1; fi
  "$@" >/dev/null 2>&1
}

step_project() {
  : "${BILLING_ACCOUNT:?set BILLING_ACCOUNT for the project mode}"
  echo ">>> project: create ${PROJECT}, link billing, enable bootstrap APIs"
  if exists gcloud projects describe "$PROJECT" --account "$GCLOUD_ACCOUNT"; then
    echo "    project exists"
  else
    run gcloud projects create "$PROJECT" --account "$GCLOUD_ACCOUNT" --quiet
  fi
  run gcloud billing projects link "$PROJECT" --account "$GCLOUD_ACCOUNT" \
    --billing-account "$BILLING_ACCOUNT" --quiet
  # Only what is needed before Terraform can run (and to avoid gcloud's interactive "enable
  # API?" prompt). Terraform's apis.tf enables and then owns the rest.
  run gcloud services enable \
    serviceusage.googleapis.com cloudresourcemanager.googleapis.com \
    storage.googleapis.com run.googleapis.com \
    --account "$GCLOUD_ACCOUNT" --project "$PROJECT" --quiet
}

step_state() {
  echo ">>> state: Terraform state bucket ${BUCKET} (us-east1, versioned, keep 5 noncurrent)"
  if exists gcloud storage buckets describe "$BUCKET" --account "$GCLOUD_ACCOUNT" --project "$PROJECT"; then
    echo "    bucket exists"
  else
    run gcloud storage buckets create "$BUCKET" \
      --account "$GCLOUD_ACCOUNT" --project "$PROJECT" \
      --location=us-east1 --default-storage-class=STANDARD \
      --uniform-bucket-level-access --public-access-prevention --soft-delete-duration=0
  fi
  run gcloud storage buckets update "$BUCKET" --account "$GCLOUD_ACCOUNT" --project "$PROJECT" --versioning
  local lifecycle
  lifecycle="$(mktemp)"
  printf '%s\n' '{"rule":[{"action":{"type":"Delete"},"condition":{"isLive":false,"numNewerVersions":5}}]}' > "$lifecycle"
  run gcloud storage buckets update "$BUCKET" --account "$GCLOUD_ACCOUNT" --project "$PROJECT" \
    --lifecycle-file="$lifecycle"
  [ "$DRY_RUN" = 1 ] || rm -f "$lifecycle"
}

step_service() {
  echo ">>> service: Cloud Run service shell (hello image; replaced by the first release)"
  # Created once and never redeployed from here: re-running must not roll a live service back
  # to the hello image. Terraform must NOT manage this service.
  if exists gcloud run services describe clinic-api --account "$GCLOUD_ACCOUNT" --project "$PROJECT" --region "$REGION"; then
    echo "    clinic-api exists; leaving it untouched"
    return
  fi
  run gcloud run deploy clinic-api \
    --account "$GCLOUD_ACCOUNT" --project "$PROJECT" \
    --image us-docker.pkg.dev/cloudrun/container/hello \
    --region "$REGION" \
    --service-account "clinic-api-runtime@${PROJECT}.iam.gserviceaccount.com" \
    --no-allow-unauthenticated \
    --min-instances 0 --max-instances 3 \
    --add-custom-audiences=clinic-api \
    --quiet
}

step_invoker() {
  echo ">>> invoker: run.invoker for the web proxy, the admin app and the smoke identity on clinic-api; the admin app and the smoke identity only on clinic-realtime (no public access)"
  local svc sa found=0
  for svc in clinic-api clinic-realtime; do
    # clinic-realtime exists only if the optional realtime feature was deployed.
    if [ "$DRY_RUN" != 1 ] && ! exists gcloud run services describe "$svc" \
        --account "$GCLOUD_ACCOUNT" --project "$PROJECT" --region "$REGION"; then
      echo "    $svc does not exist; skipping"
      continue
    fi
    found=1
    # The live-feed gateway is reached only through the admin app (its BFF signs the staff
    # assertion), plus the release smoke; clinic-web (the public booking proxy) never needs it.
    local members="clinic-web clinic-admin clinic-smoke"
    [ "$svc" = clinic-realtime ] && members="clinic-admin clinic-smoke"
    for sa in $members; do
      run gcloud run services add-iam-policy-binding "$svc" \
        --account "$GCLOUD_ACCOUNT" --project "$PROJECT" --region "$REGION" \
        --member "serviceAccount:${sa}@${PROJECT}.iam.gserviceaccount.com" \
        --role roles/run.invoker --quiet
    done
  done
  if [ "$found" = 0 ]; then
    echo "no Cloud Run service found: run the service mode first" >&2
    return 1
  fi
}

if [ "$#" -eq 0 ]; then
  sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
  exit 2
fi

for mode in "$@"; do
  case "$mode" in
    project) step_project ;;
    state) step_state ;;
    service) step_service ;;
    invoker) step_invoker ;;
    *) echo "unknown mode: $mode (use: project state service invoker)" >&2; exit 2 ;;
  esac
done
echo ">>> done: $*"
