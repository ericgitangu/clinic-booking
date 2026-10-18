#!/usr/bin/env bash
#
# Tests for promote.sh, prune.sh, require_head.sh and skip_unless_changed.sh, run against a
# fake `gcloud`, `circleci-agent` and a throwaway git repository. Nothing here touches any
# cloud. Exit 0 only if every case passes.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PASSES=0
FAILS=0
ok()  { PASSES=$((PASSES + 1)); printf 'PASS  %s\n' "$1"; }
bad() { FAILS=$((FAILS + 1)); printf 'FAIL  %s\n' "$1"; }
expect() { # expect <description> <actual> <expected>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got: $2 | want: $3)"; fi
}

# ---- fakes --------------------------------------------------------------------------------
mkdir -p "$WORK/bin"
# gcloud: reads fixtures from $FX, logs every mutating call to $FX/calls.
cat > "$WORK/bin/gcloud" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$FX/calls.all"
case "$*" in
  "run services describe"*)
    if [ -f "$FX/rolled" ]; then cat "$FX/service_rolled.json"
    elif [ -f "$FX/promoted" ]; then cat "$FX/service_after.json"; else cat "$FX/service_before.json"; fi ;;
  "run services update-traffic"*--to-tags*)
    echo "$*" >> "$FX/calls"; touch "$FX/promoted" ;;
  "run services update-traffic"*--to-revisions*)
    echo "$*" >> "$FX/calls"; touch "$FX/rolled" ;;
  "run services update-traffic"*--remove-tags*)
    echo "$*" >> "$FX/calls" ;;
  "run revisions describe"*)
    [ -f "$FX/revfail" ] && { echo "ERROR: (gcloud.run.revisions.describe) 503" >&2; exit 1; }
    rev="$4"; jq -r --arg r "$rev" '.[$r] // ""' "$FX/revision_images.json" ;;
  "artifacts docker images list"*)
    cat "$FX/images.json" ;;
  "artifacts docker images delete"*)
    echo "$*" >> "$FX/calls" ;;
  *) echo "fake gcloud: unhandled: $*" >&2; exit 99 ;;
esac
FAKE
cat > "$WORK/bin/circleci-agent" <<'FAKE'
#!/usr/bin/env bash
echo "halt" >> "$FX/agent"
FAKE
chmod +x "$WORK/bin/gcloud" "$WORK/bin/circleci-agent"
export PATH="$WORK/bin:$PATH"

# ---- a throwaway git repo with an "origin" ------------------------------------------------
git init -q --bare "$WORK/origin.git"
git clone -q "$WORK/origin.git" "$WORK/repo" 2>/dev/null
cd "$WORK/repo"
git config user.email t@t; git config user.name t
git checkout -q -b main
echo a > a; git add a; git commit -q -m one; git push -q origin main 2>/dev/null
HEAD_SHA="$(git rev-parse HEAD)"

new_fx() { FX="$WORK/fx.$1"; rm -rf "$FX"; mkdir -p "$FX"; export FX; }
cnt() { # number of lines in the mutating-call log matching a pattern (0 if there is no log)
  local n
  n="$(grep -c -- "$1" "$FX/calls" 2>/dev/null)"
  echo "${n:-0}"
}
mut() { cnt "$1"; }

# =========================================================================================
# promote.sh + prune.sh: the skipped-release scenario from the review.
#   Live before: P (tag sha-p, 100%). A was skipped earlier (tag sha-a, 0%). O is older.
#   Promoting B must keep B and P, and remove A and O (tags and images).
# =========================================================================================
# rollback.sh: only ever back to a real previous revision, only if this release is still live.
# =========================================================================================
rb_setup() { # <name> <live revision> <previous image>
  new_fx "$1"; export GOOGLE_PROJECT_ID=p
  cat > "$FX/service_after.json" <<J
{"status":{"traffic":[{"revisionName":"$2","percent":100,"tag":"t"},{"revisionName":"rev-p","percent":0,"tag":"sha-p"}]}}
J
  cp "$FX/service_after.json" "$FX/service_before.json"; touch "$FX/promoted"
  cat > "$FX/service_rolled.json" <<'J'
{"status":{"traffic":[{"revisionName":"rev-p","percent":100,"tag":"sha-p"},{"revisionName":"rev-b","percent":0,"tag":"sha-b"}]}}
J
  jq -n --arg i "$3" '{"rev-p":$i,"rev-b":"us-east4-docker.pkg.dev/p/clinic/clinic-api@sha256:bbb"}' > "$FX/revision_images.json"
  export PROMOTE_DIR="$WORK/rb.$1"; mkdir -p "$PROMOTE_DIR"
  echo '{"revisions":["rev-b","rev-p"],"current":"rev-b","previous":"rev-p"}' > "$PROMOTE_DIR/keep.json"
}
rb_setup ok rev-b "us-east4-docker.pkg.dev/p/clinic/clinic-api@sha256:ppp"
bash "$HERE/rollback.sh" >/dev/null 2>&1; rc=$?
expect "rollback: exit 0 when the promoted release is live" "$rc" 0
expect "rollback: traffic goes back to the previous revision" "$(cnt 'to-revisions rev-p=100')" 1
expect "rollback: state recorded" "$(cat "$PROMOTE_DIR/rollback_state")" rolled-back

rb_setup hello rev-b "us-docker.pkg.dev/cloudrun/container/hello"
bash "$HERE/rollback.sh" >/dev/null 2>&1; rc=$?
expect "rollback: refuses the placeholder image (exit 2)" "$rc" 2
expect "rollback: no traffic change for the placeholder" "$(cnt 'update-traffic')" 0

rb_setup moved rev-x "us-east4-docker.pkg.dev/p/clinic/clinic-api@sha256:ppp"
bash "$HERE/rollback.sh" >/dev/null 2>&1; rc=$?
expect "rollback: refuses when production is on a different revision (exit 2)" "$rc" 2
expect "rollback: no traffic change when it is not this release" "$(cnt 'update-traffic')" 0

rb_setup already rev-p "us-east4-docker.pkg.dev/p/clinic/clinic-api@sha256:ppp"
bash "$HERE/rollback.sh" >/dev/null 2>&1; rc=$?
expect "rollback: already on the previous revision is a no-op (exit 0)" "$rc" 0
expect "rollback: no-op makes no traffic change" "$(cnt 'update-traffic')" 0
expect "rollback: no-op still records a state for the workspace" "$(cat "$PROMOTE_DIR/rollback_state")" already-previous

rb_setup first rev-b ""
echo '{"revisions":["rev-b"],"current":"rev-b","previous":""}' > "$PROMOTE_DIR/keep.json"
bash "$HERE/rollback.sh" >/dev/null 2>&1; rc=$?
expect "rollback: first release has nothing to go back to (exit 2)" "$rc" 2

new_fx nokeep; export PROMOTE_DIR="$WORK/rb.nokeep"; mkdir -p "$PROMOTE_DIR"
bash "$HERE/rollback.sh" >/dev/null 2>&1; rc=$?
expect "rollback: nothing promoted means nothing to do (exit 0)" "$rc" 0


# manual mode: --to-tag
rb_setup tag rev-b "us-east4-docker.pkg.dev/p/clinic/clinic-api@sha256:ppp"
bash "$HERE/rollback.sh" --to-tag sha-p >/dev/null 2>&1; rc=$?
expect "rollback --to-tag: exit 0 for an existing tag" "$rc" 0
expect "rollback --to-tag: moves traffic to that tag's revision" "$(cnt 'to-revisions rev-p=100')" 1
rb_setup notag rev-b "us-east4-docker.pkg.dev/p/clinic/clinic-api@sha256:ppp"
bash "$HERE/rollback.sh" --to-tag sha-gone >/dev/null 2>&1; rc=$?
expect "rollback --to-tag: a tag that does not exist is refused (exit 2)" "$rc" 2
expect "rollback --to-tag: no traffic change for a missing tag" "$(cnt 'update-traffic')" 0
rb_setup tag_hello rev-b "us-docker.pkg.dev/cloudrun/container/hello"
bash "$HERE/rollback.sh" --to-tag sha-p >/dev/null 2>&1; rc=$?
expect "rollback --to-tag: the placeholder image is refused (exit 2)" "$rc" 2

# vercel_prod.sh with a fake vercel
cat > "$WORK/bin/fakevercel" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$FX/vcalls"
case "$1" in
  api) [ -f "$FX/telemetry" ] && printf '> NOTE: The Vercel CLI now collects telemetry.\n> https://vercel.com/docs/cli/about-telemetry\n'
       [ -f "$FX/refused" ] && { echo 'Error: Not authorized: Trying to access resource under scope "team". You must re-authenticate to this scope or use a token with access to this scope. (403)'; exit 1; }
       [ -f "$FX/notjson" ] && { echo 'something unexpected'; exit 0; }
       case "$2" in
         */v6/deployments*) echo "{\"deployments\":[{\"uid\":\"$(cat "$FX/serving")\"},{\"uid\":\"dpl_prior\"}]}" ;;
         *) echo "{\"id\":\"$(cat "$FX/serving")\"}" ;;
       esac ;;
  promote) echo "$2" > "$FX/serving" ;;
  rollback) [ -f "$FX/rollback_broken" ] || echo "$2" > "$FX/serving" ;;
