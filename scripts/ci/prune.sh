#!/usr/bin/env bash
#
# Cleanup after a release, so the Artifact Registry stays at two rollback candidates and the
# cost-check gate (C5/C6: at most 2 versions of clinic-api) sees a settled state.
#
#   prune.sh [--dry-run]     --dry-run lists what would change and changes nothing
#
# Promoted release: keeps exactly two images, the revision just promoted and the one that was live
# before it (promote.sh's keep.json), and removes every other revision tag and image version.
# Superseded release (a newer commit landed, so promote.sh skipped it): it pushed an image and
# deployed a no-traffic tagged revision that will never serve, and the newer release does not know
# about it until its own prune. It removes that tag and that image itself, unless a revision that
# serves traffic or holds another tag runs the same digest.
#
# Safety, in this order:
# - Nothing is deleted until every lookup has succeeded. A lookup that fails stops the script with
#   exit 1 and no change; the cost-check gate still runs and still counts.
# - The keep set is resolved from the revisions' own image digests, never from "newest two by
#   update time" and never from age.
# - Git history decides nothing: a sha-<commit> tag that does not resolve (after a history rewrite)
#   is not a keep reason. Kept: the keep set, any serving digest, and any image created after the
#   serving image (a newer pipeline's image that is pushed but not deployed yet). An image with no
#   createTime is kept too, and no serving createTime stops the script with no change.
# - Once the lookups have succeeded, a failed tag removal or image deletion is a WARNING and the
#   script still exits 0, so the release stays green.
# - Every gcloud call names --project; the region defaults to us-east4.
set -euo pipefail

DRY=0
case "${1:-}" in
  --dry-run) DRY=1 ;;
  "") ;;
  *) echo "usage: prune.sh [--dry-run]" >&2; exit 2 ;;
esac

REGION="${REGION:-us-east4}"
SERVICE="${SERVICE:-clinic-api}"
OUT="${PROMOTE_DIR:-/tmp/promoted}"
PROJECT="${GOOGLE_PROJECT_ID:?GOOGLE_PROJECT_ID is not set}"
REPO="${AR_PACKAGE:-us-east4-docker.pkg.dev/${PROJECT}/clinic/clinic-api}"

g() { gcloud "$@" --project "$PROJECT"; }
die() { echo "prune: $* (nothing was changed)" >&2; exit 1; }
change() { # run a mutating gcloud call, or only say so under --dry-run
  if [ "$DRY" = 1 ]; then echo "dry-run: would run: gcloud $* --project $PROJECT"; else g "$@"; fi
}
REGISTRY_PREFIX="${REPO%/*}/"   # everything in our Artifact Registry repository starts with this
digest_of_revision() { # the sha256:... a revision runs
  # Fail closed: a revision of OUR image that does not resolve to a digest cannot be protected, so
  # the whole prune stops. Only an image from another registry (the hello placeholder of the first
  # release) is allowed to have no digest here: it is not ours to delete and not a candidate.
  local image
  image="$(g run revisions describe "$1" --region "$REGION" --format='value(spec.containers[0].image)')" \
    || die "cannot read revision $1"
  [ -n "$image" ] || die "revision $1 reports no image"
  case "$image" in
    *@sha256:*) printf '%s' "${image##*@}" ;;
    "$REGISTRY_PREFIX"*) die "revision $1 runs $image, which does not resolve to a digest" ;;
    *) echo "prune: revision $1 runs a foreign image ($image); it is not ours to delete" >&2 ;;
  esac
}

state="$(cat "$OUT/state" 2>/dev/null || true)"
case "$state" in
  promoted|skipped) ;;
  *) echo "prune: no promote state; nothing to prune"; exit 0 ;;
esac

service_json="$(g run services describe "$SERVICE" --region "$REGION" --format=json)" \
  || die "cannot read service $SERVICE"

# Digests the traffic-bearing revisions run, and every tag entry as "tag<TAB>revision".
serving_digests=()
while IFS= read -r rev; do
  [ -z "$rev" ] && continue
  d="$(digest_of_revision "$rev")" || exit 1
  [ -n "$d" ] && serving_digests+=("$d")
done < <(jq -r '[.status.traffic[]? | select((.percent // 0) > 0) | .revisionName] | unique[]' <<<"$service_json")

in_list() { # <needle> <items...>
  local n="$1" i; shift
  for i in "$@"; do [ "$i" = "$n" ] && return 0; done
  return 1
}

