#!/usr/bin/env bash
#
# The deployment URL out of `vercel deploy --prebuilt --prod` standard output, read on stdin.
#
#   vercel deploy --prebuilt --prod > deploy.out; URL="$(bash scripts/ci/deploy_url.sh < deploy.out)"
#
# When the CLI detects an agent environment it prints JSON on stdout instead of a bare URL, so the
# last line is `}`; `tail -1` returned that. This takes, in order:
#   1. a JSON object (found between the first `{` and the last `}`, so noise around it is fine, and
#      extra fields are ignored): its `url` field, as https://<host> when it has no scheme;
#   2. otherwise the last line that is an https URL on *.vercel.app or on one of the project's own
#      public hosts (scripts/ci/public-urls.env: WEB and ADMIN).
# Nothing else is accepted. With no such URL it stops with exit 1 and a message that carries only the
# size of the output, never the output, which could hold anything.
set -euo pipefail
cd "$(dirname "$0")/../.."

out="$(cat)"
fail() { echo "deploy_url: no deployment URL found in the vercel deploy output ($(printf '%s' "$out" | wc -c | tr -d ' ') bytes); nothing was promoted." >&2; exit 1; }

# the project's own public hosts, as a regex alternation (dots escaped)
own=""
if [ -f scripts/ci/public-urls.env ]; then
  for v in WEB ADMIN; do
    h="$(sed -n "s/^$v=https:\/\/\([A-Za-z0-9.-]*\)\/*$/\1/p" scripts/ci/public-urls.env | head -1)"
    [ -n "$h" ] && own="$own|$(printf '%s' "$h" | sed 's/\./\\./g')"
  done
fi
host_re="[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)*\\.vercel\\.app$own"

normalise() { # a url or bare host -> https://host[/path], only if the host is acceptable
  local u="$1"
  case "$u" in https://*) ;; http://*|*://*) return 1 ;; *) u="https://$u" ;; esac
  printf '%s' "$u" | grep -Eq "^https://($host_re)(/[^[:space:]]*)?$" || return 1
  printf '%s\n' "$u"
}

# 1. JSON
json="$(printf '%s' "$out" | awk 'BEGIN{RS="\0"} { a=index($0,"{"); b=0; for(i=length($0);i>0;i--) if (substr($0,i,1)=="}") { b=i; break } if (a>0 && b>a) print substr($0,a,b-a+1) }')"
if [ -n "$json" ] && url="$(printf '%s' "$json" | jq -er 'if type == "object" then .url // empty else empty end' 2>/dev/null)" && [ -n "$url" ]; then
  normalise "$url" && exit 0
  fail
fi

# 2. the last matching line
while IFS= read -r line; do
  line="$(printf '%s' "$line" | tr -d '\r' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
  if u="$(normalise "$line" 2>/dev/null)" && [ "${line#https://}" != "$line" ]; then last="$u"; fi
done <<<"$out"
[ -n "${last:-}" ] && { printf '%s\n' "$last"; exit 0; }
fail