esac
FAKE
chmod +x "$WORK/bin/fakevercel"
export VERCEL="$WORK/bin/fakevercel" VERCEL_ORG_ID=team_x
new_fx vp; echo dpl_old > "$FX/serving"
out="$(bash "$HERE/vercel_prod.sh" current 2>/dev/null)"; expect "vercel_prod: current reads the serving deployment" "$out" dpl_old
export VERCEL_PROJECT_ID=prj_x
touch "$FX/telemetry"
out="$(bash "$HERE/vercel_prod.sh" current 2>/dev/null)"; expect "vercel_prod: a telemetry banner before the JSON is skipped" "$out" dpl_old
rm -f "$FX/telemetry"
touch "$FX/refused"
err="$(bash "$HERE/vercel_prod.sh" current 2>&1 >/dev/null)"; rc=$?
expect "vercel_prod: a refused token fails with exit 1" "$rc" 1
expect "vercel_prod: a refused token says so plainly" "$(printf '%s' "$err" | rg -c 'token was refused')" 1
expect "vercel_prod: a refused token does not end in a parser error" "$(printf '%s' "$err" | grep -cE 'Traceback|ValueError')" 0
rm -f "$FX/refused"
touch "$FX/notjson"
err="$(bash "$HERE/vercel_prod.sh" current 2>&1 >/dev/null)"; rc=$?
expect "vercel_prod: a non-JSON answer fails with exit 1" "$rc" 1
expect "vercel_prod: a non-JSON answer quotes what the CLI said" "$(printf '%s' "$err" | rg -c 'no JSON from the Vercel API')" 1
rm -f "$FX/notjson"
: > "$FX/vcalls"
VERCEL_APP=admin bash "$HERE/vercel_prod.sh" current >/dev/null 2>&1
expect "vercel_prod: the admin app reads its own host" "$(head -1 "$FX/vcalls" | rg -c 'clinic-admin.ericgitangu.com')" 1
VERCEL_APP=other bash "$HERE/vercel_prod.sh" current >/dev/null 2>&1; rc=$?
expect "vercel_prod: an unknown app is refused (exit 2)" "$rc" 2
out="$(bash "$HERE/vercel_prod.sh" previous 2>/dev/null)"; expect "vercel_prod: previous skips the live deployment" "$out" dpl_prior
bash "$HERE/vercel_prod.sh" ensure dpl_new >/dev/null 2>&1; rc=$?
expect "vercel_prod: ensure promotes a deployment the alias is not serving" "$rc:$(cat "$FX/serving")" "0:dpl_new"
bash "$HERE/vercel_prod.sh" ensure dpl_new >/dev/null 2>&1
expect "vercel_prod: ensure does not promote twice" "$(grep -c '^promote' "$FX/vcalls")" 1
bash "$HERE/vercel_prod.sh" rollback dpl_old >/dev/null 2>&1
expect "vercel_prod: rollback points production at the named deployment" "$(cat "$FX/serving")" dpl_old
touch "$FX/rollback_broken"; bash "$HERE/vercel_prod.sh" rollback dpl_new >/dev/null 2>&1; rc=$?
expect "vercel_prod: a rollback that does not take fails (exit 1)" "$rc" 1
bash "$HERE/vercel_prod.sh" rollback "" >/dev/null 2>&1; rc=$?
expect "vercel_prod: no recorded previous deployment is refused (exit 2)" "$rc" 2
unset VERCEL


# =========================================================================================
new_fx skipped_in_between
cat > "$FX/service_before.json" <<'J'
{"status":{"traffic":[
 {"revisionName":"rev-p","percent":100,"tag":"sha-p"},
 {"revisionName":"rev-a","percent":0,"tag":"sha-a"},
 {"revisionName":"rev-o","percent":0,"tag":"sha-o"},
 {"revisionName":"rev-b","percent":0,"tag":"sha-b"}]}}
J
cat > "$FX/service_after.json" <<'J'
{"status":{"traffic":[
 {"revisionName":"rev-b","percent":100,"tag":"sha-b"},
 {"revisionName":"rev-p","percent":0,"tag":"sha-p"},
 {"revisionName":"rev-a","percent":0,"tag":"sha-a"},
 {"revisionName":"rev-o","percent":0,"tag":"sha-o"}]}}
J
cat > "$FX/revision_images.json" <<'J'
{"rev-b":"us-east4-docker.pkg.dev/p/clinic/clinic-api@sha256:bbb",
 "rev-p":"us-east4-docker.pkg.dev/p/clinic/clinic-api@sha256:ppp",
 "rev-a":"us-east4-docker.pkg.dev/p/clinic/clinic-api@sha256:aaa",
 "rev-o":"us-east4-docker.pkg.dev/p/clinic/clinic-api@sha256:ooo"}
J
# Newest-first by update time: B, A (skipped), P (live), O. The old "newest two" rule would
# have kept B and A and deleted P, the real rollback target.
cat > "$FX/images.json" <<'J'
[{"package":"us-east4-docker.pkg.dev/p/clinic/clinic-api","version":"sha256:bbb"},
 {"package":"us-east4-docker.pkg.dev/p/clinic/clinic-api","version":"sha256:aaa"},
 {"package":"us-east4-docker.pkg.dev/p/clinic/clinic-api","version":"sha256:ppp"},
 {"package":"us-east4-docker.pkg.dev/p/clinic/clinic-api","version":"sha256:ooo"}]
J
export CIRCLE_SHA1="$HEAD_SHA" GOOGLE_PROJECT_ID=p PROMOTE_DIR="$WORK/promoted.1"
bash "$HERE/promote.sh" sha-b >/dev/null 2>&1; rc=$?
expect "promote: exit 0 when still main's head" "$rc" 0
expect "promote: state is promoted" "$(cat "$PROMOTE_DIR/state")" promoted
expect "promote: traffic moved to the new tag" "$(mut 'to-tags sha-b=100')" 1
expect "promote: keep set is the new revision plus the one live BEFORE" \
  "$(jq -c '.revisions|sort' "$PROMOTE_DIR/keep.json")" '["rev-b","rev-p"]'
bash "$HERE/prune.sh" >/dev/null 2>&1; rc=$?
expect "prune: exit 0" "$rc" 0
expect "prune: removes the skipped and the old tags, keeps new and previous" \
  "$(grep -- '--remove-tags' "$FX/calls" | sed 's/.*--remove-tags //; s/ --project.*//' | tr ',' '\n' | sort | paste -sd, -)" "sha-a,sha-o"
expect "prune: deletes the skipped and the old image" \
  "$(grep 'images delete' "$FX/calls" | sed 's/.*clinic-api@\(sha256:[a-z]*\).*/\1/' | sort | paste -sd, -)" "sha256:aaa,sha256:ooo"
expect "prune: never deletes the live image" "$(cnt 'sha256:bbb')" 0
expect "prune: never deletes the rollback image" "$(cnt 'images delete.*sha256:ppp')" 0

# first release: the previous revision is the hello image (not in our registry)
new_fx first_release
cat > "$FX/service_before.json" <<'J'
{"status":{"traffic":[{"revisionName":"rev-hello","percent":100},{"revisionName":"rev-b","percent":0,"tag":"sha-b"}]}}
J
cat > "$FX/service_after.json" <<'J'
{"status":{"traffic":[{"revisionName":"rev-b","percent":100,"tag":"sha-b"}]}}
J
cat > "$FX/revision_images.json" <<'J'
{"rev-b":"us-east4-docker.pkg.dev/p/clinic/clinic-api@sha256:bbb","rev-hello":"us-docker.pkg.dev/cloudrun/container/hello"}
J
cat > "$FX/images.json" <<'J'
[{"package":"us-east4-docker.pkg.dev/p/clinic/clinic-api","version":"sha256:bbb"}]
J
export PROMOTE_DIR="$WORK/promoted.2"
bash "$HERE/promote.sh" sha-b >/dev/null 2>&1; bash "$HERE/prune.sh" >/dev/null 2>&1
expect "first release: nothing in our registry is deleted" "$(cnt 'images delete')" 0
expect "first release: keep set tolerates a non-registry previous revision" \
  "$(jq -c '.revisions|sort' "$PROMOTE_DIR/keep.json")" '["rev-b","rev-hello"]'

# prune must not delete anything when no kept digest can be resolved
new_fx unresolvable
cat > "$FX/service_before.json" <<'J'
{"status":{"traffic":[{"revisionName":"rev-x","percent":100,"tag":"sha-x"}]}}
J
cp "$FX/service_before.json" "$FX/service_after.json"
echo '{"rev-x":"us-docker.pkg.dev/cloudrun/container/hello"}' > "$FX/revision_images.json"
echo '[{"package":"us-east4-docker.pkg.dev/p/clinic/clinic-api","version":"sha256:zzz"}]' > "$FX/images.json"
export PROMOTE_DIR="$WORK/promoted.3"
bash "$HERE/promote.sh" sha-x >/dev/null 2>&1; bash "$HERE/prune.sh" >/dev/null 2>&1
expect "prune: refuses to delete images when no kept digest resolves" "$(cnt 'images delete')" 0

# promote when a newer commit exists on main: skipped, no traffic change, prune is a no-op
new_fx superseded
echo '{"status":{"traffic":[]}}' | tee "$FX/service_before.json" > "$FX/service_after.json"
echo '{}' > "$FX/revision_images.json"; echo '[]' > "$FX/images.json"
git commit -q --allow-empty -m newer; git push -q origin main 2>/dev/null
export CIRCLE_SHA1="$HEAD_SHA" PROMOTE_DIR="$WORK/promoted.4"   # an older commit than origin/main
bash "$HERE/promote.sh" sha-old >/dev/null 2>&1; rc=$?
expect "superseded: promote exits 0" "$rc" 0
expect "superseded: state is skipped" "$(cat "$PROMOTE_DIR/state")" skipped
expect "superseded: traffic is not touched" "$(mut 'to-tags')" 0
bash "$HERE/prune.sh" >/dev/null 2>&1
expect "superseded: prune does nothing" "$(mut 'images delete')$(mut 'remove-tags')" "00"


# ---- prune.sh safety: in-flight images, --dry-run, fail closed, superseded self-cleanup -------
prune_fx() { # <name>: B just promoted (live), P the rollback target, A skipped, O old
  new_fx "$1"
  cat > "$FX/service_before.json" <<'J'
{"status":{"traffic":[{"revisionName":"rev-b","percent":100,"tag":"sha-b"},{"revisionName":"rev-p","percent":0,"tag":"sha-p"},
 {"revisionName":"rev-a","percent":0,"tag":"sha-a"},{"revisionName":"rev-o","percent":0,"tag":"sha-o"}]}}
J
  cp "$FX/service_before.json" "$FX/service_after.json"; touch "$FX/promoted"
  jq -n '{"rev-b":"r/clinic-api@sha256:bbb","rev-p":"r/clinic-api@sha256:ppp","rev-a":"r/clinic-api@sha256:aaa","rev-o":"r/clinic-api@sha256:ooo"}' > "$FX/revision_images.json"
  export PROMOTE_DIR="$WORK/pr.$1"; mkdir -p "$PROMOTE_DIR"; echo promoted > "$PROMOTE_DIR/state"
  echo '{"revisions":["rev-b","rev-p"],"current":"rev-b","previous":"rev-p"}' > "$PROMOTE_DIR/keep.json"
  export GOOGLE_PROJECT_ID=p CIRCLE_SHA1="$HEAD_SHA"
  NEWER_SHA="$(git rev-parse HEAD)"; export NEWER_SHA
}
img() { printf '{"package":"us-east4-docker.pkg.dev/p/clinic/clinic-api","version":"%s","tags":"%s"}' "$1" "$2"; }

