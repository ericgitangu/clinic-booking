#!/usr/bin/env bash
#
# Install a pinned gitleaks into the current directory, verified against a pinned SHA-256.
#
# The checksum is the linux_x64 line of the official release checksums file:
#   https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_checksums.txt
# Bump VERSION and SHA256 together; the CI cache key is a checksum of this file, so a bump gets a
# fresh cache.
#
# The tarball is kept in $GITLEAKS_CACHE (CircleCI caches that directory, keyed on the version), so a
# cache hit needs no download at all. A download is retried at most once, with a message; a
# checksum that differs is a hard failure that names both values (a truncated or HTML error page
# from a flaky download is what "gzip: stdin: not in gzip format" used to be).
#
# Test seams (unset in CI): GITLEAKS_SHA256 replaces the pinned checksum, GITLEAKS_URL replaces the
# download URL, GITLEAKS_CACHE replaces the cache directory, GITLEAKS_RETRY_SLEEP the pause (seconds).
set -euo pipefail

VERSION=8.30.1
SHA256="${GITLEAKS_SHA256:-551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb}"
FILE="gitleaks_${VERSION}_linux_x64.tar.gz"
URL="${GITLEAKS_URL:-https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${FILE}}"
CACHE="${GITLEAKS_CACHE:-$HOME/.cache/gitleaks}"
TARBALL="$CACHE/$FILE"

sum() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$1" | cut -d' ' -f1; }
fail() { echo "install_gitleaks: $*" >&2; exit 1; }

mkdir -p "$CACHE"

if [ -f "$TARBALL" ]; then
  if [ "$(sum "$TARBALL")" = "$SHA256" ]; then
    echo "install_gitleaks: using the cached $FILE (checksum verified)"
  else
    echo "install_gitleaks: the cached $FILE does not match the pinned checksum; downloading again"
    rm -f "$TARBALL"
  fi
fi

if [ ! -f "$TARBALL" ]; then
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  attempt=1
  while :; do
    if curl -fsSL --max-time 120 -o "$tmp" "$URL" && [ "$(sum "$tmp")" = "$SHA256" ]; then
      mv "$tmp" "$TARBALL"
      break
    fi
    if [ -s "$tmp" ] && [ "$(sum "$tmp")" != "$SHA256" ]; then
      got="$(sum "$tmp")"
    else
      got="no usable download"
    fi
    if [ "$attempt" -ge 2 ]; then
      fail "could not fetch a verified $FILE after 2 attempts (expected sha256 $SHA256, last got: $got). Nothing was installed."
    fi
    echo "install_gitleaks: download attempt $attempt failed (expected sha256 $SHA256, got: $got); retrying once" >&2
    attempt=$((attempt + 1))
    : > "$tmp"
    sleep "${GITLEAKS_RETRY_SLEEP:-3}"
  done
fi

tar -xzf "$TARBALL" gitleaks || fail "the verified tarball would not extract"
chmod +x gitleaks
./gitleaks version
