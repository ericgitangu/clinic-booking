#!/usr/bin/env bash
#
# Promote the tagged revision to 100% traffic, but only if this commit is still main's head.
# Records the outcome and the rollback set for prune.sh.
#
#   promote.sh <tag>        e.g. promote.sh sha-1a2b3c4
#
# Writes /tmp/promoted/state ("promoted" | "skipped") and, when promoted,
# /tmp/promoted/keep.json = {"revisions": [<new>, <live before>], "current": <new>, "previous": <live before>}
# (rollback.sh reads current and previous).
# The previous live revision is read BEFORE traffic moves, so a skipped release in between can
# never take its place.
set -euo pipefail

NEW_TAG="${1:?usage: promote.sh <tag>}"
REGION="${REGION:-us-east4}"
SERVICE="${SERVICE:-clinic-api}"
OUT="${PROMOTE_DIR:-/tmp/promoted}"
mkdir -p "$OUT"
rm -f "$OUT/state" "$OUT/keep.json"

git fetch origin main
if [ "${CIRCLE_SHA1:?}" != "$(git rev-parse origin/main)" ]; then
  echo "A newer commit exists on main; skipping promotion (it will ship)."
  echo skipped > "$OUT/state"
  exit 0
fi

before="$(gcloud run services describe "$SERVICE" --region "$REGION" --format=json)"
prev_rev="$(jq -r '[.status.traffic[]? | select((.percent // 0) == 100) | .revisionName][0] // empty' <<<"$before")"

gcloud run services update-traffic "$SERVICE" --region "$REGION" --to-tags "${NEW_TAG}=100"

after="$(gcloud run services describe "$SERVICE" --region "$REGION" --format=json)"
new_rev="$(jq -r --arg t "$NEW_TAG" '[.status.traffic[]? | select(.tag == $t) | .revisionName][0] // empty' <<<"$after")"
if [ -z "$new_rev" ]; then
  echo "promote: tag $NEW_TAG not found after the traffic update" >&2
  exit 1
fi

jq -n --arg n "$new_rev" --arg p "$prev_rev" \
  '{revisions: ([$n, $p] | map(select(length > 0)) | unique), current: $n, previous: $p}' > "$OUT/keep.json"
echo promoted > "$OUT/state"
echo "promoted $new_rev (previous live: ${prev_rev:-none})"