prune_fx inflight
echo "[$(img sha256:bbb sha-b),$(img sha256:ppp sha-p),$(img sha256:aaa ""),$(img sha256:ooo "sha-${HEAD_SHA:0:7}"),$(img sha256:nnn "sha-${NEWER_SHA:0:7}"),$(img sha256:uuu sha-deadbee)]" > "$FX/images.json"
bash "$HERE/prune.sh" >"$FX/out" 2>&1; rc=$?
expect "prune: a release that is not yet deployed (newer commit) is never deleted" "$(cnt 'sha256:nnn')" 0
expect "prune: a tag for a commit this checkout cannot resolve is never deleted" "$(cnt 'sha256:uuu')" 0
expect "prune: the superseded and old images are still deleted" "$rc:$(grep -c 'images delete' "$FX/calls")" "0:2"
expect "prune: every call names the project" "$(grep -vc -- '--project p' "$FX/calls.all")" 0

prune_fx dry
echo "[$(img sha256:bbb sha-b),$(img sha256:ppp sha-p),$(img sha256:aaa ""),$(img sha256:ooo "sha-${HEAD_SHA:0:7}")]" > "$FX/images.json"
bash "$HERE/prune.sh" --dry-run >"$FX/out" 2>&1; rc=$?
expect "prune --dry-run: exit 0, lists the tag removal and both deletions" "$rc:$(grep -c '^dry-run: would run' "$FX/out")" "0:3"
expect "prune --dry-run: changes nothing" "$([ -e "$FX/calls" ] && echo changed || echo none)" none

prune_fx failclosed
echo "[$(img sha256:bbb sha-b),$(img sha256:aaa sha-a),$(img sha256:ooo sha-o)]" > "$FX/images.json"
touch "$FX/revfail"
bash "$HERE/prune.sh" >"$FX/out" 2>&1; rc=$?
expect "prune: a failing revision lookup exits non-zero" "$([ "$rc" -ne 0 ] && echo failed)" failed
expect "prune: a failing revision lookup deletes nothing and removes no tag" "$([ -e "$FX/calls" ] && echo changed || echo none)" none
rm -f "$FX/revfail"
prune_fx undigested
echo "[$(img sha256:bbb sha-b),$(img sha256:aaa ""),$(img sha256:ooo "")]" > "$FX/images.json"
jq -n '{"rev-b":"r/clinic-api@sha256:bbb","rev-p":"us-east4-docker.pkg.dev/p/clinic/clinic-api:latest","rev-a":"r/clinic-api@sha256:aaa","rev-o":"r/clinic-api@sha256:ooo"}' > "$FX/revision_images.json"
bash "$HERE/prune.sh" >"$FX/out" 2>&1; rc=$?
expect "prune: a kept revision of our image with no digest fails closed (exit 1, says why)" "$rc:$(grep -c 'does not resolve to a digest' "$FX/out")" "1:1"
expect "prune: ...and deletes nothing, removes no tag" "$([ -e "$FX/calls" ] && echo changed || echo none)" none
jq -n '{"rev-b":"r/clinic-api@sha256:bbb","rev-p":"","rev-a":"r/clinic-api@sha256:aaa","rev-o":"r/clinic-api@sha256:ooo"}' > "$FX/revision_images.json"
bash "$HERE/prune.sh" >"$FX/out" 2>&1; rc=$?
expect "prune: a kept revision that reports no image fails closed (exit 1)" "$rc:$(grep -c 'reports no image' "$FX/out")" "1:1"
expect "prune: ...and deletes nothing" "$([ -e "$FX/calls" ] && echo changed || echo none)" none
bash "$HERE/prune.sh" --bogus >/dev/null 2>&1
expect "prune: an unknown flag is a usage error (exit 2)" "$?" 2

new_fx selfclean
cat > "$FX/service_before.json" <<'J'
{"status":{"traffic":[{"revisionName":"rev-p","percent":100,"tag":"sha-p"},{"revisionName":"rev-q","percent":0,"tag":"sha-q"},
 {"revisionName":"rev-x","percent":0,"tag":"sha-abcdef1"}]}}
J
cp "$FX/service_before.json" "$FX/service_after.json"
jq -n '{"rev-p":"r/clinic-api@sha256:ppp","rev-q":"r/clinic-api@sha256:qqq","rev-x":"r/clinic-api@sha256:xxx"}' > "$FX/revision_images.json"
export PROMOTE_DIR="$WORK/pr.selfclean"; mkdir -p "$PROMOTE_DIR"; echo skipped > "$PROMOTE_DIR/state"
export GOOGLE_PROJECT_ID=p CIRCLE_SHA1=abcdef1234567890abcdef1234567890abcdef12
bash "$HERE/prune.sh" >"$FX/out" 2>&1; rc=$?
expect "prune (superseded): removes only its own tag" "$rc:$(grep -c 'remove-tags sha-abcdef1 ' "$FX/calls")" "0:1"
expect "prune (superseded): deletes only its own image" "$(grep 'images delete' "$FX/calls" | sed 's/.*clinic-api@\(sha256:[a-z]*\).*/\1/' | paste -sd, -)" "sha256:xxx"
expect "prune (superseded): never touches the serving or the rollback image" "$(cnt 'sha256:ppp')$(cnt 'sha256:qqq')" 00
new_fx selfclean_same
cp "$WORK/fx.selfclean/service_before.json" "$FX/service_before.json"; cp "$FX/service_before.json" "$FX/service_after.json"
jq -n '{"rev-p":"r/clinic-api@sha256:ppp","rev-q":"r/clinic-api@sha256:qqq","rev-x":"r/clinic-api@sha256:ppp"}' > "$FX/revision_images.json"
bash "$HERE/prune.sh" >/dev/null 2>&1
expect "prune (superseded): an own image the serving revision also runs is kept" "$(cnt 'images delete')$(cnt 'remove-tags sha-abcdef1 ')" "01"
dry="$(bash "$HERE/prune.sh" --dry-run 2>&1 | grep -c '^dry-run: would run')"
expect "prune (superseded) --dry-run: only says what it would do" "$dry$(cnt 'images delete')" "10"
unset NEWER_SHA

# =========================================================================================
# require_head.sh
# =========================================================================================
new_fx head
export CIRCLE_SHA1="$(git rev-parse origin/main)"
bash "$HERE/require_head.sh" >/dev/null 2>&1; rc=$?
expect "require_head: head of main continues" "$rc$( [ -f "$FX/agent" ] && echo H)" 0
export CIRCLE_SHA1="$HEAD_SHA"
bash "$HERE/require_head.sh" >/dev/null 2>&1
expect "require_head: superseded commit halts" "$([ -f "$FX/agent" ] && echo halted)" halted
new_fx head_fail
git remote set-url origin "$WORK/does-not-exist.git"
export CIRCLE_SHA1="$HEAD_SHA"
bash "$HERE/require_head.sh" >/dev/null 2>&1; rc=$?
expect "require_head: fails closed when main cannot be fetched" "$([ "$rc" -ne 0 ] && echo failed)" failed
git remote set-url origin "$WORK/origin.git"

# =========================================================================================
# skip_unless_changed.sh
# =========================================================================================
git checkout -q -b feature origin/main 2>/dev/null
mkdir -p web backend; echo w > web/w.txt; git add web; git commit -q -m web
export CIRCLE_BRANCH=feature

new_fx skip_changed
bash "$HERE/skip_unless_changed.sh" web/ >/dev/null 2>&1
expect "skip: runs when a watched path changed" "$([ -f "$FX/agent" ] && echo halted || echo ran)" ran
new_fx skip_unchanged
bash "$HERE/skip_unless_changed.sh" backend/ >/dev/null 2>&1
expect "skip: halts when nothing watched changed" "$([ -f "$FX/agent" ] && echo halted || echo ran)" halted
new_fx skip_main
CIRCLE_BRANCH=main bash "$HERE/skip_unless_changed.sh" backend/ >/dev/null 2>&1
expect "skip: never skips on main" "$([ -f "$FX/agent" ] && echo halted || echo ran)" ran
new_fx skip_fetch_fail
git remote set-url origin "$WORK/does-not-exist.git"
bash "$HERE/skip_unless_changed.sh" backend/ >/dev/null 2>&1
expect "skip: fails CLOSED (runs the job) when main cannot be fetched" "$([ -f "$FX/agent" ] && echo halted || echo ran)" ran
git remote set-url origin "$WORK/origin.git"

# =========================================================================================
# vercel_env_check.sh: names only, per app and environment; a gap refuses the ship.
# =========================================================================================
cat > "$WORK/bin/vercel" <<'FAKE'
#!/usr/bin/env bash
[ "${1:-}" = "api" ] || { echo "fake vercel: unhandled: $*" >&2; exit 99; }
[ -f "$FX/denied" ] && { echo "Error: Not authorized" >&2; exit 1; }
case "${2:-}" in *until=*) f="$FX/env_json_2" ;; *) f="$FX/env_json" ;; esac
cat "$f"
exit "$(cat "$FX/rc" 2>/dev/null || echo 0)"
FAKE
chmod +x "$WORK/bin/vercel"
# env_table <target> [hidden] <name...>: a Vercel env API body with a value that must never leak.
env_table() {
  local target="$1" hidden="$2"; shift 2
  # OUT picks the page file (default page 1); NEXT, when set, is this page's pagination.next.
  python3 - "$target" "$hidden" "${NEXT:-}" "$@" <<'PY' > "${OUT:-$FX/env_json}"
import json, sys
target, hidden, nxt, names = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4:]
t = ["production", "preview", "development"] if target == "all" else [target]
body = {"envs": [{"key": n, "target": t, "type": "plain", "value": "SECRET-VALUE-MUST-NOT-LEAK"} for n in names], "hiddenProductionEnvCount": hidden}
if nxt:
    body["pagination"] = {"count": len(names), "next": int(nxt)}
