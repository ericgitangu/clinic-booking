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

rb_setup first rev-b ""
echo '{"revisions":["rev-b"],"current":"rev-b","previous":""}' > "$PROMOTE_DIR/keep.json"
bash "$HERE/rollback.sh" >/dev/null 2>&1; rc=$?
expect "rollback: first release has nothing to go back to (exit 2)" "$rc" 2

new_fx nokeep; export PROMOTE_DIR="$WORK/rb.nokeep"; mkdir -p "$PROMOTE_DIR"
bash "$HERE/rollback.sh" >/dev/null 2>&1; rc=$?
expect "rollback: nothing promoted means nothing to do (exit 0)" "$rc" 0


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
  "$(grep -- '--remove-tags' "$FX/calls" | sed 's/.*--remove-tags //' | tr ',' '\n' | sort | paste -sd, -)" "sha-a,sha-o"
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

echo
echo "ci scripts: $PASSES passed, $FAILS failed"
[ "$FAILS" -eq 0 ]
