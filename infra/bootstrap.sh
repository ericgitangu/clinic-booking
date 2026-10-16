#!/usr/bin/env bash
#
# One-time GCP bootstrap, run by the engineer from a laptop with gcloud logged in.
# It creates ONLY the things Terraform must not own: the state bucket, the Cloud Run
# service shell, and the run.invoker bindings on that service. Everything else is Terraform.
#
# NOTHING here runs automatically. Review, set the env vars, then run explicitly.
#
# Required env:
#   PROJECT          GCP project id (e.g. sil-clinic-booking)
#   GCLOUD_ACCOUNT   the account to act as (developer.ericgitangu@gmail.com) -- passed via
#                    --account on every call, because the active gcloud account differs
#   BILLING_ACCOUNT  billing account id (dedicated, Paid, no Free Trial)
#
# Cost rules ($0): us-east1 state bucket (Always Free region), Cloud Run min=0 max=3,
# no allUsers, custom audience clinic-api. See docs/ for the decision records.
set -euo pipefail

: "${PROJECT:?set PROJECT}"
: "${GCLOUD_ACCOUNT:?set GCLOUD_ACCOUNT}"
: "${BILLING_ACCOUNT:?set BILLING_ACCOUNT}"

G=(gcloud --account "$GCLOUD_ACCOUNT" --project "$PROJECT")
REGION=us-east4
BUCKET="gs://clinic-tfstate-${PROJECT}"

echo ">>> 1. Terraform state bucket (${BUCKET}, us-east1, versioned, keep 5 noncurrent)"
"${G[@]}" storage buckets create "$BUCKET" \
  --location=us-east1 --default-storage-class=STANDARD \
  --uniform-bucket-level-access --public-access-prevention --soft-delete-duration=0
"${G[@]}" storage buckets update "$BUCKET" --versioning
TMP_LIFECYCLE="$(mktemp)"
cat > "$TMP_LIFECYCLE" <<'JSON'
{"rule":[{"action":{"type":"Delete"},"condition":{"isLive":false,"numNewerVersions":5}}]}
JSON
"${G[@]}" storage buckets update "$BUCKET" --lifecycle-file="$TMP_LIFECYCLE"
rm -f "$TMP_LIFECYCLE"

echo ">>> 2. Cloud Run service shell (hello image; replaced by the first real deploy)"
# Terraform must NOT manage this service. min=0 max=3, IAM-only, custom audience.
# Global flags (--account/--project) go after the subcommand so `gcloud run deploy` reads as
# one token for cost_check.sh --static.
gcloud run deploy clinic-api \
  --account "$GCLOUD_ACCOUNT" --project "$PROJECT" \
  --image us-docker.pkg.dev/cloudrun/container/hello \
  --region "$REGION" \
  --no-allow-unauthenticated \
  --min-instances 0 --max-instances 3 \
  --add-custom-audiences=clinic-api

echo ">>> 3. Invoker bindings (run AFTER 'terraform apply' has created the SAs)"
echo "    Grant run.invoker to the web proxy and smoke identities only (no allUsers):"
cat <<CMDS
  "${G[@]}" run services add-iam-policy-binding clinic-api --region $REGION \\
    --member=serviceAccount:clinic-web@${PROJECT}.iam.gserviceaccount.com --role=roles/run.invoker
  "${G[@]}" run services add-iam-policy-binding clinic-api --region $REGION \\
    --member=serviceAccount:clinic-smoke@${PROJECT}.iam.gserviceaccount.com --role=roles/run.invoker
CMDS
echo "    (printed, not executed: the SAs must exist first)"

echo ">>> 4. \$3 gross Cloud Run spend cap (console or Budget API; see docs/runbooks/bootstrap-gcp.md)"
echo "    Budget API spend-cap support is unverified; set the cap in the console,"
echo "    scoped to project ${PROJECT} + Cloud Run service (152E-C115-5142), \$3 gross, and"
echo "    record the budget id in the runbook. This is the only hard spend cap."

echo ">>> bootstrap steps 1-2 done. Run step 3 after terraform apply, then set the budget."
