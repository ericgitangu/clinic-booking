#!/usr/bin/env bash
#
# Put production back on the revision that was live before this release.
#
#   rollback.sh            reads keep.json (written by promote.sh) from $PROMOTE_DIR
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

[ -f "$IN/keep.json" ] || { echo "rollback: no keep.json in $IN; nothing was promoted by this pipeline"; exit 0; }
current="$(jq -r '.current // empty' "$IN/keep.json")"
previous="$(jq -r '.previous // empty' "$IN/keep.json")"
if [ -z "$current" ] || [ -z "$previous" ]; then
  echo "rollback: refused, keep.json has no previous revision (first release?)" >&2
  exit 2
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
if [ "$live" != "$current" ]; then
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
echo rolled-back > "$IN/rollback_state"
echo "rolled back $SERVICE: $current -> $previous"