print("Vercel CLI 59.5.0\n" + json.dumps(body))
PY
}
ALL="BETTER_AUTH_URL BETTER_AUTH_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET INTERNAL_SIGNING_KEY API_URL API_AUDIENCE GCP_PROJECT_NUMBER GCP_SERVICE_ACCOUNT_EMAIL GCP_WORKLOAD_IDENTITY_POOL_ID GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID ADMIN_EMAILS"
# The names only the booking app needs (it sends the email and runs the reminder cron).
BOOKING_ONLY="RESEND_API_KEY CRON_SECRET"

new_fx env_ok
env_table production 0 $ALL OTHER
out="$(bash "$HERE/vercel_env_check.sh" admin production 2>&1)"; rc=$?
expect "env check: passes when every name is set for production" "$rc" 0
expect "env check: never prints a value" "$(grep -c SECRET-VALUE-MUST-NOT-LEAK <<<"$out")" 0

new_fx env_missing
env_table production 0 BETTER_AUTH_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET INTERNAL_SIGNING_KEY API_URL
out="$(bash "$HERE/vercel_env_check.sh" admin production 2>&1)"; rc=$?
expect "env check: refuses when a name is missing" "$([ "$rc" -ne 0 ] && echo refused)" refused
expect "env check: names the missing variable" "$(grep -c 'BETTER_AUTH_URL' <<<"$out")" 1
expect "env check: a failure never prints a value" "$(grep -c SECRET-VALUE-MUST-NOT-LEAK <<<"$out")" 0

new_fx env_none
env_table production 0
bash "$HERE/vercel_env_check.sh" admin production >/dev/null 2>&1; rc=$?
expect "env check: refuses an empty project (the 2026-10 admin outage)" "$([ "$rc" -ne 0 ] && echo refused)" refused

new_fx env_wrong_target
env_table preview 0 $ALL
bash "$HERE/vercel_env_check.sh" booking production >/dev/null 2>&1; rc=$?
expect "env check: a Preview-only value does not satisfy production" "$([ "$rc" -ne 0 ] && echo refused)" refused

new_fx env_all_envs
env_table all 0 $ALL $BOOKING_ONLY
bash "$HERE/vercel_env_check.sh" booking production >/dev/null 2>&1; rc=$?
expect "env check: All Environments counts" "$rc" 0

new_fx env_booking_no_resend
env_table production 0 $ALL CRON_SECRET
out="$(bash "$HERE/vercel_env_check.sh" booking production 2>&1)"; rc=$?
expect "env check: booking needs RESEND_API_KEY" "$([ "$rc" -ne 0 ] && echo refused)" refused
expect "env check: names RESEND_API_KEY as the missing one" "$(grep -c 'RESEND_API_KEY' <<<"$out")" 1
expect "env check: a missing-name failure never prints a value" "$(grep -c SECRET-VALUE-MUST-NOT-LEAK <<<"$out")" 0

new_fx env_booking_no_cron
env_table production 0 $ALL RESEND_API_KEY
out="$(bash "$HERE/vercel_env_check.sh" booking production 2>&1)"; rc=$?
expect "env check: booking needs CRON_SECRET" "$([ "$rc" -ne 0 ] && echo refused)" refused
expect "env check: names CRON_SECRET as the missing one" "$(grep -c 'CRON_SECRET' <<<"$out")" 1

new_fx env_booking_ok
env_table production 0 $ALL $BOOKING_ONLY
bash "$HERE/vercel_env_check.sh" booking production >/dev/null 2>&1; rc=$?
expect "env check: booking passes with the email names set" "$rc" 0

new_fx env_admin_without_email_names
env_table production 0 $ALL
bash "$HERE/vercel_env_check.sh" admin production >/dev/null 2>&1; rc=$?
expect "env check: admin does not need the email names" "$rc" 0

new_fx env_hidden
env_table production 2 $ALL
out="$(bash "$HERE/vercel_env_check.sh" admin production 2>&1)"; rc=$?
expect "env check: fails closed when variables are hidden from the token" "$([ "$rc" -ne 0 ] && echo refused)" refused
expect "env check: says how many are hidden" "$(grep -c '2 production variables are hidden' <<<"$out")" 1

new_fx env_garbage
printf 'Error: something odd\n' > "$FX/env_json"
out="$(bash "$HERE/vercel_env_check.sh" admin production 2>&1)"; rc=$?
expect "env check: unreadable response fails closed" "$([ "$rc" -ne 0 ] && echo refused)" refused
expect "env check: unreadable response says what the CLI said" "$(grep -c 'something odd' <<<"$out")" 1

new_fx env_err_body
printf '%s\n' '{"error":{"code":"forbidden","message":"Not authorized for this project"},"envs":[{"key":"X","value":"SECRET-VALUE-MUST-NOT-LEAK"}]}' > "$FX/env_json"
echo 1 > "$FX/rc"
out="$(bash "$HERE/vercel_env_check.sh" admin production 2>&1)"; rc=$?
expect "env check: an API error prints code and message only" "$(grep -c 'forbidden: Not authorized for this project' <<<"$out")" 1
expect "env check: a value-bearing error body never leaks" "$(grep -c SECRET-VALUE-MUST-NOT-LEAK <<<"$out")" 0
expect "env check: an API error body fails closed" "$([ "$rc" -ne 0 ] && echo refused)" refused

new_fx env_err_plain
printf '%s\n' 'something went wrong with SECRET-VALUE-MUST-NOT-LEAK in the body' > "$FX/env_json"
out="$(bash "$HERE/vercel_env_check.sh" admin production 2>&1)"; rc=$?
expect "env check: non-JSON output is reported by size, never echoed" "$(grep -c 'unreadable response (' <<<"$out")" 1
expect "env check: non-JSON output never leaks" "$(grep -c SECRET-VALUE-MUST-NOT-LEAK <<<"$out")" 0

new_fx env_rc
env_table production 0 $ALL
echo 1 > "$FX/rc"
bash "$HERE/vercel_env_check.sh" admin production >/dev/null 2>&1; rc=$?
expect "env check: a non-zero CLI exit means cannot verify even when the body parses" "$([ "$rc" -ne 0 ] && echo refused)" refused

new_fx env_pages_ok
FIRST="${ALL%% GCP_SERVICE_ACCOUNT_EMAIL*}"; SECOND="GCP_SERVICE_ACCOUNT_EMAIL ${ALL#*GCP_SERVICE_ACCOUNT_EMAIL }"
NEXT=111 env_table production 0 $FIRST
OUT="$FX/env_json_2" env_table production 0 $SECOND
out="$(bash "$HERE/vercel_env_check.sh" admin production 2>&1)"; rc=$?
expect "env check: names split over two pages are merged" "$rc" 0

new_fx env_pages_missing
NEXT=111 env_table production 0 $FIRST
OUT="$FX/env_json_2" env_table production 0 GCP_SERVICE_ACCOUNT_EMAIL
out="$(bash "$HERE/vercel_env_check.sh" admin production 2>&1)"; rc=$?
expect "env check: a name missing from every page still refuses" "$([ "$rc" -ne 0 ] && echo refused)" refused
expect "env check: names a variable that is on neither page" "$(grep -c 'ADMIN_EMAILS' <<<"$out")" 1

new_fx env_malformed
printf '%s\n' '{"envs":[{"target":["production"],"value":"SECRET-VALUE-MUST-NOT-LEAK"}],"hiddenProductionEnvCount":0}' > "$FX/env_json"
out="$(bash "$HERE/vercel_env_check.sh" admin production 2>&1)"; rc=$?
expect "env check: a record without a key is rejected with a clear message" "$(grep -c 'malformed variable record' <<<"$out")" 1
expect "env check: a malformed record never leaks or tracebacks" "$(grep -cE 'SECRET-VALUE-MUST-NOT-LEAK|Traceback' <<<"$out")" 0

new_fx env_noproject
out="$(env -u VERCEL_PROJECT_ID bash "$HERE/vercel_env_check.sh" admin production 2>&1)"; rc=$?
expect "env check: a missing VERCEL_PROJECT_ID is a clear failure" "$([ "$rc" -ne 0 ] && grep -c 'set VERCEL_PROJECT_ID' <<<"$out")" 1

new_fx env_denied
touch "$FX/denied"
out="$(bash "$HERE/vercel_env_check.sh" booking production 2>&1)"; rc=$?
expect "env check: fails closed when the listing is refused" "$([ "$rc" -ne 0 ] && echo refused)" refused

# =========================================================================================
# not_configured_smoke.sh: refuses to run an app whose directory holds an .env file, because
# `next start` would load it and the test would report a false FAIL. Never moves the file.
# =========================================================================================
new_fx smoke_env
mkdir -p "$WORK/smoke/admin" "$WORK/smoke/booking"
: > "$WORK/smoke/admin/.env.local"        # a fixture in a temp dir, not a real env file
: > "$WORK/smoke/booking/.env.production"
out="$(APPS_DIR="$WORK/smoke" bash "$HERE/not_configured_smoke.sh" 2>&1)"; rc=$?
expect "smoke: refuses (non-zero) when apps hold .env files" "$([ "$rc" -ne 0 ] && echo refused)" refused
expect "smoke: names the admin file to move aside" "$(grep -c 'admin/.env.local exists' <<<"$out")" 1
expect "smoke: names the booking file to move aside" "$(grep -c 'booking/.env.production exists' <<<"$out")" 1
expect "smoke: leaves the developer's files in place" "$([ -e "$WORK/smoke/admin/.env.local" ] && [ -e "$WORK/smoke/booking/.env.production" ] && echo kept)" kept
expect "smoke: does not start a server for a refused app" "$(grep -c 'did not start' <<<"$out")" 0

