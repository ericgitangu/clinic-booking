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
# Output: web/.vercel/output (the Build Output API tree, no secrets).
set -euo pipefail

cd "$(dirname "$0")/../.."
if [ -n "${VERCEL_TOKEN:-}" ]; then
  echo "refusing to build with VERCEL_TOKEN in the environment" >&2
  exit 1
fi

mkdir -p web/.vercel
cat > web/.vercel/project.json <<'JSON'
{"orgId":"team_offline_build","projectId":"prj_offline_build","settings":{"framework":"nextjs","buildCommand":null,"installCommand":null,"outputDirectory":null,"rootDirectory":null,"nodeVersion":"24.x"}}
JSON

VERCEL_TELEMETRY_DISABLED=1 npm_config_ignore_scripts=true \
  npx --yes vercel@59.5.0 build --prod --cwd web
test -d web/.vercel/output
