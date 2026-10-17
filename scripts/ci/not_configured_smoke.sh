#!/usr/bin/env bash
#
# Start each built web app with NO sign-in settings and check what a visitor gets: a 503 page that
# says sign-in is not configured, never a 500. Run after `pnpm -r build`.
#
#   not_configured_smoke.sh
set -uo pipefail

cd "$(dirname "$0")/../.."
FAILS=0
APPS_DIR="${APPS_DIR:-apps}" # overridable so the refusal below can be tested without touching real apps
ADMIN_PORT=3481
BOOKING_PORT=3482

check() { # <description> <port> <path> <want-status> <want-text>
  local body status
  body="$(curl -s -o /dev/stdout -w '\n%{http_code}' --max-time 20 "http://127.0.0.1:$2$3")"
  status="${body##*$'\n'}"
  if [ "$status" = "$4" ] && { [ -z "$5" ] || grep -q "$5" <<<"$body"; }; then
    echo "PASS  $1 ($3 -> $status)"
  else
    echo "FAIL  $1 ($3 -> $status, wanted $4 ${5:+containing '$5'})"; FAILS=$((FAILS + 1))
  fi
}

# `env -i` clears this shell's variables, but `next start` still loads .env* files from the app's
# own directory (@next/env, at startup). A developer's pulled .env.local would then supply the very
# settings this test needs absent, so refuse to run rather than report a false FAIL. The developer's
# file is never moved or touched: move it aside yourself and rerun.
start() { # <app> <port>; returns 1 (and counts a FAIL) when the app cannot be tested cleanly
  local f
  for f in .env.local .env.production.local .env.production .env; do
    if [ -e "$APPS_DIR/$1/$f" ]; then
      echo "FAIL  $1 not tested: $APPS_DIR/$1/$f exists and next start would load it. Move it aside, rerun, then restore it."
      FAILS=$((FAILS + 1))
      return 1
    fi
  done
  (cd "$APPS_DIR/$1" && env -i PATH="$PATH" HOME="$HOME" NODE_ENV=production \
    ./node_modules/.bin/next start -p "$2" >"/tmp/not-configured-$1.log" 2>&1 &
    echo $! >"/tmp/not-configured-$1.pid")
  for _ in $(seq 1 60); do
    curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$2/robots.txt" && return 0
    sleep 1
  done
  echo "FAIL  $1 did not start"; cat "/tmp/not-configured-$1.log"; FAILS=$((FAILS + 1))
  return 1
}

stop() { # by the pid recorded at start, so nothing else on the machine is touched
  local pid
  pid="$(cat "/tmp/not-configured-$1.pid" 2>/dev/null)" || return 0
  pkill -P "$pid" 2>/dev/null || true # next start forks its server; take the children first
  kill "$pid" 2>/dev/null || true
}
trap 'stop admin; stop booking' EXIT

STARTED=""
if start admin "$ADMIN_PORT"; then
  STARTED="$STARTED admin"
  check "admin: the sign-in gate degrades" "$ADMIN_PORT" / 503 "Sign-in is not configured"
  check "admin: the dashboard degrades" "$ADMIN_PORT" /dashboard 503 "Sign-in is not configured"
  check "admin: the auth handler degrades" "$ADMIN_PORT" /auth/get-session 503 ""
  check "admin: robots still answers" "$ADMIN_PORT" /robots.txt 200 ""
fi

if start booking "$BOOKING_PORT"; then
  STARTED="$STARTED booking"
  check "booking: appointments degrade" "$BOOKING_PORT" /appointments 503 "Sign-in is not configured"
  check "booking: the auth handler degrades" "$BOOKING_PORT" /auth/get-session 503 ""
  check "booking: a public page is not taken down" "$BOOKING_PORT" /about 200 ""
fi

# Exactly one structured error per app instance, however many requests it served.
for app in $STARTED; do
  n="$(grep -c '"event":"auth_not_configured"' "/tmp/not-configured-$app.log")"
  if [ "$n" = 1 ]; then echo "PASS  $app: one structured error logged"; else echo "FAIL  $app: $n structured errors logged, wanted 1"; FAILS=$((FAILS + 1)); fi
  if grep -qiE 'is not set|    at ' "/tmp/not-configured-$app.log"; then echo "FAIL  $app: a stack trace or crash is in the log"; FAILS=$((FAILS + 1)); fi
done

echo "not-configured smoke: $FAILS failed"
[ "$FAILS" -eq 0 ]