# =========================================================================================
# scripts/ops/kill_switch.sh against a stateful fake gcloud (its own bin dir, so the fakes above
# stay untouched). Policies live in $FX/policy.<svc>.json and are really edited by the fake.
# =========================================================================================
KS="$HERE/../ops/kill_switch.sh"
mkdir -p "$WORK/ksbin"
cat > "$WORK/ksbin/gcloud" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$FX/ks.calls"
svc="$4"
pf="$FX/policy.$svc.json"
case "$*" in
  "run services describe"*)
    [ -f "$FX/missing.$svc" ] && { echo "ERROR: Cannot find service [$svc]" >&2; exit 1; }
    echo "$svc" ;;
  "run services get-iam-policy"*) cat "$pf" ;;
  "run services remove-iam-policy-binding"*)
    m="$(sed -n 's/.*--member=\([^ ]*\).*/\1/p' <<<"$*")"
    jq --arg m "$m" '.etag="changed" | .bindings |= map(.members |= map(select(. != $m))) | .bindings |= map(select((.members|length) > 0))' "$pf" > "$pf.n" && mv "$pf.n" "$pf" ;;
  "run services add-iam-policy-binding"*)
    m="$(sed -n 's/.*--member=\([^ ]*\).*/\1/p' <<<"$*")"
    jq --arg m "$m" '.etag="changed2" | if any(.bindings[]; .role=="roles/run.invoker") then .bindings |= map(if .role=="roles/run.invoker" then .members += [$m] else . end) else .bindings += [{role:"roles/run.invoker",members:[$m]}] end' "$pf" > "$pf.n" && mv "$pf.n" "$pf" ;;
  *) echo "fake gcloud (kill switch): unhandled: $*" >&2; exit 99 ;;
esac
FAKE
chmod +x "$WORK/ksbin/gcloud"
P=sil-clinic-booking
WEB="serviceAccount:clinic-web@$P.iam.gserviceaccount.com"
ADM="serviceAccount:clinic-admin@$P.iam.gserviceaccount.com"
SMK="serviceAccount:clinic-smoke@$P.iam.gserviceaccount.com"
ks_setup() { # <name>
  new_fx "ks.$1"
  for svc in clinic-api clinic-realtime; do
    jq -n --arg w "$WEB" --arg a "$ADM" --arg s "$SMK" \
      '{etag:"orig",bindings:[{role:"roles/run.invoker",members:[$w,$a,$s]},{role:"roles/run.admin",members:["user:eng@example.com"]}]}' > "$FX/policy.$svc.json"
  done
  export KILL_SWITCH_STATE="$WORK/ks-state.$1.json"; rm -f "$KILL_SWITCH_STATE" "$KILL_SWITCH_STATE.restored"
}
ks() { PATH="$WORK/ksbin:$PATH" bash "$KS" "$@"; }
inv() { jq -r '[.bindings[]|select(.role=="roles/run.invoker")|.members[]]|sort|join(",")' "$FX/policy.$1.json"; }
SORTED_ALL="$(printf '%s\n' "$ADM" "$SMK" "$WEB" | sort | paste -sd, -)"

ks_setup dry
ks >"$FX/out" 2>&1; rc=$?
expect "kill_switch: default is a dry run (exit 0)" "$rc" 0
expect "kill_switch: dry run makes no mutating call" "$(grep -c 'iam-policy-binding' "$FX/ks.calls")" 0
expect "kill_switch: dry run names the bindings it would remove" "$(grep -c '^kill: remove' "$FX/out")" 4
expect "kill_switch: dry run writes no state" "$([ -e "$KILL_SWITCH_STATE" ] && echo wrote || echo none)" none
expect "kill_switch: every gcloud call names the project and region" \
  "$(grep -vc -- '--project sil-clinic-booking' "$FX/ks.calls")$(grep -vc -- '--region us-east4' "$FX/ks.calls")" 00

ks_setup apply
cp "$FX/policy.clinic-api.json" "$FX/before.api"; cp "$FX/policy.clinic-realtime.json" "$FX/before.rt"
ks --apply >"$FX/out" 2>&1; rc=$?
expect "kill_switch --apply: exit 0" "$rc" 0
expect "kill_switch --apply: clinic-api keeps only clinic-smoke" "$(inv clinic-api)" "$SMK"
expect "kill_switch --apply: clinic-realtime keeps only clinic-smoke" "$(inv clinic-realtime)" "$SMK"
expect "kill_switch --apply: other roles untouched" "$(jq -r '[.bindings[]|select(.role=="roles/run.admin")|.members[]]|join(",")' "$FX/policy.clinic-api.json")" "user:eng@example.com"
expect "kill_switch --apply: prior state recorded before the first removal" \
  "$(jq -r '.snapshots["clinic-api"].etag' "$KILL_SWITCH_STATE")" orig
expect "kill_switch --apply: four removals" "$(grep -c 'remove-iam-policy-binding' "$FX/ks.calls")" 4
expect "kill_switch --apply: a second kill while a record exists is refused (exit 2)" "$(ks --apply >/dev/null 2>&1; echo $?)" 2
expect "kill_switch --restore (no --apply) is a dry run" "$(ks --restore >/dev/null 2>&1; echo "$?:$(inv clinic-api)")" "0:$SMK"
ks --restore --apply >"$FX/out" 2>&1; rc=$?
expect "kill_switch --restore --apply: exit 0" "$rc" 0
expect "kill_switch --restore: clinic-api invoker members exactly as before" "$(inv clinic-api)" "$SORTED_ALL"
expect "kill_switch --restore: clinic-realtime invoker members exactly as before" "$(inv clinic-realtime)" "$SORTED_ALL"
expect "kill_switch --restore: other roles still intact" "$(jq -r '[.bindings[]|select(.role=="roles/run.admin")|.members[]]|join(",")' "$FX/policy.clinic-api.json")" "user:eng@example.com"
expect "kill_switch --restore: the state file is retired" "$([ -e "$KILL_SWITCH_STATE" ] && echo kept || echo moved)$([ -e "$KILL_SWITCH_STATE.restored" ] && echo +restored)" "moved+restored"
expect "kill_switch --restore: with no record it refuses (exit 2)" "$(ks --restore --apply >/dev/null 2>&1; echo $?)" 2

ks_setup missing
touch "$FX/missing.clinic-realtime"
ks --apply >"$FX/out" 2>&1; rc=$?
expect "kill_switch: a missing clinic-realtime is skipped (exit 0)" "$rc" 0
expect "kill_switch: clinic-api still killed when clinic-realtime is missing" "$(inv clinic-api)" "$SMK"
expect "kill_switch: nothing is run against the missing service" "$(grep -c 'iam-policy.* clinic-realtime\|iam-policy-binding clinic-realtime' "$FX/ks.calls")" 0

ks_setup again
ks --apply >/dev/null 2>&1; rm -f "$KILL_SWITCH_STATE"
ks --apply >"$FX/out" 2>&1; rc=$?
expect "kill_switch: nothing left to remove is exit 0 and writes no state" "$rc$([ -e "$KILL_SWITCH_STATE" ] && echo wrote)" 0

ks_setup wrongproj
ks --project other-project --apply >/dev/null 2>&1; rc=$?
expect "kill_switch: a wrong --project is refused (exit 2)" "$rc" 2
ks --region europe-west1 --apply >/dev/null 2>&1
expect "kill_switch: a wrong --region is refused (exit 2)" "$?" 2
ks --mode scale --apply >/dev/null 2>&1
expect "kill_switch: --mode scale is refused, not half-implemented (exit 2)" "$?" 2
expect "kill_switch: refusals make no gcloud call at all" "$([ -e "$FX/ks.calls" ] && echo called || echo none)" none
ks_setup cond
jq '.bindings[0].condition={title:"t",expression:"true"}' "$FX/policy.clinic-api.json" > "$FX/c.json" && mv "$FX/c.json" "$FX/policy.clinic-api.json"
ks --apply >/dev/null 2>&1
expect "kill_switch: a conditional invoker binding is refused (exit 2) before any removal" "$?:$(grep -c 'remove-iam' "$FX/ks.calls")" "2:0"

# =========================================================================================
# zap_prod_baseline.sh with a fake docker: the exit-code mapping, the passive baseline, the
# pinned digest shared with the PR DAST job, and the rules file.
# =========================================================================================
cat > "$WORK/bin/fakedocker" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$FX/docker.calls"
exit "$(cat "$FX/docker.exit")"
FAKE
chmod +x "$WORK/bin/fakedocker"
export ZAP_DOCKER="$WORK/bin/fakedocker"
for pair in "0:0" "2:0" "1:1" "3:1"; do
  new_fx "zap$pair"; echo "${pair%%:*}" > "$FX/docker.exit"
  bash "$HERE/zap_prod_baseline.sh" >/dev/null 2>&1; rc=$?
  expect "zap prod: ZAP exit ${pair%%:*} gives job exit ${pair##*:}" "$rc" "${pair##*:}"
done
expect "zap prod: runs zap-baseline.py (passive), never the active or API scan" \
  "$(grep -c 'zap-baseline.py' "$FX/docker.calls")$(grep -cE 'zap-full-scan|zap-api-scan|-a( |$)' "$FX/docker.calls")" 10
expect "zap prod: uses the shared rules file and a bounded spider" "$(grep -c -- '-c rules.tsv -m 1 -T 3' "$FX/docker.calls")" 1
expect "zap prod: targets the public web URL over https" "$(grep -c -- '-t https://' "$FX/docker.calls")" 1
zap_digest="$(sed -n 's/^ZAP_IMAGE=.*@\(sha256:[0-9a-f]*\)".*/\1/p' "$HERE/zap_prod_baseline.sh")"
expect "zap prod: pinned by digest, the dast job in the CI config uses the same digest" \
  "$(grep -c "zaproxy@$zap_digest" "$HERE/../../.circleci/config.yml")" 1
unset ZAP_DOCKER

# =========================================================================================
# deny_probe.sh against a local stand-in server (the Google STS endpoint and the Cloud Run
# front end are third parties; the stand-in answers like them: 403/401 and an STS rejection).
# =========================================================================================
cat > "$WORK/stub.py" <<'PY'
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
MODE = sys.argv[2]
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        code = 200 if MODE == "open" else (401 if self.headers.get("X-Serverless-Authorization") else 403)
        self.send_response(code); self.end_headers()
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if MODE == "open":
            self.send_response(200); self.end_headers(); self.wfile.write(json.dumps({"access_token": "ya29.SECRETSECRETSECRETSECRET"}).encode()); return
        self.send_response(403); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(json.dumps({"error": "unauthorized_client", "error_description": "rejected by the attribute condition for projects/291652953712 token abcdefghijklmnopqrstuvwxyz0123"}).encode())
