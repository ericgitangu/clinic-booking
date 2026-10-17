#!/usr/bin/env bash
#
# Build the Vercel output WITHOUT any Vercel credential.
#
# `vercel pull` + `vercel build` normally need VERCEL_TOKEN, which would put a token that can
# deploy to production into the same process as `pnpm install` and `next build` (dependency and
# repo code). `vercel build` itself does not need the token: it only needs a project.json with
# the framework settings. The identifiers below are placeholders; the real org and project ids
# are supplied to the separate deploy job (the only one holding the token) through
# VERCEL_ORG_ID / VERCEL_PROJECT_ID.
#
# Built from the repository root with the project's Root Directory set to the app (VERCEL_APP_DIR, default apps/booking): the pnpm workspace
# keeps dependencies in the root node_modules, so the function file map is relative to the root
# and building or deploying with --cwd <app> fails on missing files.
#
# VERCEL_BUILD_TARGET=preview builds a preview-target output, for rehearsing the deploy layout
# without touching production (a prebuilt output can only be deployed to the target it was
# built for).
#
# Output: .vercel/output at the repo root (the Build Output API tree, no secrets).
set -euo pipefail
APP_DIR="${VERCEL_APP_DIR:-apps/booking}"

cd "$(dirname "$0")/../.."
if [ -n "${VERCEL_TOKEN:-}" ]; then
  echo "refusing to build with VERCEL_TOKEN in the environment" >&2
  exit 1
fi

mkdir -p .vercel
cat > .vercel/project.json <<JSON
{"orgId":"team_offline_build","projectId":"prj_offline_build","settings":{"framework":"nextjs","buildCommand":null,"installCommand":null,"outputDirectory":null,"rootDirectory":"${APP_DIR}","nodeVersion":"24.x"}}
JSON

VERCEL_TELEMETRY_DISABLED=1 npm_config_ignore_scripts=true \
  npx --yes vercel@59.5.0 build --target="${VERCEL_BUILD_TARGET:-production}"
test -d .vercel/output
