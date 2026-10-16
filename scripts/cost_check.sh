#!/usr/bin/env bash
#
# $0 cost guards (WP-12a, section 13).
#   --static  source/config lint, no credentials. Exit 1 on any FAIL.
#   --live    read-only gcloud plus one unauthenticated curl against prod
#             (the engineer's `make cost-check`). Exit 1 on any FAIL.
#
# --live is DRAFTED AND NOT YET EXECUTED against a real project: the gcloud JSON field
# paths below come from the plan (cost-control table C1..C18) and are marked unverified until
# WP-00 (j) / first live run confirms them. A path that is wrong must be fixed, never dropped.
#
set -uo pipefail

MODE="${1:---static}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FAILS=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILS=$((FAILS + 1)); }

CI=.circleci/config.yml
BOOTSTRAP=infra/bootstrap.sh
SELF='!scripts/cost_check.sh'

# Join backslash line-continuations so a multi-line command reads as one logical line.
collapse() { perl -0777 -pe 's/\\\n[[:space:]]*//g' "$1"; }

# match <pattern> <paths...>: 0 = hit, 1 = no hit. An rg error (exit 2) is a FAIL, never a
# silent pass. Globs must precede the pattern, so the checker never matches its own patterns.
match() {
  local pat="$1"; shift
  rg -n -g "$SELF" -e "$pat" "$@"
  local rc=$?
  if [ "$rc" -eq 2 ]; then
    fail "cost_check internal error (rg failed) for pattern: $pat"
  fi
  return "$rc"
}