srv = HTTPServer(("127.0.0.1", int(sys.argv[1])), H)
open(sys.argv[3], "w").write(str(srv.server_port))  # tells the test it is listening
srv.serve_forever()
PY
# The stand-in listens on a free port the kernel picks and tells the test through a FIFO once it is
# listening, so two runs of this suite on one machine cannot collide and nothing polls or sleeps.
start_stub() { # <mode>: sets STUB_PORT
  rm -f "$WORK/stub.fifo"; mkfifo "$WORK/stub.fifo"
  python3 "$WORK/stub.py" 0 "$1" "$WORK/stub.fifo" >/dev/null 2>&1 & echo $! > "$WORK/stub.pid"
  STUB_PORT="$(timeout 30 cat "$WORK/stub.fifo")"
  [ -n "$STUB_PORT" ] || { echo "stand-in server did not start"; exit 1; }
}
stop_stub() { kill "$(cat "$WORK/stub.pid")" 2>/dev/null; wait "$(cat "$WORK/stub.pid")" 2>/dev/null; }
new_fx probe; OUT="$WORK/probe.out"
start_stub deny
PROBE_RUN_APP_URL=http://127.0.0.1:$STUB_PORT bash "$HERE/deny_probe.sh" run-app "$OUT.runapp" >/dev/null 2>&1; rc=$?
expect "deny_probe run-app: 403 anonymous and 401 junk bearer pass" "$rc:$(grep -c 'result=PASS' "$OUT.runapp")" "0:2"
CIRCLE_OIDC_TOKEN_V2=eyJhbGciOi.fake.jwt PROBE_STS_URL=http://127.0.0.1:$STUB_PORT/v1/token bash "$HERE/deny_probe.sh" wif "$OUT.wif" >/dev/null 2>&1; rc=$?
expect "deny_probe wif: a rejected exchange passes" "$rc:$(grep -c 'result=PASS' "$OUT.wif")" "0:1"
expect "deny_probe wif: project number and long opaque strings are redacted" \
  "$(grep -c '291652953712\|abcdefghijklmnopqrstuvwxyz' "$OUT.wif")$(grep -c '\[redacted\]' "$OUT.wif")" 01
expect "deny_probe wif: the OIDC token is never written" "$(grep -c 'eyJhbGciOi' "$OUT.wif")" 0
stop_stub
start_stub open
PROBE_RUN_APP_URL=http://127.0.0.1:$STUB_PORT bash "$HERE/deny_probe.sh" run-app "$OUT.open" >/dev/null 2>&1; rc=$?
expect "deny_probe run-app: an open service FAILS the probe" "$rc:$(grep -c 'result=FAIL' "$OUT.open")" "1:2"
CIRCLE_OIDC_TOKEN_V2=eyJhbGciOi.fake.jwt PROBE_STS_URL=http://127.0.0.1:$STUB_PORT/v1/token bash "$HERE/deny_probe.sh" wif "$OUT.wifopen" >/dev/null 2>&1; rc=$?
expect "deny_probe wif: an issued access token FAILS the probe" "$rc:$(grep -c 'observed=ISSUED' "$OUT.wifopen")" "1:1"
expect "deny_probe wif: an issued token is not written to the record" "$(grep -c 'SECRETSECRET' "$OUT.wifopen")" 0
stop_stub
env -u GOOGLE_PROJECT_ID -u GOOGLE_PROJECT_NUMBER -u DEPLOYER_SA -u PUBLIC_BASE_URL -u VERCEL_TOKEN -u VERCEL_ORG_ID -u VERCEL_PROJECT_ID \
  bash "$HERE/deny_probe.sh" context "$OUT.ctx" >/dev/null 2>&1; rc=$?
expect "deny_probe context: no deploy variables in the job passes" "$rc" 0
env -u VERCEL_ORG_ID GOOGLE_PROJECT_ID=x bash "$HERE/deny_probe.sh" context "$OUT.ctx2" >/dev/null 2>&1; rc=$?
expect "deny_probe context: a leaked deploy variable fails" "$rc:$(grep -c 'context-var-GOOGLE_PROJECT_ID.*result=FAIL' "$OUT.ctx2")" "1:1"
bash "$HERE/deny_probe.sh" bogus "$OUT.x" >/dev/null 2>&1
expect "deny_probe: an unknown mode is a usage error (exit 2)" "$?" 2

# =========================================================================================
# lighthouse.sh must not leave its `next start` running. A fake server (a shell that starts a
# python child, like pnpm -> next -> server) stands in for the app; LH_RUN_CMD stands in for lhci.
# =========================================================================================
cat > "$WORK/fakeapp.sh" <<'FAKE'
#!/usr/bin/env bash
# a process tree: this shell -> python server (answers 200 to everything)
python3 "$(dirname "$0")/fakeapp.py" "$1" &
wait
FAKE
cat > "$WORK/fakeapp.py" <<'PY'
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self): self.send_response(200); self.end_headers()
HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
LHP="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"  # a free port, not a fixed one
lh_run() { # <name> <runner command> ; leaves the exit code in $rc
  # CIRCLE_BRANCH=main on purpose. Earlier tests export CIRCLE_BRANCH=feature, and on a branch with no
  # changes under the watched paths lighthouse.sh skips itself and exits 0: these cases then failed
  # (got 0, want 3) only when the checkout equalled main, i.e. on the release pipeline.
  CIRCLE_BRANCH=main LH_PORT=$LHP LH_CHROME_PATH=/bin/sh LHCI_OUTPUT_DIR="$WORK/lh-out.$1" \
    LH_SERVER_CMD="bash $WORK/fakeapp.sh $LHP" LH_RUN_CMD="$2" \
    bash "$HERE/lighthouse.sh" >"$WORK/lh.$1.log" 2>&1; rc=$?
}
gone() { # no process of the fake app is left, and its port is closed
  local n; n="$(pgrep -f "$WORK/fakeapp" 2>/dev/null | wc -l | tr -d ' ')"
  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$LHP/"; then echo "port-open"; else echo "closed:$n"; fi
}
# a skip must say so, and must not start anything (watch list pointed at a path nothing changes)
CIRCLE_BRANCH=feature LH_WATCH=no/such/path LH_PORT=$LHP LH_CHROME_PATH=/bin/sh LHCI_OUTPUT_DIR="$WORK/lh-out.skip" \
  LH_SERVER_CMD="bash $WORK/fakeapp.sh $LHP" LH_RUN_CMD="exit 3" bash "$HERE/lighthouse.sh" >"$WORK/lh.skip.log" 2>&1; rc=$?
expect "lighthouse: a branch with no changes under the watched paths skips, says so, and starts no server" \
  "$rc:$(grep -c 'skipping Lighthouse' "$WORK/lh.skip.log"):$(gone)" "0:1:closed:0"
lh_run ok "curl -sf http://127.0.0.1:$LHP/about >/dev/null"
expect "lighthouse: the runner saw the server while it ran, exit 0" "$rc" 0
expect "lighthouse: no server process or listener is left after a normal exit" "$(gone)" "closed:0"
lh_run fail "curl -sf http://127.0.0.1:$LHP/ >/dev/null; exit 3"
expect "lighthouse: a failing runner's exit code is the script's exit code" "$rc" 3
expect "lighthouse: no server process or listener is left after a failure" "$(gone)" "closed:0"

# =========================================================================================
# install_gitleaks.sh: pinned checksum, one retry, cache. A fake curl stands in for GitHub
# (third party); the tarball is a real gzip of a tiny `gitleaks`.
# =========================================================================================
GLW="$WORK/gl"; mkdir -p "$GLW/src"
printf '#!/bin/sh\necho "gitleaks version fake"\n' > "$GLW/src/gitleaks"; chmod +x "$GLW/src/gitleaks"
tar -czf "$GLW/good.tgz" -C "$GLW/src" gitleaks
GL_SHA="$( (sha256sum "$GLW/good.tgz" 2>/dev/null || shasum -a 256 "$GLW/good.tgz") | cut -d' ' -f1)"
printf '<html>502 Bad Gateway</html>' > "$GLW/bad.html"
cat > "$WORK/bin/curl-gl" <<'FAKE'
#!/usr/bin/env bash
# serves $GLW/answers in order: "good" | "bad" | "fail"; counts calls
n=$(( $(cat "$GLW/calls" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$GLW/calls"
ans="$(sed -n "${n}p" "$GLW/answers")"
out=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done
case "$ans" in
  good) cp "$GLW/good.tgz" "$out" ;;
  bad) cp "$GLW/bad.html" "$out" ;;
  *) exit 22 ;;
esac
FAKE
chmod +x "$WORK/bin/curl-gl"
mkdir -p "$WORK/glbin"; ln -sf "$WORK/bin/curl-gl" "$WORK/glbin/curl"
export GLW
gl_run() { # <name> <answers...>: runs the installer in a fresh dir with a fresh cache
  GLD="$WORK/gl.$1"; rm -rf "$GLD"; mkdir -p "$GLD/cache" "$GLD/cwd"; shift
  : > "$GLW/answers"; for a in "$@"; do echo "$a" >> "$GLW/answers"; done; rm -f "$GLW/calls"
  ( cd "$GLD/cwd" && PATH="$WORK/glbin:$PATH" GITLEAKS_SHA256="$GL_SHA" GITLEAKS_URL=https://example.invalid/g.tgz \
      GITLEAKS_CACHE="$GLD/cache" GITLEAKS_RETRY_SLEEP=0 bash "$HERE/install_gitleaks.sh" ) >"$GLD/out" 2>&1; rc=$?
}
gl_calls() { cat "$GLW/calls" 2>/dev/null || echo 0; }
gl_run ok good
expect "gitleaks install: a verified download installs the binary" "$rc:$(grep -c 'gitleaks version fake' "$GLD/out"):$(gl_calls)" "0:1:1"
gl_run retry bad good
expect "gitleaks install: a bad first download is retried once and then succeeds" "$rc:$(gl_calls):$(grep -c 'retrying once' "$GLD/out")" "0:2:1"
gl_run retryfail fail good
expect "gitleaks install: a failed first download is retried once" "$rc:$(gl_calls)" "0:2"
gl_run bothbad bad bad good
expect "gitleaks install: two bad downloads fail with a clear message and never try a third time" \
  "$rc:$(gl_calls):$(grep -c "expected sha256 $GL_SHA" "$GLD/out")" "1:2:2"
