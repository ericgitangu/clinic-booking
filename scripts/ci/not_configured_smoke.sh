#!/usr/bin/env bash
#
# Start each built web app with NO sign-in settings and check what a visitor gets: a 503 page that
# says sign-in is not configured, never a 500. Run after `pnpm -r build`.
#
#   not_configured_smoke.sh
set -uo pipefail

cd "$(dirname "$0")/../.."
FAILS=0
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

start() { # <app> <port>; env -i so nothing from this shell reaches the app
  (cd "apps/$1" && env -i PATH="$PATH" HOME="$HOME" NODE_ENV=production \
    ./node_modules/.bin/next start -p "$2" >"/tmp/not-configured-$1.log" 2>&1 &
    echo $! >"/tmp/not-configured-$1.pid")
  for _ in $(seq 1 60); do
    curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$2/robots.txt" && return 0
    sleep 1
  done
  echo "FAIL  $1 did not start"; cat "/tmp/not-configured-$1.log"; FAILS=$((FAILS + 1))
}

stop() { # by the pid recorded at start, so nothing else on the machine is touched
  local pid
  pid="$(cat "/tmp/not-configured-$1.pid" 2>/dev/null)" || return 0
  pkill -P "$pid" 2>/dev/null || true # next start forks its server; take the children first
  kill "$pid" 2>/dev/null || true
}
trap 'stop admin; stop booking' EXIT

start admin "$ADMIN_PORT"
check "admin: the sign-in gate degrades" "$ADMIN_PORT" / 503 "Sign-in is not configured"
check "admin: the dashboard degrades" "$ADMIN_PORT" /dashboard 503 "Sign-in is not configured"
check "admin: the auth handler degrades" "$ADMIN_PORT" /auth/get-session 503 ""
check "admin: robots still answers" "$ADMIN_PORT" /robots.txt 200 ""

start booking "$BOOKING_PORT"
check "booking: appointments degrade" "$BOOKING_PORT" /appointments 503 "Sign-in is not configured"
check "booking: the auth handler degrades" "$BOOKING_PORT" /auth/get-session 503 ""
check "booking: a public page is not taken down" "$BOOKING_PORT" /about 200 ""

# Exactly one structured error per app instance, however many requests it served.
for app in admin booking; do
  n="$(grep -c '"event":"auth_not_configured"' "/tmp/not-configured-$app.log")"
  if [ "$n" = 1 ]; then echo "PASS  $app: one structured error logged"; else echo "FAIL  $app: $n structured errors logged, wanted 1"; FAILS=$((FAILS + 1)); fi
  if grep -qiE 'is not set|    at ' "/tmp/not-configured-$app.log"; then echo "FAIL  $app: a stack trace or crash is in the log"; FAILS=$((FAILS + 1)); fi
done

echo "not-configured smoke: $FAILS failed"
[ "$FAILS" -eq 0 ]
