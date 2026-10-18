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
# NEXT_PUBLIC_* values are inlined into the browser bundle at build time, and this build has no
# project environment, so they come from scripts/ci/public-build.env (public-by-design values only).
# Fail closed both ways: before the build, every NEXT_PUBLIC_* name the app's source references
# must have a non-empty value there; after it, each value must appear in the built static output,
# so a bundle that lost its site key (the booking form silently skipped reCAPTCHA once) cannot ship.
#
# Test seams (unset in CI): REPO_ROOT, PUBLIC_ENV_FILE, VERCEL_BUILD_CMD.
#
# Output: .vercel/output at the repo root (the Build Output API tree, no secrets).
set -euo pipefail
APP_DIR="${VERCEL_APP_DIR:-apps/booking}"
APP="$(basename "$APP_DIR")"

cd "${REPO_ROOT:-$(dirname "$0")/../..}"
PUBLIC_ENV_FILE="${PUBLIC_ENV_FILE:-scripts/ci/public-build.env}"
if [ -n "${VERCEL_TOKEN:-}" ]; then
  echo "refusing to build with VERCEL_TOKEN in the environment" >&2
  exit 1
fi

# ---- NEXT_PUBLIC_* values for this app --------------------------------------------------------
referenced="$( { grep -rhoE 'NEXT_PUBLIC_[A-Z0-9_]+' "$APP_DIR/src" packages/*/src 2>/dev/null || true; } | sort -u)"
declared=""
missing=""
for name in $referenced; do
  value="$(awk -v app="$APP" -v n="$name" '$1 == app { sub(/^[^ ]+ /, ""); i = index($0, "="); if (substr($0, 1, i - 1) == n) print substr($0, i + 1) }' "$PUBLIC_ENV_FILE")"
  if [ -z "$value" ]; then
    missing="$missing $name"
  else
    export "$name=$value"
    declared="$declared $name"
  fi
done
if [ -n "$missing" ]; then
  echo "refusing to build $APP: its source references$missing, which $PUBLIC_ENV_FILE does not set to a value for '$APP'." >&2
  echo "Add '$APP NAME=value' there (public values only) or the browser bundle ships without it." >&2
  exit 1
fi

mkdir -p .vercel
cat > .vercel/project.json <<JSON
{"orgId":"team_offline_build","projectId":"prj_offline_build","settings":{"framework":"nextjs","buildCommand":null,"installCommand":null,"outputDirectory":null,"rootDirectory":"${APP_DIR}","nodeVersion":"24.x"}}
JSON

if [ -n "${VERCEL_BUILD_CMD:-}" ]; then
  $VERCEL_BUILD_CMD
else
  VERCEL_TELEMETRY_DISABLED=1 npm_config_ignore_scripts=true \
    npx --yes vercel@59.5.0 build --target="${VERCEL_BUILD_TARGET:-production}"
fi
test -d .vercel/output

# Each public value must be in the browser output the deploy will upload.
for name in $declared; do
  value="${!name}"
  if ! grep -rqF -- "$value" .vercel/output/static 2>/dev/null; then
    echo "refusing to ship $APP: the value of $name is not in the built static output (.vercel/output/static)." >&2
    exit 1
  fi
done