# "label<TAB>logical line" for every non-comment line that runs `gcloud run ...`.
# Label is the CircleCI job name (2-space-indented key) or the script's file name.
gcloud_run_lines() {
  collapse "$CI" | awk '
    /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { job=$1; sub(":","",job) }
    /gcloud run/ && $0 !~ /^[[:space:]]*#/ { print job "\t" $0 }'
  local f
  for f in "$BOOTSTRAP" scripts/ci/*.sh; do
    [ -f "$f" ] || continue
    collapse "$f" | awk -v label="$(basename "$f")" '
      /gcloud run/ && $0 !~ /^[[:space:]]*#/ { print label "\t" $0 }'
  done
}

static_checks() {
  local need
  for need in "$CI" infra scripts; do
    [ -e "$need" ] || { fail "required path missing: $need"; return; }
  done

  local lines label line
  lines="$(gcloud_run_lines)"

  # 1. deploy: --min-instances 0 and --max-instances <= 3.
  while IFS=$'\t' read -r label line; do
    [ -z "$line" ] && continue
    case "$line" in *"gcloud run deploy"*) ;; *) continue;; esac
    if printf '%s' "$line" | grep -qE -- '--min-instances 0([^0-9]|$)'; then
      pass "min-instances 0: $label"
    else
      fail "min-instances missing or not 0: $label"
    fi
    if printf '%s' "$line" | grep -qE -- '--max-instances [0-3]([^0-9]|$)'; then
      pass "max-instances <= 3: $label"
    else
      fail "max-instances missing: $label"
    fi
  done <<< "$lines"

  # 2. jobs deploy: bounded timeout, no retries.
  while IFS=$'\t' read -r label line; do
    [ -z "$line" ] && continue
    case "$line" in *"gcloud run jobs deploy"*) ;; *) continue;; esac
    if printf '%s' "$line" | grep -qE -- '--task-timeout' && printf '%s' "$line" | grep -qE -- '--max-retries 0'; then
      pass "job timeout + no retries: $label"
    else
      fail "job missing --task-timeout / --max-retries 0: $label"
    fi
  done <<< "$lines"

  # 3. Flag bans, applied to gcloud run commands only (docker run --network is legitimate).
  while IFS=$'\t' read -r label line; do
    [ -z "$line" ] && continue
    printf '%s' "$line" | grep -qE -- '(^|[[:space:]])--allow-unauthenticated|--no-invoker-iam-check|invoker[-_]iam[-_]disabled' \
      && fail "public-access flag: $label"
    printf '%s' "$line" | grep -qE -- '--no-cpu-throttling|--vpc-connector|--network[ =]|--subnet|--vpc-egress|--gpu|--min[= ][1-9]|--min-instances [1-9]' \
      && fail "always-on or network-billing flag: $label"
    printf '%s' "$line" | grep -qE -- '--scaling|scalingMode|manualInstanceCount|services replace|worker-pools' \
      && fail "manual-scaling flag: $label"
    printf '%s' "$line" | grep -qE -- '--source' \
      && fail "gcloud run --source build: $label"
  done <<< "$lines"
  [ "$FAILS" -eq 0 ] && pass "no forbidden gcloud run flags"

  # 4. Same bans in Terraform (annotation and resource forms).
  if match 'invoker-iam-disabled|scalingMode|manualInstanceCount|google_cloud_run_v2_worker_pool|google_cloud_run_service_iam_member.*allUsers|allUsers|allAuthenticatedUsers' infra/terraform >/dev/null; then
    fail "terraform: public invoker / manual scaling / worker pool"
  else
    pass "terraform has no public invoker, manual scaling or worker pool"
  fi

  # 5. Managed build, DLC, large classes.
  if match 'gcloud builds submit|docker_layer_caching: *true|resource_class: *(large|xlarge|2xlarge|[a-z0-9.-]*gen2)' "$CI" scripts infra >/dev/null; then
    fail "managed build / DLC / large resource class"
  else
    pass "no managed build, DLC or large resource class"
  fi

  # 6. APIs, resources, regions in Terraform.
  if match 'containerscanning|ondemandscanning|cloudbuild' infra/terraform/apis.tf >/dev/null; then
    fail "apis.tf enables a paid scanner or managed build"
  else
    pass "apis.tf clean of paid scanners"
  fi
  if match 'google_monitoring_uptime_check_config|google_cloud_scheduler_job' infra >/dev/null; then
    fail "uptime check or scheduler resource"
  else
    pass "no uptime check or scheduler"
  fi
  if match 'europe-west|us-central|us-west[12]|STANDARD_IA|dual-region|multi-region' infra >/dev/null; then
    fail "region outside us-east4 (state: us-east1) in infra/"
  else
    pass "regions confined to us-east4 (+ us-east1 state)"
  fi

  # 7. Vercel and Next settings.
  local vj
  while IFS= read -r vj; do
    [ -z "$vj" ] && continue
    if [ "$(jq -c '.regions' "$vj")" = '["iad1"]' ] && [ "$(jq -r '.git.deploymentEnabled' "$vj")" = "false" ]; then
      pass "vercel.json pinned to iad1, git deploys off: $vj"
    else
      fail "vercel.json not pinned to iad1 / git deploys on: $vj"
    fi
  done < <(find . -name vercel.json -not -path '*/node_modules/*' -not -path './.git/*')
  if [ -f web/next.config.ts ]; then
    match 'unoptimized: *true' web/next.config.ts >/dev/null && pass "next images unoptimized" || fail "next images not unoptimized"
  fi
  if [ -d web/src ] && match 'preferredRegion' web/src | rg -v '"iad1"' | rg -q .; then
    fail "preferredRegion other than iad1 under web/src"
  else
    pass "no non-iad1 preferredRegion"
  fi

  # 8. Every docker build carries --provenance=false and --sbom=false.
  local b
  while IFS= read -r b; do
    [ -z "$b" ] && continue
    if printf '%s' "$b" | grep -q -- '--provenance=false' && printf '%s' "$b" | grep -q -- '--sbom=false'; then
      pass "docker build has --provenance=false --sbom=false"
    else
      fail "docker build missing --provenance=false / --sbom=false"
    fi
  done < <(collapse "$CI" | grep -vE '^[[:space:]]*#' | grep -E 'docker (buildx )?build')

  # 9. CI never downloads from Artifact Registry.
  if match 'pkg\.dev' "$CI" scripts infra | rg -i 'docker pull|trivy image|cache-from' | rg -q .; then
    fail "CI downloads from Artifact Registry"
  else
    pass "no Artifact Registry pulls in CI"
  fi

  # 10. Web layout.
  if [ -d web/src/app/api ]; then
    local n; n="$(find web/src/app/api -name 'route.ts' | wc -l | tr -d ' ')"
    [ "$n" = "1" ] && pass "one route file under web/src/app/api" || fail "web/src/app/api has $n route files (want 1)"
  fi
  local dr
  for dr in web/src/app/docs/route.ts web/src/app/redoc/route.ts web/src/app/openapi.json/route.ts; do
    [ -f "$dr" ] || continue
    if rg -q 'force-static' "$dr" && ! rg -q 'lib/proxy' "$dr"; then
      pass "static doc route without proxy import: $dr"
    else
      fail "doc route not static or imports the proxy: $dr"
    fi
  done
}

# ------------------------------------------------------------------------------------------
# LIVE checks (read-only). Unverified against a real project; see the header note.
# ------------------------------------------------------------------------------------------
REGION=us-east4

live_checks() {
  : "${PROJECT:?set PROJECT for --live}"
  command -v gcloud >/dev/null || { fail "gcloud not installed"; return; }
  command -v jq >/dev/null || { fail "jq not installed"; return; }

  # C1: max/min instances, service-level min, CPU throttling, scaling mode.
  local c1
  c1="$(gcloud run services list --region "$REGION" --project "$PROJECT" --format=json 2>/dev/null | jq -r '.[] | [.metadata.name, (.spec.template.metadata.annotations["autoscaling.knative.dev/maxScale"] // "UNSET"), (.spec.template.metadata.annotations["autoscaling.knative.dev/minScale"] // "0"), (.metadata.annotations["autoscaling.knative.dev/minScale"] // "0"), (.spec.template.metadata.annotations["run.googleapis.com/cpu-throttling"] // "true"), (.metadata.annotations["run.googleapis.com/scalingMode"] // "automatic")] | @tsv')"
  if [ -z "$c1" ]; then
    fail "C1 no Cloud Run services found (or field paths unverified)"
  else
    while IFS=$'\t' read -r name max min smin thr mode; do
      if [ "$max" != "UNSET" ] && [ "$max" -le 3 ] 2>/dev/null && [ "$min" = 0 ] && [ "$smin" = 0 ] && [ "$thr" = true ] && [ "$mode" = automatic ]; then
        pass "C1 $name max=$max min=0 throttling=true scaling=automatic"
      else
        fail "C1 $name max=$max min=$min service-min=$smin throttling=$thr scaling=$mode"
      fi
    done <<< "$c1"
  fi

  # C2: no public invoker (binding or disabled IAM check).
  local svc
  for svc in clinic-api clinic-realtime; do
    gcloud run services describe "$svc" --region "$REGION" --project "$PROJECT" >/dev/null 2>&1 || continue
    local pub dis
    pub="$(gcloud run services get-iam-policy "$svc" --region "$REGION" --project "$PROJECT" --format=json | jq '[.bindings[]?.members[]] | map(select(.=="allUsers" or .=="allAuthenticatedUsers")) | length')"
    dis="$(gcloud run services describe "$svc" --region "$REGION" --project "$PROJECT" --format=json | jq -r '.metadata.annotations["run.googleapis.com/invoker-iam-disabled"] // "false"')"
    if [ "$pub" = 0 ] && [ "$dis" = false ]; then pass "C2 $svc not public"; else fail "C2 $svc public bindings=$pub iam-disabled=$dis"; fi

    # C3: direct run.app is an IAM denial (403 without a token, 401 with a junk bearer).
    local url c403 c401
    url="$(gcloud run services describe "$svc" --region "$REGION" --project "$PROJECT" --format='value(status.url)')"
    c403="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url/healthz")"
    c401="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H 'X-Serverless-Authorization: Bearer junk' "$url/healthz")"
    if [ "$c403" = 403 ] && [ "$c401" = 401 ]; then pass "C3 $svc run.app 403 / junk-bearer 401"; else fail "C3 $svc run.app returned $c403 / $c401 (want 403 / 401)"; fi
  done

  # C4: migration job cannot hang or retry.
  local c4
  c4="$(gcloud run jobs describe clinic-migrate --region "$REGION" --project "$PROJECT" --format=json 2>/dev/null | jq -r '[.spec.template.spec.template.spec.maxRetries, .spec.template.spec.template.spec.timeoutSeconds] | map(tostring) | join(" ")')"
  [ "$c4" = "0 600" ] && pass "C4 migrate job maxRetries=0 timeout=600" || fail "C4 migrate job '$c4' (want '0 600')"

  # C5: Artifact Registry cleanup policies and size.
  local c5
  c5="$(gcloud artifacts repositories describe clinic --location "$REGION" --project "$PROJECT" --format=json 2>/dev/null | jq -r '((.cleanupPolicies // {}) | keys | sort | join(",")) + " " + (((.sizeBytes // "0") | tonumber) < 400000000 | tostring)')"
  [ "$c5" = "delete-old,delete-untagged,keep-2 true" ] && pass "C5 AR cleanup policies and size" || fail "C5 AR '$c5'"

  # C6: <= 2 versions per package.
  local pkg cnt
  while IFS= read -r pkg; do
    [ -z "$pkg" ] && continue
    cnt="$(gcloud artifacts versions list --package "$pkg" --repository clinic --location "$REGION" --project "$PROJECT" --format=json | jq length)"
    if [ "$cnt" -le 2 ]; then pass "C6 $pkg versions=$cnt"; else fail "artifact-registry $pkg versions=$cnt > 2"; fi
  done < <(gcloud artifacts packages list --repository clinic --location "$REGION" --project "$PROJECT" --format='value(name)' 2>/dev/null)

  # C7 + C8: <= 6 active secret versions, automatic replication.
  local s total=0 repl=""
  while IFS= read -r s; do
    [ -z "$s" ] && continue
    total=$((total + $(gcloud secrets versions list "$s" --project "$PROJECT" --filter='state!=DESTROYED' --format=json | jq length)))
    repl="$repl $(gcloud secrets describe "$s" --project "$PROJECT" --format=json | jq -r '.replication | keys[0]')"
  done < <(gcloud secrets list --project "$PROJECT" --format='value(name)')
  if [ "$total" -le 6 ]; then pass "C7 active secret versions=$total (<= 6)"; else fail "C7 active secret versions=$total > 6"; fi
  if [ "$(printf '%s\n' $repl | sort -u | tr '\n' ' ')" = "automatic " ] || [ -z "$repl" ]; then pass "C8 secret replication automatic"; else fail "C8 replication:$repl"; fi

  # C10: paid scanners and managed build disabled.
  if gcloud services list --enabled --project "$PROJECT" --format='value(config.name)' | rg -q 'containerscanning|ondemandscanning|cloudbuild'; then
    fail "C10 a paid scanner or managed build API is enabled"
  else
    pass "C10 paid scanners and managed build disabled"
  fi

  # C18: logging stays default plus the one free exclusion.
  local sinks ret excl
  sinks="$(gcloud logging sinks list --project "$PROJECT" --format='value(name)' | sort | tr '\n' ' ')"
  ret="$(gcloud logging buckets describe _Default --location=global --project "$PROJECT" --format='value(retentionDays)')"
  excl="$(gcloud logging sinks describe _Default --project "$PROJECT" --format=json | jq -r '[.exclusions[]?.name] | join(",")')"
  if [ "$sinks" = "_Default _Required " ] && [ "$ret" = 30 ] && [ "$excl" = "drop-iam-denied" ]; then
    pass "C18 logging default sinks, 30d retention, drop-iam-denied exclusion"
  else
    fail "C18 sinks='$sinks' retention=$ret exclusions=$excl"
  fi
}

case "$MODE" in
  --static) static_checks ;;
  --live) live_checks ;;
  *) echo "usage: $0 [--static|--live]"; exit 2 ;;
esac

echo
if [ "$FAILS" -eq 0 ]; then echo "cost-check $MODE: OK"; else echo "cost-check $MODE: $FAILS failure(s)"; fi
[ "$FAILS" -eq 0 ]