if [ "$state" = skipped ]; then
  own_tag="sha-${CIRCLE_SHA1:?CIRCLE_SHA1 is not set}"
  own_tag="${own_tag:0:11}"
  own_rev="$(jq -r --arg t "$own_tag" '[.status.traffic[]? | select(.tag == $t) | .revisionName][0] // empty' <<<"$service_json")"
  if [ -z "$own_rev" ]; then echo "prune: superseded release has no tagged revision $own_tag; nothing to prune"; exit 0; fi
  own_digest="$(digest_of_revision "$own_rev")" || exit 1
  # digests held by any OTHER tagged revision (the rollback target keeps its tag)
  other_tagged=()
  while IFS= read -r rev; do
    [ -z "$rev" ] && continue
    d="$(digest_of_revision "$rev")" || exit 1
    [ -n "$d" ] && other_tagged+=("$d")
  done < <(jq -r --arg t "$own_tag" '[.status.traffic[]? | select(.tag != null and .tag != $t) | .revisionName] | unique[]' <<<"$service_json")
  echo "prune: this release was superseded; removing its own tag $own_tag"
  change run services update-traffic "$SERVICE" --region "$REGION" --remove-tags "$own_tag"
  if [ -n "$own_digest" ] && ! in_list "$own_digest" "${serving_digests[@]:-}" "${other_tagged[@]:-}"; then
    change artifacts docker images delete "${REPO}@${own_digest}" --delete-tags --quiet
  else
    echo "prune: keeping image ${own_digest:-?}: a serving or tagged revision runs it"
  fi
  exit 0
fi

# ---- promoted ------------------------------------------------------------------------------
[ -f "$OUT/keep.json" ] || die "no keep.json for a promoted release"
keep_revs_json="$(jq -c '.revisions' "$OUT/keep.json")"

keep_digests=()
while IFS= read -r rev; do
  [ -z "$rev" ] && continue
  d="$(digest_of_revision "$rev")" || exit 1
  [ -n "$d" ] && keep_digests+=("$d")
done < <(jq -r '.[]' <<<"$keep_revs_json")
# A digest a traffic-bearing revision runs is never a candidate, whatever keep.json says.
[ "${#serving_digests[@]}" -eq 0 ] || keep_digests+=("${serving_digests[@]}")
if [ "${#keep_digests[@]}" -eq 0 ]; then
  die "no kept image digest could be resolved; leaving all images in place"
fi
keep_digests_json="$(printf '%s\n' "${keep_digests[@]}" | grep . | jq -R . | jq -sc .)"

remove_tags="$(jq -r --argjson keep "$keep_revs_json" \
  '[.status.traffic[]? | select(.tag != null) | select((.revisionName as $r | $keep | index($r)) == null) | .tag] | join(",")' <<<"$service_json")"

images_json="$(g artifacts docker images list "$REPO" --include-tags --format=json)" || die "cannot list images in $REPO"

# Candidates: every image whose digest is not in the keep set AND that is not newer than the image
# now serving. Git history decides nothing (after a history rewrite old sha tags resolve to no
# commit); the digest a revision runs is the identity. An image created after the serving image
# was pushed by a newer pipeline (build-scan-push is outside the deploy-prod serial group, so it
# can push while this ship job prunes) and has not been deployed yet: it is never older junk.
serving_json="$(printf '%s\n' "${serving_digests[@]:-}" | grep . | jq -R . | jq -sc .)"
serving_created="$(jq -r --argjson s "$serving_json" \
  '[.[] | select(.version as $v | $s | index($v)) | .createTime // empty | tostring | .[0:19]] | max // empty' <<<"$images_json")"
[ -n "$serving_created" ] || die "cannot read the creation time of the serving image; leaving all images in place"

candidates=()
while IFS= read -r version; do
  [ -z "$version" ] && continue
  candidates+=("${REPO}@${version}")
done < <(jq -r --argjson keep "$keep_digests_json" --arg since "$serving_created" \
  '.[] | select((.version as $v | $keep | index($v)) == null)
       | select((.createTime // "" | tostring | .[0:19]) as $c | $c != "" and $c <= $since)
       | .version' <<<"$images_json")
while IFS=$'\t' read -r version; do
  [ -z "$version" ] && continue
  echo "prune: keeping $version: newer than the serving image (a release not yet deployed)"
done < <(jq -r --argjson keep "$keep_digests_json" --arg since "$serving_created" \
  '.[] | select((.version as $v | $keep | index($v)) == null)
       | select(((.createTime // "" | tostring | .[0:19]) as $c | $c == "" or $c > $since))
       | .version' <<<"$images_json")

# ---- every lookup succeeded: now change things ----------------------------------------------
if [ -n "$remove_tags" ]; then
  change run services update-traffic "$SERVICE" --region "$REGION" --remove-tags "$remove_tags" \
    || echo "prune: WARNING could not remove tags $remove_tags; continuing" >&2
fi
for ref in "${candidates[@]:-}"; do
  [ -z "$ref" ] && continue
  # A failed deletion is a warning, not a failed release: the next cost-check reports the leftover.
  change artifacts docker images delete "$ref" --delete-tags --quiet \
    || echo "prune: WARNING could not delete $ref; continuing" >&2
done