expect "gitleaks install: ...and nothing is installed" "$([ -e "$GLD/cwd/gitleaks" ] && echo installed || echo none)" none
expect "gitleaks install: ...and the bad file is not left in the cache" "$([ -e "$GLD/cache/gitleaks_8.30.1_linux_x64.tar.gz" ] && echo cached || echo clean)" clean
# cache hit: no download at all
GLD="$WORK/gl.hit"; rm -rf "$GLD"; mkdir -p "$GLD/cache" "$GLD/cwd"; cp "$GLW/good.tgz" "$GLD/cache/gitleaks_8.30.1_linux_x64.tar.gz"
: > "$GLW/answers"; rm -f "$GLW/calls"
( cd "$GLD/cwd" && PATH="$WORK/glbin:$PATH" GITLEAKS_SHA256="$GL_SHA" GITLEAKS_CACHE="$GLD/cache" bash "$HERE/install_gitleaks.sh" ) >"$GLD/out" 2>&1; rc=$?
expect "gitleaks install: a verified cached tarball needs no download" "$rc:$(gl_calls)" "0:0"
# a corrupted cache entry is discarded and downloaded again
GLD="$WORK/gl.corrupt"; rm -rf "$GLD"; mkdir -p "$GLD/cache" "$GLD/cwd"; cp "$GLW/bad.html" "$GLD/cache/gitleaks_8.30.1_linux_x64.tar.gz"
printf 'good\n' > "$GLW/answers"; rm -f "$GLW/calls"
( cd "$GLD/cwd" && PATH="$WORK/glbin:$PATH" GITLEAKS_SHA256="$GL_SHA" GITLEAKS_URL=https://example.invalid/g.tgz GITLEAKS_CACHE="$GLD/cache" GITLEAKS_RETRY_SLEEP=0 bash "$HERE/install_gitleaks.sh" ) >"$GLD/out" 2>&1; rc=$?
expect "gitleaks install: a corrupted cache entry is replaced by a fresh verified download" "$rc:$(gl_calls)" "0:1"
# the pin in the script is the official one, and the CI cache key names the same version
pin_ver="$(sed -n 's/^VERSION=//p' "$HERE/install_gitleaks.sh")"
expect "gitleaks install: the default checksum is the official linux_x64 one" \
  "$(grep -c '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb' "$HERE/install_gitleaks.sh")" 1
expect "gitleaks install: the CI cache is keyed on the installer script (version and checksum live there)" \
  "$(grep -c 'gitleaks-v1-{{ checksum "scripts/ci/install_gitleaks.sh" }}' "$HERE/../../.circleci/config.yml")" 2
expect "gitleaks install: the pinned version is $pin_ver" "$(grep -c "gitleaks_${pin_ver}_checksums.txt" "$HERE/install_gitleaks.sh")" 1

# =========================================================================================
# The API deploy keeps every secret. `--set-secrets` REPLACES the service's secret list, so a
# deploy that forgets one drops it from the next revision (push goes silently off if it is the
# Ably key). Nothing else redeploys clinic-api: rollback, promote and prune only move traffic.
# =========================================================================================
CONFIG="$HERE/../../.circleci/config.yml"
deploy_line="$(grep -E 'gcloud run deploy clinic-api ' "$CONFIG")"
expect "deploy: exactly one command deploys clinic-api" "$(grep -c . <<<"$deploy_line")" 1
for secret in DATABASE_URL=clinic-database-url-app:latest \
              INTERNAL_SIGNING_KEY=clinic-internal-signing-key:latest \
              SMOKE_SIGNING_KEY=clinic-smoke-signing-key:latest \
              ABLY_API_KEY=clinic-ably-api-key:latest; do
  expect "deploy: --set-secrets carries ${secret%%=*}" "$(grep -c -- "--set-secrets [^ ]*${secret}" <<<"$deploy_line")" 1
done
other="$(grep -rE 'run (deploy|services update|services replace)' "$HERE" "$HERE/../../.circleci/config.yml" 2>/dev/null | grep -v 'test_ci_scripts.sh' | grep -c 'clinic-api')"
expect "deploy: no other script redeploys or updates clinic-api (the secrets list cannot be dropped)" "$other" 1

# =========================================================================================
# select_vercel_token.sh: one token per Vercel project. The values below are test strings.
# =========================================================================================
vt_run() { # <app> <env assignments...> ; leaves exit code in $rc, the sourced result in $VT_OUT
  local app="$1"; shift
  VT_ENV="$WORK/vt.bashenv"; : > "$VT_ENV"
  env -u VERCEL_TOKEN -u VERCEL_ADMIN_TOKEN BASH_ENV="$VT_ENV" "$@" bash "$HERE/select_vercel_token.sh" "$app" >"$WORK/vt.out" 2>&1; rc=$?
  VT_OUT="$(env -u VERCEL_TOKEN -u VERCEL_ADMIN_TOKEN "$@" bash -c "source '$VT_ENV'; echo \"token=\${VERCEL_TOKEN-unset} admin=\${VERCEL_ADMIN_TOKEN-unset}\"")"
}
vt_run admin VERCEL_TOKEN=booking-secret-value VERCEL_ADMIN_TOKEN=admin-secret-value
expect "vercel token: an admin job uses the admin token as VERCEL_TOKEN and hides the admin variable" \
  "$rc:$VT_OUT" "0:token=admin-secret-value admin=unset"
expect "vercel token: ...and never prints a token value" "$(grep -c 'secret-value' "$WORK/vt.out")" 0
# a step's shell sources BASH_ENV, then `bash scripts/...` sources it again in a child shell
VT_NESTED="$(env -u VERCEL_TOKEN -u VERCEL_ADMIN_TOKEN VERCEL_TOKEN=booking-secret-value VERCEL_ADMIN_TOKEN=admin-secret-value \
  BASH_ENV="$VT_ENV" bash -c 'bash -c "echo token=\${VERCEL_TOKEN-unset} admin=\${VERCEL_ADMIN_TOKEN-unset}"')"
expect "vercel token: a child shell that sources BASH_ENV again still has the admin token" \
  "$VT_NESTED" "token=admin-secret-value admin=unset"
vt_run booking VERCEL_TOKEN=booking-secret-value VERCEL_ADMIN_TOKEN=admin-secret-value
expect "vercel token: a booking job keeps its own token and the admin token is gone from its environment" \
  "$rc:$VT_OUT" "0:token=booking-secret-value admin=unset"
expect "vercel token: ...and never prints a token value (booking)" "$(grep -c 'secret-value' "$WORK/vt.out")" 0
vt_run admin VERCEL_TOKEN=booking-secret-value
expect "vercel token: an admin job without VERCEL_ADMIN_TOKEN stops with exit 1" "$rc" 1
expect "vercel token: ...and says what to add and where, naming no value" \
  "$(grep -c 'VERCEL_ADMIN_TOKEN is not set' "$WORK/vt.out")$(grep -c 'vercel-prod context' "$WORK/vt.out")$(grep -c 'secret-value' "$WORK/vt.out")" 110
expect "vercel token: ...and it did not fall back to the booking token" "$(cat "$VT_ENV")" ""
vt_run booking VERCEL_ADMIN_TOKEN=admin-secret-value
expect "vercel token: a booking job without VERCEL_TOKEN stops with exit 1" "$rc" 1
vt_run other VERCEL_TOKEN=x
expect "vercel token: an unknown app is a usage error (exit 2)" "$rc" 2
# the CI config wires it: both per-app jobs choose the token first, before anything that could use one
python3 - "$HERE/../../.circleci/config.yml" > "$WORK/vt.cfg" <<'PY'
import re, sys
s = open(sys.argv[1]).read()
for job in ("ship-app", "rollback-app"):
    body = s[s.index("\n  %s:\n" % job):]
    body = body[1:body.index("\n  ", body.index("steps:")+1) if False else len(body)]
    nxt = re.search(r"\n  [a-z][a-z0-9-]*:\n", body[3:])
    body = body[: nxt.start() + 3] if nxt else body
    i_sel = body.find("select_vercel_token.sh")
    uses = [m.start() for m in re.finditer(r"vercel_prod\.sh|vercel deploy|vercel_env_check\.sh|VERCEL_APP=", body)]
    print(job, "selected" if i_sel >= 0 else "MISSING", "first" if i_sel >= 0 and all(i_sel < u for u in uses) else "NOT-FIRST")
PY
expect "vercel token: ship-app chooses the token before it deploys or reads the project" "$(grep -c '^ship-app selected first' "$WORK/vt.cfg")" 1
expect "vercel token: rollback-app chooses the token before it rolls back" "$(grep -c '^rollback-app selected first' "$WORK/vt.cfg")" 1
expect "vercel token: no job outside those two names VERCEL_ADMIN_TOKEN" \
  "$(grep -c 'VERCEL_ADMIN_TOKEN' "$HERE/../../.circleci/config.yml")" 0

# lighthouse.sh fetches main with an explicit refspec, so a shallow clone still gets origin/main
mkdir -p "$WORK/fakegit"
real_git="$(command -v git)"
cat > "$WORK/fakegit/git" <<FAKE
#!/usr/bin/env bash
[ "\$1" = fetch ] && echo "\$*" >> "$WORK/fakegit/fetch.log"
exec "$real_git" "\$@"
FAKE
chmod +x "$WORK/fakegit/git"; : > "$WORK/fakegit/fetch.log"
PATH="$WORK/fakegit:$PATH" CIRCLE_BRANCH=feature LH_WATCH=no/such/path LH_PORT=$LHP LH_CHROME_PATH=/bin/sh \
  LHCI_OUTPUT_DIR="$WORK/lh-out.fetch" bash "$HERE/lighthouse.sh" >/dev/null 2>&1
expect "lighthouse: fetches main with an explicit refspec (works in a shallow clone)" \
  "$(grep -c 'fetch origin main:refs/remotes/origin/main' "$WORK/fakegit/fetch.log")" 1

