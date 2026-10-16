#!/usr/bin/env bash
#
# Halt the job (successfully) when none of the given paths changed relative to main. Never
# skips on main. Fails CLOSED: any problem fetching or diffing means "run the job".
#
#   skip_unless_changed.sh web/ contracts/
set -uo pipefail

[ "${CIRCLE_BRANCH:-}" = main ] && exit 0
[ "$#" -gt 0 ] || exit 0

git fetch origin main --quiet 2>/dev/null || { echo "cannot fetch main; running the job"; exit 0; }
base="$(git merge-base origin/main HEAD 2>/dev/null)" || { echo "no merge base; running the job"; exit 0; }
if ! changed="$(git diff --name-only "$base" HEAD -- "$@" 2>/dev/null)"; then
  echo "diff failed; running the job"
  exit 0
fi
if [ -n "$changed" ]; then
  exit 0
fi
echo "no changes under: $*; skipping this job"
circleci-agent step halt
