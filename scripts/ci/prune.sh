#!/usr/bin/env bash
#
# Best-effort cleanup after a promotion. Keeps exactly two rollback candidates: the revision
# just promoted and the one that was live before it (from promote.sh's keep.json), and
# removes every other revision tag and Artifact Registry image version.
#
# The keep set is resolved from the revisions' own image digests, never from "newest two by
# update time": a release that was skipped because a newer commit landed has a newer image than
# the previous live one and would otherwise displace the real rollback target.
set -euo pipefail

REGION="${REGION:-us-east4}"
SERVICE="${SERVICE:-clinic-api}"
OUT="${PROMOTE_DIR:-/tmp/promoted}"
REPO="${AR_PACKAGE:-us-east4-docker.pkg.dev/${GOOGLE_PROJECT_ID:?}/clinic/clinic-api}"

if [ "$(cat "$OUT/state" 2>/dev/null || true)" != promoted ]; then
  echo "prune: this release was not promoted; nothing to prune"
  exit 0
fi

keep_revs_json="$(jq -c '.revisions' "$OUT/keep.json")"

# 1. Digests the kept revisions run. Refuse to delete anything if none can be resolved.
keep_digests=()
while IFS= read -r rev; do
  [ -z "$rev" ] && continue
  image="$(gcloud run revisions describe "$rev" --region "$REGION" --format='value(spec.containers[0].image)')"
  case "$image" in *@*) keep_digests+=("${image##*@}") ;; esac
done < <(jq -r '.[]' <<<"$keep_revs_json")

# 2. Remove tags that do not point at a kept revision.
remove_tags="$(gcloud run services describe "$SERVICE" --region "$REGION" --format=json |
  jq -r --argjson keep "$keep_revs_json" \
    '[.status.traffic[]? | select(.tag != null) | select((.revisionName as $r | $keep | index($r)) == null) | .tag] | join(",")')"
if [ -n "$remove_tags" ]; then
  gcloud run services update-traffic "$SERVICE" --region "$REGION" --remove-tags "$remove_tags"
fi

# 3. Delete image versions that no kept revision runs.
if [ "${#keep_digests[@]}" -eq 0 ]; then
  echo "prune: no kept image digest could be resolved; leaving all images in place" >&2
  exit 0
fi
keep_digests_json="$(printf '%s\n' "${keep_digests[@]}" | jq -R . | jq -sc .)"
gcloud artifacts docker images list "$REPO" --include-tags --format=json |
  jq -r --argjson keep "$keep_digests_json" \
    '.[] | select((.version as $v | $keep | index($v)) == null) | .package + "@" + .version' |
  while IFS= read -r ref; do
    [ -z "$ref" ] && continue
    gcloud artifacts docker images delete "$ref" --delete-tags --quiet
  done
