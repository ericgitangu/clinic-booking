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
# - An image tagged sha-<commit> for a commit that is a descendant of this one (or one this
#   checkout cannot resolve) belongs to a release that is still in flight: it was pushed but not
#   deployed yet, so it is never deleted here.
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
digest_of_revision() { # the sha256:... a revision runs; empty when it runs something else
  local image
  image="$(g run revisions describe "$1" --region "$REGION" --format='value(spec.containers[0].image)')" \
    || die "cannot read revision $1"
  case "$image" in *@*) printf '%s' "${image##*@}" ;; esac
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

candidates=()
while IFS=$'\t' read -r version tags; do
  [ -z "$version" ] && continue
  protected=""
  for t in ${tags//,/ }; do
    case "$t" in sha-*) ;; *) continue ;; esac
    full="$(git rev-parse --verify --quiet "${t#sha-}^{commit}" 2>/dev/null)" || full=""
    if [ -z "$full" ]; then protected="tag $t is a commit this checkout cannot resolve"; break; fi
    if [ "$full" != "${CIRCLE_SHA1:-}" ] && git merge-base --is-ancestor "${CIRCLE_SHA1:-HEAD}" "$full" 2>/dev/null; then
      protected="tag $t is a newer release that is still in flight"; break
    fi
  done
  if [ -n "$protected" ]; then echo "prune: keeping $version ($protected)"; continue; fi
  candidates+=("${REPO}@${version}")
done < <(jq -r --argjson keep "$keep_digests_json" \
  '.[] | select((.version as $v | $keep | index($v)) == null)
       | [.version, ((.tags // "") | if type == "array" then join(",") else . end)] | @tsv' <<<"$images_json")

# ---- every lookup succeeded: now change things ----------------------------------------------
if [ -n "$remove_tags" ]; then
  change run services update-traffic "$SERVICE" --region "$REGION" --remove-tags "$remove_tags"
fi
for ref in "${candidates[@]:-}"; do
  [ -z "$ref" ] && continue
  change artifacts docker images delete "$ref" --delete-tags --quiet
done