# =========================================================================================
# vercel_offline_build.sh: NEXT_PUBLIC_* values come from public-build.env, fail closed before the
# build (a referenced name without a value) and after it (a value missing from the static output).
# A fake build command stands in for `vercel build`; no network, no ports.
# =========================================================================================
pb_setup() { # <name>: a tiny repo whose booking source references NEXT_PUBLIC_FOO
  PB="$WORK/pb.$1"; rm -rf "$PB"; mkdir -p "$PB/apps/booking/src" "$PB/apps/admin/src" "$PB/packages/ui/src"
  echo 'export const k = process.env.NEXT_PUBLIC_FOO ?? "";' > "$PB/apps/booking/src/a.ts"
  echo 'export const b = 1;' > "$PB/apps/admin/src/b.ts"; echo 'export const c = 1;' > "$PB/packages/ui/src/c.ts"
  printf '# test\nbooking NEXT_PUBLIC_FOO=pub-value-123\n' > "$PB/public.env"
  printf '#!/bin/sh\ntouch "%s/build-ran"\nmkdir -p .vercel/output/static/_next\nprintf %%s "$NEXT_PUBLIC_FOO" > .vercel/output/static/_next/chunk.js\n' "$PB" > "$PB/build-ok.sh"
  printf '#!/bin/sh\ntouch "%s/build-ran"\nmkdir -p .vercel/output/static/_next\nprintf %%s "no public value here" > .vercel/output/static/_next/chunk.js\n' "$PB" > "$PB/build-lossy.sh"
}
pb_run() { # <name> <app dir> <build script> ; leaves rc, output in $PB/out
  ( cd "$WORK" && env -u VERCEL_TOKEN REPO_ROOT="$PB" PUBLIC_ENV_FILE="$PB/public.env" VERCEL_APP_DIR="$2" VERCEL_BUILD_CMD="sh $PB/$3" \
      bash "$HERE/vercel_offline_build.sh" ) >"$PB/out" 2>&1; rc=$?
}
pb_setup ok; pb_run ok apps/booking build-ok.sh
expect "public build env: a referenced NEXT_PUBLIC_* with a value builds, and the value reaches the output" "$rc:$([ -e "$PB/build-ran" ] && echo built)" "0:built"
pb_setup missing; echo '# nothing' > "$PB/public.env"; pb_run missing apps/booking build-ok.sh
expect "public build env: a referenced name with no value refuses BEFORE the build" "$rc:$([ -e "$PB/build-ran" ] && echo built || echo not-built):$(grep -c 'NEXT_PUBLIC_FOO' "$PB/out")" "1:not-built:1"
pb_setup empty; printf 'booking NEXT_PUBLIC_FOO=\n' > "$PB/public.env"; pb_run empty apps/booking build-ok.sh
expect "public build env: an empty value refuses before the build" "$rc:$([ -e "$PB/build-ran" ] && echo built || echo not-built)" "1:not-built"
pb_setup otherapp; printf 'admin NEXT_PUBLIC_FOO=pub-value-123\n' > "$PB/public.env"; pb_run otherapp apps/booking build-ok.sh
expect "public build env: a value listed for another app does not count" "$rc:$([ -e "$PB/build-ran" ] && echo built || echo not-built)" "1:not-built"
pb_setup lossy; pb_run lossy apps/booking build-lossy.sh
expect "public build env: a build whose output lacks the value refuses to ship" "$rc:$(grep -c 'is not in the built static output' "$PB/out")" "1:1"
pb_setup admin; pb_run admin apps/admin build-ok.sh
expect "public build env: an app that references no NEXT_PUBLIC_* needs no entry" "$rc" 0
pb_setup token; ( cd "$WORK" && VERCEL_TOKEN=x REPO_ROOT="$PB" PUBLIC_ENV_FILE="$PB/public.env" VERCEL_APP_DIR=apps/booking VERCEL_BUILD_CMD="sh $PB/build-ok.sh" bash "$HERE/vercel_offline_build.sh" ) >"$PB/out" 2>&1; rc=$?
expect "public build env: a Vercel token in the environment still refuses the build" "$rc" 1
# the real repo: every NEXT_PUBLIC_* its sources reference has a value for that app in the committed file
real_ok=0
for app in booking admin; do
  for name in $( { grep -rhoE 'NEXT_PUBLIC_[A-Z0-9_]+' "$HERE/../../apps/$app/src" "$HERE"/../../packages/*/src 2>/dev/null || true; } | sort -u); do
    grep -qE "^$app $name=.+" "$HERE/public-build.env" || { echo "no value for $app $name"; real_ok=1; }
  done
done
expect "public build env: the committed file covers every NEXT_PUBLIC_* the real sources reference" "$real_ok" 0
expect "public build env: the committed file holds only NEXT_PUBLIC_* names" "$(grep -vE '^(#|$)' "$HERE/public-build.env" | grep -vcE '^[a-z]+ NEXT_PUBLIC_[A-Z0-9_]+=')" 0

# =========================================================================================
# realtime_prereqs.sh: the steps only a person can do fail with the command to run, not a mystery.
# =========================================================================================
mkdir -p "$WORK/bin-rt"
cat > "$WORK/bin-rt/gcloud" <<'FAKE'
#!/usr/bin/env bash
case "$*" in
  "secrets versions list"*) cat "$RT/versions.json" ;;
  "run services get-iam-policy"*) cat "$RT/policy.json" ;;
  *) echo "fake gcloud: unhandled: $*" >&2; exit 99 ;;
esac
FAKE
chmod +x "$WORK/bin-rt/gcloud"
rt_run() { # <name> <mode> ; uses $RT
  ( cd "$WORK" && PATH="$WORK/bin-rt:$PATH" GOOGLE_PROJECT_ID=p RT="$RT" bash "$HERE/realtime_prereqs.sh" $2 ) >"$RT/out" 2>&1
  echo $?
}
RT="$WORK/rt1"; mkdir -p "$RT"
echo '[]' > "$RT/versions.json"
expect "realtime prereqs: no secret version -> fails" "$(rt_run x '')" 1
expect "realtime prereqs: ...and names the runbook" "$(grep -c 'docs/runbooks/neon.md' "$RT/out")" 1
echo '[{"name":"v1"}]' > "$RT/versions.json"
expect "realtime prereqs: one enabled version -> ok" "$(rt_run x '')" 0
adm='"serviceAccount:clinic-admin@p.iam.gserviceaccount.com"'; smk='"serviceAccount:clinic-smoke@p.iam.gserviceaccount.com"'; web='"serviceAccount:clinic-web@p.iam.gserviceaccount.com"'
pol() { echo "{\"bindings\":[{\"role\":\"roles/run.invoker\",\"members\":[$1]}]}" > "$RT/policy.json"; }
pol "$adm,$smk"
expect "realtime prereqs: admin + smoke invokers -> ok" "$(rt_run x --after-deploy)" 0
pol "$adm"
expect "realtime prereqs: smoke binding missing -> fails" "$(rt_run x --after-deploy)" 1
expect "realtime prereqs: ...and prints the exact bootstrap command" "$(grep -c 'bash infra/bootstrap.sh invoker' "$RT/out")" 1
pol "$adm,$smk,$web"
expect "realtime prereqs: the public proxy bound -> fails" "$(rt_run x --after-deploy)" 1
echo '{"bindings":[]}' > "$RT/policy.json"
expect "realtime prereqs: no bindings at all -> fails" "$(rt_run x --after-deploy)" 1

# promote.sh and rollback.sh serve the gateway through SERVICE: it must be the service they touch.
new_fx rtpromote; export GOOGLE_PROJECT_ID=p
echo '{"status":{"traffic":[{"revisionName":"rev-p","percent":100}]}}' > "$FX/service_before.json"
echo '{"status":{"traffic":[{"revisionName":"rev-p","percent":0},{"revisionName":"rev-n","percent":100,"tag":"sha-n"}]}}' > "$FX/service_after.json"
( cd "$WORK/repo" && CIRCLE_SHA1="$(git -C "$WORK/origin.git" rev-parse main)" SERVICE=clinic-realtime PROMOTE_DIR="$FX/promoted" bash "$HERE/promote.sh" sha-n ) >"$FX/out" 2>&1
expect "promote.sh with SERVICE=clinic-realtime moves clinic-realtime traffic" "$(grep -c 'run services update-traffic clinic-realtime' "$FX/calls.all")" 1
expect "promote.sh with SERVICE=clinic-realtime never touches clinic-api" "$(grep -c 'clinic-api' "$FX/calls.all")" 0

# =========================================================================================
# measure_realtime_cost.sh: the judgement fails closed; the README line is a placeholder until measured.
# =========================================================================================
MEASURE="$HERE/../ops/measure_realtime_cost.sh"
judge_rc() { bash "$MEASURE" --judge "$1" "$2" >/dev/null 2>&1; echo $?; }
expect "measure: 900 vCPU-s per connected hour (0.25 vCPU) is within the budget" "$(judge_rc 360 90)" 0
expect "measure: 990 is within the budget" "$(judge_rc 360 99)" 0
expect "measure: 1 vCPU (3600 per hour) exceeds the budget" "$(judge_rc 360 360)" 1
expect "measure: too few connected seconds fails closed" "$(judge_rc 60 15)" 1
expect "measure: no CPU recorded fails closed" "$(judge_rc 360 0)" 1
expect "measure: non-numbers fail closed" "$(judge_rc abc 10)" 1
expect "measure: the README line is a placeholder until measured" "$(EVIDENCE="$WORK/none.json" bash "$MEASURE" --readme-line)" "Measured cost of one connected hour: to be measured after the first deploy."
echo '{"measured_at":"2026-10-20T10:00:00Z","connected_seconds":360,"vcpu_seconds_per_connected_hour":912,"budget":1100,"hours_of_shared_headroom":23.7}' > "$WORK/ev.json"
expect "measure: the README line is generated from the evidence file" "$(EVIDENCE="$WORK/ev.json" bash "$MEASURE" --readme-line | grep -c '912 vCPU-seconds per connected hour')" 1

echo
echo "ci scripts: $PASSES passed, $FAILS failed"
[ "$FAILS" -eq 0 ]
