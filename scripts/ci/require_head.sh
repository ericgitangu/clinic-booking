#!/usr/bin/env bash
#
# Halt the job (successfully) unless this commit is still the head of main. Used by the jobs
# that must not act for a commit a newer release has already superseded (the Vercel deploy and
# the public smoke). Fails CLOSED: if main cannot be fetched, the job fails rather than
# deploying on a guess.
set -euo pipefail

git fetch origin main --quiet
if [ "${CIRCLE_SHA1:?}" != "$(git rev-parse origin/main)" ]; then
  echo "A newer commit exists on main; this release is superseded. Skipping."
  circleci-agent step halt
fi
