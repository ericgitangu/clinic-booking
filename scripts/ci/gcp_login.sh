#!/usr/bin/env bash
# Keyless CircleCI -> GCP login via Workload Identity Federation.
# Needs CIRCLE_OIDC_TOKEN_V2 (set by CircleCI) and, from the gcp-deploy context:
# GOOGLE_PROJECT_ID, GOOGLE_PROJECT_NUMBER, DEPLOYER_SA. The token is never echoed.
set -euo pipefail
: "${CIRCLE_OIDC_TOKEN_V2:?missing OIDC token}"
: "${GOOGLE_PROJECT_ID:?}" "${GOOGLE_PROJECT_NUMBER:?}" "${DEPLOYER_SA:?}"

umask 077
printf %s "$CIRCLE_OIDC_TOKEN_V2" > /tmp/oidc_token
gcloud iam workload-identity-pools create-cred-config \
  "projects/${GOOGLE_PROJECT_NUMBER}/locations/global/workloadIdentityPools/circleci/providers/circleci-oidc" \
  --service-account="$DEPLOYER_SA" \
  --credential-source-file=/tmp/oidc_token \
  --credential-source-type=text \
  --output-file=/tmp/gcp_cred.json >/dev/null
gcloud auth login --cred-file=/tmp/gcp_cred.json --quiet
gcloud config set project "$GOOGLE_PROJECT_ID" --quiet
