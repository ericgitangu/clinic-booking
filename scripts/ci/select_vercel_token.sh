#!/usr/bin/env bash
#
# Pick the Vercel token for ONE app and hide the other, for the rest of the job.
#
#   select_vercel_token.sh <booking|admin>        (appends to $BASH_ENV, which CircleCI sources in every step)
#
# The vercel-prod context carries two project-scoped tokens: VERCEL_TOKEN (clinic-web, the booking
# app) and VERCEL_ADMIN_TOKEN (clinic-admin). The Vercel CLI and scripts/ci/vercel_prod.sh read
# VERCEL_TOKEN only, so an admin job maps the admin token onto it, and every job unsets
# VERCEL_ADMIN_TOKEN so no later step in a booking job can use or print it.
# A token value is never echoed. An admin job without VERCEL_ADMIN_TOKEN stops here, before any
# deploy or rollback action, with a message that says what to add and where.
set -euo pipefail

app="${1:-}"
: "${BASH_ENV:?BASH_ENV is not set (this runs inside a CircleCI step)}"

case "$app" in
  booking)
    : "${VERCEL_TOKEN:?VERCEL_TOKEN is not set: add the clinic-web project token to the vercel-prod context}"
    echo 'unset VERCEL_ADMIN_TOKEN' >> "$BASH_ENV"
    echo "vercel token: booking job uses VERCEL_TOKEN; VERCEL_ADMIN_TOKEN is hidden"
    ;;
  admin)
    if [ -z "${VERCEL_ADMIN_TOKEN:-}" ]; then
      echo "VERCEL_ADMIN_TOKEN is not set. The admin app lives in its own Vercel project (clinic-admin) and the" >&2
      echo "booking token (VERCEL_TOKEN, scoped to clinic-web) cannot read or promote it. Add a clinic-admin" >&2
      echo "scoped token to the vercel-prod context as VERCEL_ADMIN_TOKEN. Nothing was deployed or rolled back." >&2
      exit 1
    fi
    {
      # BASH_ENV is sourced by every bash, including the child shell a step starts with
      # `bash scripts/...`. By then VERCEL_ADMIN_TOKEN is unset, so the assignment must keep the
      # value the step's shell already chose rather than overwrite it with an empty string.
      echo 'export VERCEL_TOKEN="${VERCEL_ADMIN_TOKEN:-$VERCEL_TOKEN}"'
      echo 'unset VERCEL_ADMIN_TOKEN'
    } >> "$BASH_ENV"
    echo "vercel token: admin job uses VERCEL_ADMIN_TOKEN as VERCEL_TOKEN"
    ;;
  *)
    echo "usage: select_vercel_token.sh booking|admin" >&2
    exit 2
    ;;
esac
