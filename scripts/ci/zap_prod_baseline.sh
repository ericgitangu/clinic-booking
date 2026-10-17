#!/usr/bin/env bash
#
# ZAP baseline scan of the live site after a release (docs/adr/0017). PASSIVE only: zap-baseline.py
# spiders the public pages and inspects the responses; it never sends attack payloads. It reuses
# the PR DAST job's image digest and rules file (.zap/rules.tsv) and the same pass/fail mapping:
# exit 0 (no alerts) and 2 (warnings only) pass; 1 and 3 fail.
#
# Rate-friendly on purpose: a one-minute spider and a three-minute ceiling, so it costs a few
# hundred requests through the front door once per release (docs/adr/0023 free-tier budget).
#
# Usage: zap_prod_baseline.sh            (reads WEB from scripts/ci/public-urls.env)
# Env:   ZAP_DOCKER   docker binary (tests substitute a fake)
set -uo pipefail
cd "$(dirname "$0")/../.."

# Same digest as the dast job in .circleci/config.yml; scripts/ci/test_ci_scripts.sh asserts they match.
ZAP_IMAGE="ghcr.io/zaproxy/zaproxy@sha256:5ccfff9a411743ab2615136a2edd7416bec9ce41572fa94e935df38c14adb2b6"
DOCKER="${ZAP_DOCKER:-docker}"

. scripts/ci/public-urls.env
case "$WEB" in *REPLACE_BEFORE_FIRST_PUSH*|"") echo "scripts/ci/public-urls.env has no WEB url"; exit 1 ;; esac
case "$WEB" in https://*) ;; *) echo "refusing a non-https target: $WEB"; exit 1 ;; esac
[ -f .zap/rules.tsv ] || { echo ".zap/rules.tsv is missing"; exit 1; }

chmod a+rwx .zap   # the ZAP container user is not the runner's uid
rm -f .zap/zap-prod-report.html .zap/zap-prod-report.json

"$DOCKER" run --rm -v "$PWD/.zap:/zap/wrk" "$ZAP_IMAGE" \
  zap-baseline.py -t "$WEB" -c rules.tsv -m 1 -T 3 \
  -r zap-prod-report.html -J zap-prod-report.json
code=$?
echo "zap baseline exit=$code"
# 0 = no alerts, 2 = warnings only -> pass; 1 (fail alert) and 3 (scan error) -> fail.
[ "$code" -eq 0 ] || [ "$code" -eq 2 ]
