#!/usr/bin/env bash
# Fails when a retired name still shows on a public surface: the clinic's old name, or the old
# product name "Idyllic Clinic Booking" (the product is "Idyllic Clinic").
#
#   check_retired_names.sh BOOKING_BASE_URL [ADMIN_BASE_URL]
#   check_retired_names.sh - ADMIN_BASE_URL          (admin only: "-" skips the booking app)
#
# Fetches every public page of the booking app (the paths come from its own /sitemap.xml, so a new
# page is covered without editing this), its manifest, its robots and /api/doctors, and, when an
# admin URL is given, the admin app's public pages and manifest. Redirects are followed. A page that
# cannot be fetched is a failure, not a pass. Prints "<count> <url>" per surface and exits 1 when
# any count is not 0. Run against the e2e stack (see apps/*/e2e/brand-names.spec.ts) and against
# production after a deploy.
set -uo pipefail

BOOKING="${1:?usage: check_retired_names.sh BOOKING_BASE_URL [ADMIN_BASE_URL]}"
ADMIN="${2:-}"
BOOKING="${BOOKING%/}"; ADMIN="${ADMIN%/}"
# Case-insensitive; the first name is written so this file does not match itself.
PATTERN='[m]vule|Idyllic Clinic Booking'
fails=0

check() { # <url>
  local body code n
  body="$(mktemp)"
  code="$(curl -sL -m 30 -o "$body" -w '%{http_code}' "$1" 2>/dev/null || echo 000)"
  if [ "$code" != "200" ]; then
    echo "FAIL $1 could not be fetched (HTTP $code)"; fails=$((fails + 1)); rm -f "$body"; return
  fi
  n="$(grep -ciE "$PATTERN" "$body" || true)"
  echo "$n $1"
  [ "$n" = "0" ] || { fails=$((fails + 1)); grep -oiE ".{0,40}($PATTERN).{0,40}" "$body" | head -3 | sed 's/^/    /'; }
  rm -f "$body"
}

paths=""
if [ "$BOOKING" != "-" ]; then
sitemap="$(curl -sL -m 30 "$BOOKING/sitemap.xml" || true)"
paths="$(printf '%s' "$sitemap" | grep -oE '<loc>[^<]+</loc>' | sed -E 's#<loc>https?://[^/<]+##; s#</loc>##; s#^$#/#')"
if [ -z "$paths" ]; then echo "FAIL $BOOKING/sitemap.xml lists no pages"; exit 1; fi
for p in $paths /manifest.webmanifest /robots.txt /api/doctors; do check "$BOOKING$p"; done
fi
if [ -n "$ADMIN" ]; then
  for p in / /dashboard /manifest.webmanifest /robots.txt; do check "$ADMIN$p"; done
fi

if [ "$fails" -eq 0 ]; then echo "retired names: none on any checked surface"; else echo "retired names: $fails surface(s) failed"; fi
[ "$fails" -eq 0 ]
