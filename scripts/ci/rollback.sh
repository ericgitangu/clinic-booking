#!/usr/bin/env bash
#
# Put production back on the revision that was live before this release.
#
#   rollback.sh              automatic: reads keep.json (written by promote.sh) from $PROMOTE_DIR
#   rollback.sh --to-tag T   manual (the CircleCI rollback pipeline): go back to the revision
#                            tagged T, which must exist on the service
#
# Schema: migrations are expand-only (scripts/migration_lint.sh), so the previous revision still
# runs against the migrated database. That is what makes a plain traffic move a safe rollback.
#
# It moves traffic only when ALL of these hold, and says why when it does not:
#   - keep.json names a current and a previous revision;
#   - the previous revision runs an image from this project's `clinic` registry (never the
#     placeholder hello image, which also lives on a *-docker.pkg.dev host:
#     rolling production back to it would take the API down);
#   - production is still on the revision this release promoted (if something else moved
#     traffic since, this release is not the one to undo).
# Exit 0: rolled back, or nothing to do. Exit 2: refused. Exit 1: the move did not take.
set -euo pipefail

REGION="${REGION:-us-east4}"
SERVICE="${SERVICE:-clinic-api}"
IN="${PROMOTE_DIR:-/tmp/promoted}"

TO_TAG=""
if [ "${1:-}" = "--to-tag" ]; then TO_TAG="${2:?usage: rollback.sh --to-tag <tag>}"; fi

if [ -n "$TO_TAG" ]; then
  previous="$(gcloud run services describe "$SERVICE" --region "$REGION" --format=json |
    jq -r --arg t "$TO_TAG" '[.status.traffic[]? | select(.tag == $t) | .revisionName][0] // empty')"
  if [ -z "$previous" ]; then
    echo "rollback: refused, no revision is tagged '$TO_TAG' on $SERVICE (pruned or never deployed)" >&2
    exit 2
  fi
  current=""
else
  [ -f "$IN/keep.json" ] || { echo "rollback: no keep.json in $IN; nothing was promoted by this pipeline"; exit 0; }
  current="$(jq -r '.current // empty' "$IN/keep.json")"
  previous="$(jq -r '.previous // empty' "$IN/keep.json")"
  if [ -z "$current" ] || [ -z "$previous" ]; then
    echo "rollback: refused, keep.json has no previous revision (first release?)" >&2
    exit 2
  fi
fi

image="$(gcloud run revisions describe "$previous" --region "$REGION" --format='value(spec.containers[0].image)')"
case "$image" in
  *-docker.pkg.dev/"${GOOGLE_PROJECT_ID:?set GOOGLE_PROJECT_ID}"/clinic/*) ;;
  *) echo "rollback: refused, $previous runs '${image:-unknown}', not an image from our registry" >&2; exit 2 ;;
esac

live="$(gcloud run services describe "$SERVICE" --region "$REGION" --format=json |
  jq -r '[.status.traffic[]? | select((.percent // 0) == 100) | .revisionName][0] // empty')"
if [ "$live" = "$previous" ]; then
  echo "rollback: already on $previous"; exit 0
fi
if [ -n "$current" ] && [ "$live" != "$current" ]; then
  echo "rollback: refused, production is on '${live:-none}', not the promoted $current" >&2
  exit 2
fi

gcloud run services update-traffic "$SERVICE" --region "$REGION" --to-revisions "${previous}=100"

after="$(gcloud run services describe "$SERVICE" --region "$REGION" --format=json |
  jq -r '[.status.traffic[]? | select((.percent // 0) == 100) | .revisionName][0] // empty')"
if [ "$after" != "$previous" ]; then
  echo "rollback: traffic is on '${after:-none}' after the move, expected $previous" >&2
  exit 1
fi
mkdir -p "$IN"; echo rolled-back > "$IN/rollback_state"
echo "rolled back $SERVICE: $current -> $previous"
