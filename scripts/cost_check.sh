#!/usr/bin/env bash
#
# $0 cost guards.
#   --static  source/config lint, no credentials. Exit 1 on any FAIL.
#   --live    read-only gcloud plus one unauthenticated curl against prod
#             (the engineer's `make cost-check`). Exit 1 on any FAIL.
#
# --static normalises every code file (CI config, shell, Terraform, Makefile) into logical
# lines once (continuations joined, whole-line comments dropped) and runs one rule engine over
# them, so a banned flag is caught wherever it is written, not only on a literal `gcloud run`
# line in a known file. scripts/cost_check_selftest.sh proves each rule by mutation.
#
# --live is NOT YET EXECUTED against a real project: the gcloud JSON field paths below
# (checks C1..C18) are unverified until the first live run confirms them. A path that is
# wrong must be fixed, never dropped.
#
# Optional env for --live:  PROJECT (required), GCLOUD_ACCOUNT (passed as --account when set),
# BILLING_ACCOUNT and BILLING_GCLOUD_ACCOUNT (billing reads C11/C14; both required, the billing
# user is not the project Owner in GCLOUD_ACCOUNT, and a missing one is a FAIL naming the variable),
# NEON_PROJECT_ID (for the Neon check).
#
set -uo pipefail

MODE="${1:---static}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FAILS=0
# grep without -q: under pipefail a quiet grep exits early and the writer's SIGPIPE flips the pipeline.
qgrep() { grep "$@" >/dev/null; }
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILS=$((FAILS + 1)); }

CI=.circleci/config.yml

# ------------------------------------------------------------------------------------------
# STATIC
# ------------------------------------------------------------------------------------------

# Files whose contents are rules about the rules (ban lists, fakes) and so would match them.
is_exempt() {
  case "$1" in
    ./scripts/cost_check.sh|./scripts/cost_check_selftest.sh|./infra/plan_gate.sh) return 0 ;;
    ./scripts/ci/test_*.sh) return 0 ;;
  esac
  return 1
}

code_files() {
  find . \( -name node_modules -o -name .git -o -name .terraform -o -name .venv \
            -o -name .next -o -name .vercel \) -prune -o \
       -type f \( -name '*.sh' -o -name '*.tf' -o -name '*.tfvars' -o -name '*.tfvars.example' \
                  -o -name Makefile -o -name '*.mk' -o -path "./$CI" \) -print
}

# label<TAB>file<TAB>logical line. The label is the CircleCI job for the CI config, else the file.
build_lines() {
  local f
  : > "$LINES"
  while IFS= read -r f; do
    is_exempt "$f" && continue
    perl -0777 -pe 's/\\\n[ \t]*//g' "$f" | awk -v file="${f#./}" -v ci="$CI" '
      file == ci && /^  [A-Za-z0-9_-]+:[ \t]*$/ { job = $1; sub(":", "", job) }
      /^[ \t]*(#|\/\/|\*|\/\*)/ { next }
      { label = (file == ci) ? (job != "" ? job : "ci") : file; print label "\t" file "\t" $0 }' >> "$LINES"
  done < <(code_files)
}

# The rule engine. Reads the normalised lines on stdin, prints PASS/FAIL per category.
SCAN_PL='
use strict; use warnings;
my @order = (
  "min-instances missing or not 0", "max-instances missing", "max-instances out of range",
  "job missing --task-timeout or --max-retries 0", "public-access flag", "always-on or network flag",
  "manual-scaling flag", "managed build or --source", "region outside us-east4/us-east1",
  "resource_class outside small/medium", "docker_layer_caching enabled", "docker build flags",
  "docker pull or cache-from", "terraform banned resource or API",
  "run deploy missing --service-account",
);
my %hits; my $lines = 0; my $deploys = 0;
sub hit { my ($c, $l) = @_; $hits{$c}{$l} = 1; }
my %region_ok = ("us-east4" => 1, "us-east1" => 1);
sub region_value_ok { my $v = shift; return 1 if $region_ok{$v}; return 1 if $v =~ /^(?:\$|var\.|local\.)/; return 0; }

my $TF_BAN = qr/invoker[-_]iam[-_]disabled|scaling[-_]?mode|scalingMode|manual[-_]?instance[-_]?count|manualInstanceCount|min[-_]?instance[-_]?count|worker[-_]?pool|google_cloud_run|google_compute_|google_sql_|google_redis_|google_vpc_access|google_container_|google_cloud_scheduler|google_monitoring_uptime|REMOTE_REPOSITORY|user_managed|(?:cloudbuild|compute|container|sqladmin|redis|vpcaccess|cloudscheduler)\.googleapis|containerscanning|ondemandscanning/;

while (my $row = <STDIN>) {
  chomp $row; my ($label, $file, $line) = split /\t/, $row, 3; next unless defined $line;
  $lines++;
  my $is_tf = $file =~ /\.tf(?:vars)?(?:\.example)?$/;
  my $gc = $line =~ /\bgcloud\b|"\$\{G\[\@\]\}"|\brun\s+(?:deploy|services|jobs|revisions)\b/;

  if ($gc) {
    if ($line =~ /\brun\s+deploy\b/) {
      $deploys++;
      hit("min-instances missing or not 0", $label) unless $line =~ /--min-instances[= ]+0(?!\d)/;
      hit("max-instances missing", $label)          unless $line =~ /--max-instances[= ]+[1-3](?!\d)/;
    }
    # The default Compute service account holds roles/editor; a service must never fall back to it.
    if ($line =~ /\brun\s+(?:jobs\s+)?deploy\b/) {
      hit("run deploy missing --service-account", $label) unless $line =~ /--service-account[= ]+\S/;
    }
    if ($line =~ /\brun\s+jobs\s+deploy\b/) {
      hit("job missing --task-timeout or --max-retries 0", $label)
        unless $line =~ /--task-timeout/ && $line =~ /--max-retries[= ]+0(?!\d)/;
    }
    while ($line =~ /--max-instances[= ]+(\d+)/g) { hit("max-instances out of range", $label) if $1 < 1 || $1 > 3; }
    hit("public-access flag", $label)     if $line =~ /(?:^|\s)--allow-unauthenticated|--no-invoker-iam-check|invoker[-_]iam[-_]disabled/;
    hit("always-on or network flag", $label)
      if $line =~ /--no-cpu-throttling|--vpc-connector|--network(?![-\w])|--subnet|--vpc-egress|--gpu|--min(?:-instances)?[= ]+0*[1-9]/;
    hit("manual-scaling flag", $label)    if $line =~ /--scaling|scalingMode|manualInstanceCount|services\s+replace|worker-pools/;
    hit("managed build or --source", $label) if $line =~ /--source|--flags-file|gcloud\s+builds/;
  }

  hit("public-access flag", $label) if $line =~ /allUsers|allAuthenticatedUsers/;

  while ($line =~ /(?<![A-Za-z0-9_])((?:us|europe|asia|africa|australia|northamerica|southamerica|me)-[a-z]+\d+)(?![A-Za-z0-9])/g) {
    hit("region outside us-east4/us-east1", "$label ($1)") unless $region_ok{$1};
  }
  while ($line =~ /(?:--region|--location)[= ]\s*["\x27]?([^"\x27\s]+)/g)  { hit("region outside us-east4/us-east1", "$label ($1)") unless region_value_ok($1); }
  while ($line =~ /\bREGION=["\x27]?([^"\x27\s]+)/g)                    { hit("region outside us-east4/us-east1", "$label ($1)") unless region_value_ok($1); }
  while ($line =~ /\b(?:region|location)\s*=\s*"([^"]+)"/g)             { hit("region outside us-east4/us-east1", "$label ($1)") unless region_value_ok($1); }

  while ($line =~ /resource_class:\s*["\x27]?([^"\x27\s#]+)/g) { hit("resource_class outside small/medium", "$label ($1)") unless $1 =~ /^(?:small|medium)$/; }
  while ($line =~ /docker_layer_caching:\s*["\x27]?(\w+)/gi)   { hit("docker_layer_caching enabled", $label) if lc($1) ne "false"; }

  if ($line =~ /\bdocker\s+(?:buildx\s+)?build\b|\bbuildx\s+build\b/) {
    hit("docker build flags", $label)
      unless $line =~ /--provenance=false/ && $line =~ /--sbom=false/ && $line =~ /--load/ && $line !~ /--push/;
  }
  hit("docker pull or cache-from", $label) if $line =~ /\bdocker\s+pull\b|--cache-from/;

  hit("terraform banned resource or API", $label) if $is_tf && $line =~ $TF_BAN;
}

print "SCANNED $lines $deploys\n";
for my $c (@order) {
  if ($hits{$c}) { print "FAIL $c: $_\n" for sort keys %{$hits{$c}}; }
  else           { print "PASS no $c\n"; }
}
'

static_checks() {
  local need
  for need in "$CI" infra scripts; do
    [ -e "$need" ] || { fail "required path missing: $need"; return; }
  done
  command -v perl >/dev/null || { fail "perl is required"; return; }

  LINES="$(mktemp)"
  build_lines

  local out line scanned_lines scanned_deploys
  out="$(perl -e "$SCAN_PL" < "$LINES")"
  scanned_lines="$(printf '%s\n' "$out" | awk '/^SCANNED /{print $2}')"
  scanned_deploys="$(printf '%s\n' "$out" | awk '/^SCANNED /{print $3}')"

  # A scanner that sees nothing passes everything. It must see the deploy commands we know exist.
  if [ "${scanned_lines:-0}" -lt 50 ] || [ "${scanned_deploys:-0}" -lt 2 ]; then
    fail "scanner is blind: saw ${scanned_lines:-0} lines and ${scanned_deploys:-0} 'run deploy' commands (expected >= 50 and >= 2)"
  else
    pass "scanner saw ${scanned_lines} lines and ${scanned_deploys} deploy commands"
  fi
  while IFS= read -r line; do
    case "$line" in
      SCANNED*) ;;
      PASS*) pass "${line#PASS }" ;;
      FAIL*) fail "${line#FAIL }" ;;
    esac
  done <<< "$out"
  rm -f "$LINES"

  # The default Compute SA's Editor grant is removed by Terraform (infra/terraform/default_sa.tf).
  if grep -rhvE '^[[:space:]]*(#|//)' infra/terraform --include='*.tf' 2>/dev/null \
       | tr '\n' ' ' | qgrep -E 'google_project_iam_member_remove"[^{]*\{.{0,200}role[[:space:]]*=[[:space:]]*"roles/editor".{0,200}compute@developer\.gserviceaccount\.com'; then
    pass "terraform removes roles/editor from the default Compute service account"
  else
    fail "terraform does not remove roles/editor from the default Compute service account (google_project_iam_member_remove)"
  fi

  # ---- web: Vercel region and git deploys, Next images, regions, route layout ----
  local vj found_vj=0
  while IFS= read -r vj; do
    [ -z "$vj" ] && continue
    found_vj=1
    if [ "$(jq -c '.regions' "$vj" 2>/dev/null)" = '["iad1"]' ] && [ "$(jq -r '.git.deploymentEnabled' "$vj" 2>/dev/null)" = "false" ]; then
      pass "vercel.json pinned to iad1, git deploys off: ${vj#./}"
    else
      fail "vercel.json not pinned to iad1 / git deploys on / unreadable: ${vj#./}"
    fi
  done < <(find . \( -name node_modules -o -name .git -o -name .next -o -name .vercel \) -prune -o -name vercel.json -type f -print)
  [ "$found_vj" = 1 ] || fail "no vercel.json found"

  if [ -f web/next.config.ts ]; then
    if grep -vE '^[[:space:]]*(//|\*|/\*)' web/next.config.ts | qgrep -E 'unoptimized:[[:space:]]*true' \
       && ! grep -vE '^[[:space:]]*(//|\*|/\*)' web/next.config.ts | qgrep -E 'unoptimized:[[:space:]]*false'; then
      pass "next images unoptimized"
    else
      fail "next images not unoptimized (or only in a comment)"
    fi
  else
    fail "web/next.config.ts missing"
  fi

  if [ -d web/src ]; then
    local pr
    pr="$(grep -rEhv '^[[:space:]]*(//|\*|/\*)' web/src 2>/dev/null | grep -E 'preferredRegion' | grep -vE 'preferredRegion[[:space:]]*=[[:space:]]*(\[[[:space:]]*)?["'"'"']iad1["'"'"'][[:space:]]*\]?' || true)"
    if [ -n "$pr" ]; then fail "preferredRegion other than iad1 under web/src"; else pass "no non-iad1 preferredRegion"; fi
    if grep -rEhv '^[[:space:]]*(//|\*|/\*)' web/src 2>/dev/null | qgrep -E "runtime[[:space:]]*=[[:space:]]*[\"']edge[\"']"; then
      fail "edge runtime under web/src"
    else
      pass "no edge runtime"
    fi
  fi

  if [ -d web/src/app/api ]; then
    local routes n
    routes="$(find web/src/app/api -type f -name 'route.*' | sort)"
    n="$(printf '%s\n' "$routes" | grep -c . || true)"
    if [ "$n" = 1 ] && [ "$routes" = 'web/src/app/api/[...path]/route.ts' ]; then
      pass "exactly one route file under web/src/app/api"
    else
      fail "web/src/app/api route files: expected only [...path]/route.ts, found: $(printf '%s' "$routes" | tr '\n' ' ')"
    fi
  fi

  local dr src
  for dr in docs redoc openapi.json; do
    src="$(find "web/src/app/$dr" -maxdepth 1 -type f -name 'route.*' 2>/dev/null | head -1)"
    if [ -z "$src" ]; then fail "static doc route missing: web/src/app/$dr"; continue; fi
    if grep -vE '^[[:space:]]*(//|\*|/\*)' "$src" | qgrep -E "^[[:space:]]*export[[:space:]]+const[[:space:]]+dynamic[[:space:]]*=[[:space:]]*[\"']force-static[\"']" \
       && ! grep -vE '^[[:space:]]*(//|\*|/\*)' "$src" | qgrep -E 'lib/proxy|\.\./api|\[\.\.\.path\]|fetch\(|API_URL|process\.env'; then
      pass "static doc route, no proxy or network access: $src"
    else
      fail "doc route not force-static, or reaches the proxy/network/env: $src"
    fi
  done
}

# ------------------------------------------------------------------------------------------
# LIVE (read-only)
# ------------------------------------------------------------------------------------------
REGION=us-east4

gc() { # gcloud with the engineer's account when GCLOUD_ACCOUNT is set
  if [ -n "${GCLOUD_ACCOUNT:-}" ]; then gcloud --account "$GCLOUD_ACCOUNT" "$@"; else gcloud "$@"; fi
}

gcb() { # billing-account reads, as BILLING_GCLOUD_ACCOUNT (callers check it is set)
  gcloud --account "$BILLING_GCLOUD_ACCOUNT" "$@"
}

live_checks() {
  : "${PROJECT:?set PROJECT for --live}"
  command -v gcloud >/dev/null || { fail "gcloud not installed"; return; }
  command -v jq >/dev/null || { fail "jq not installed"; return; }
  if [ -z "${GCLOUD_ACCOUNT:-}" ]; then
    # CI masks the account in logs, so print it only when running by hand.
    if [ -n "${CIRCLECI:-}" ]; then
      echo "note: GCLOUD_ACCOUNT unset; using the active gcloud account (the CI deployer)"
    else
      echo "note: GCLOUD_ACCOUNT unset; using the active gcloud account: $(gcloud config get-value account 2>/dev/null)"
    fi
  fi

  # C1: max/min instances, service-level min, CPU throttling, scaling mode.
  local c1
  c1="$(gc run services list --region "$REGION" --project "$PROJECT" --format=json 2>/dev/null | jq -r '.[] | [.metadata.name, (.spec.template.metadata.annotations["autoscaling.knative.dev/maxScale"] // "UNSET"), (.spec.template.metadata.annotations["autoscaling.knative.dev/minScale"] // "0"), (.metadata.annotations["autoscaling.knative.dev/minScale"] // "0"), (.spec.template.metadata.annotations["run.googleapis.com/cpu-throttling"] // "true"), (.metadata.annotations["run.googleapis.com/scalingMode"] // "automatic")] | @tsv')"
  if [ -z "$c1" ]; then
    fail "C1 no Cloud Run services found (or field paths unverified)"
  else
    local name max min smin thr mode
    while IFS=$'\t' read -r name max min smin thr mode; do
      if [ "$max" != "UNSET" ] && [ "$max" -ge 1 ] 2>/dev/null && [ "$max" -le 3 ] && [ "$min" = 0 ] && [ "$smin" = 0 ] && [ "$thr" = true ] && [ "$mode" = automatic ]; then
        pass "C1 $name max=$max min=0 throttling=true scaling=automatic"
      else
        fail "C1 $name max=$max min=$min service-min=$smin throttling=$thr scaling=$mode"
      fi
    done <<< "$c1"
  fi

  # C3 probes /ready, not /healthz: Google's frontend answers /healthz itself with a 404, so that path can never show the IAM result.
  # C2 + C3: invoker members are EXACTLY the web and smoke identities; direct run.app is an IAM denial.
  local svc want got dis url c403 c401
  want="serviceAccount:clinic-smoke@${PROJECT}.iam.gserviceaccount.com
serviceAccount:clinic-web@${PROJECT}.iam.gserviceaccount.com"
  for svc in clinic-api clinic-realtime; do
    gc run services describe "$svc" --region "$REGION" --project "$PROJECT" >/dev/null 2>&1 || continue
    got="$(gc run services get-iam-policy "$svc" --region "$REGION" --project "$PROJECT" --format=json | jq -r '[.bindings[]? | select(.role == "roles/run.invoker") | .members[]] | sort | .[]')"
    dis="$(gc run services describe "$svc" --region "$REGION" --project "$PROJECT" --format=json | jq -r '.metadata.annotations["run.googleapis.com/invoker-iam-disabled"] // "false"')"
    if [ "$got" = "$want" ] && [ "$dis" = false ]; then
      pass "C2 $svc invoker members are exactly clinic-web and clinic-smoke"
    else
      fail "C2 $svc invoker members: [$(printf '%s' "$got" | tr '\n' ' ')] iam-disabled=$dis"
    fi
    url="$(gc run services describe "$svc" --region "$REGION" --project "$PROJECT" --format='value(status.url)')"
    c403="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url/ready")"
    c401="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H 'X-Serverless-Authorization: Bearer junk' "$url/ready")"
    if [ "$c403" = 403 ] && [ "$c401" = 401 ]; then pass "C3 $svc run.app 403 / junk-bearer 401"; else fail "C3 $svc run.app returned $c403 / $c401 (want 403 / 401)"; fi
  done

  # C4: migration job cannot hang or retry.
  local c4
  c4="$(gc run jobs describe clinic-migrate --region "$REGION" --project "$PROJECT" --format=json 2>/dev/null | jq -r '[.spec.template.spec.template.spec.maxRetries, .spec.template.spec.template.spec.timeoutSeconds] | map(tostring) | join(" ")')"
  [ "$c4" = "0 600" ] && pass "C4 migrate job maxRetries=0 timeout=600" || fail "C4 migrate job '$c4' (want '0 600')"

  # C5: Artifact Registry cleanup policies and size. A missing sizeBytes field is a FAIL, not a pass.
  local c5
  # gcloud's JSON for a repository omits sizeBytes (it only prints it as text), so the size comes
  # from the REST API, billed to this project.
  local c5_policies c5_size tok
  tok="$(gc auth print-access-token 2>/dev/null)"
  c5_policies="$(gc artifacts repositories describe clinic --location "$REGION" --project "$PROJECT" --format=json 2>/dev/null | jq -r '(.cleanupPolicies // {}) | keys | sort | join(",")' 2>/dev/null)"
  c5_size="$(curl -s -H "Authorization: Bearer $tok" -H "x-goog-user-project: $PROJECT" "https://artifactregistry.googleapis.com/v1/projects/$PROJECT/locations/$REGION/repositories/clinic" | jq -r '(.sizeBytes // empty) | tonumber | (. < 400000000) | tostring' 2>/dev/null)"
  c5="$c5_policies $c5_size"
  [ "$c5" = "delete-old,delete-untagged,keep-2 true" ] && pass "C5 AR cleanup policies and size" || fail "C5 AR '${c5:-no sizeBytes or unreadable}'"

  # C6: <= 2 versions per package (the listed name is a full path; use its basename).
  local pkg base cnt
  while IFS= read -r pkg; do
    [ -z "$pkg" ] && continue
    base="${pkg##*/}"
    cnt="$(gc artifacts versions list --package "$base" --repository clinic --location "$REGION" --project "$PROJECT" --format=json | jq length)"
    if [ "$cnt" -le 2 ]; then pass "C6 $base versions=$cnt"; else fail "artifact-registry $base versions=$cnt > 2"; fi
  done < <(gc artifacts packages list --repository clinic --location "$REGION" --project "$PROJECT" --format='value(name)' 2>/dev/null)

  # C7 + C8: <= 6 active secret versions, automatic replication.
  local s total=0 repl=""
  while IFS= read -r s; do
    [ -z "$s" ] && continue
    total=$((total + $(gc secrets versions list "$s" --project "$PROJECT" --filter='state!=DESTROYED' --format=json | jq length)))
    repl="$repl $(gc secrets describe "$s" --project "$PROJECT" --format=json | jq -r '.replication | keys[0]')"
  done < <(gc secrets list --project "$PROJECT" --format='value(name)')
  if [ "$total" -le 6 ]; then pass "C7 active secret versions=$total (<= 6)"; else fail "C7 active secret versions=$total > 6"; fi
  if [ "$(printf '%s\n' $repl | sort -u | tr '\n' ' ')" = "automatic " ] || [ -z "$repl" ]; then pass "C8 secret replication automatic"; else fail "C8 replication:$repl"; fi

  # C9: state bucket in a free region, STANDARD class, soft delete off.
  local c9
  c9="$(gc storage buckets describe "gs://clinic-tfstate-${PROJECT}" --project "$PROJECT" --format=json 2>/dev/null | jq -r '[.location, .default_storage_class, (.soft_delete_policy.retentionDurationSeconds // "0")] | join(" ")')"
  [ "$c9" = "US-EAST1 STANDARD 0" ] && pass "C9 state bucket US-EAST1 STANDARD soft-delete off" || fail "C9 state bucket '${c9:-unreadable}' (want 'US-EAST1 STANDARD 0')"

  # C10: paid scanners and managed build disabled.
  if gc services list --enabled --project "$PROJECT" --format='value(config.name)' | qgrep -E 'containerscanning|ondemandscanning|cloudbuild'; then
    fail "C10 a paid scanner or managed build API is enabled"
  else
    pass "C10 paid scanners and managed build disabled"
  fi

  # C11: both budgets exist. The cap ACTION is a console setting and cannot be read from the API.
  if [ -z "${BILLING_GCLOUD_ACCOUNT:-}" ] && [ -n "${CIRCLECI:-}" ]; then
    echo "SKIP  C11 budgets: billing checks run locally as BILLING_GCLOUD_ACCOUNT (the CI deployer has no billing role on the shared account)"
  elif [ -z "${BILLING_GCLOUD_ACCOUNT:-}" ]; then
    fail "C11 BILLING_GCLOUD_ACCOUNT unset: the billing user (not the project Owner) must read the budgets"
  elif [ -n "${BILLING_ACCOUNT:-}" ]; then
    local c11
    # --billing-project: the budgets API is billed to a project the caller can use; the billing user's gcloud default quota project may not be one.
    c11="$(gcb --billing-project "$PROJECT" billing budgets list --billing-account "$BILLING_ACCOUNT" --format=json 2>/dev/null | jq -r '[.[].displayName | select(startswith("clinic-"))] | sort | join(",")')"
    [ "$c11" = "clinic-alerts-1usd,clinic-run-spend-cap-3usd" ] && pass "C11 both budgets exist (cap action: confirm in the console)" || fail "C11 budgets '${c11:-unreadable}'"
  else
    fail "C11 skipped: set BILLING_ACCOUNT to check the budgets"
  fi

  # C12: the egress alert policy exists. Read through the REST API with the account's token (as C5
  # does): in CI the gcloud `monitoring policies list` wrapper found nothing for the deployer even
  # though the policy exists and the same call works as the deployer by hand. The HTTP status is
  # printed on failure so the cause is visible.
  local c12_tok c12_body c12_code c12_n
  c12_tok="$(gc auth print-access-token 2>/dev/null)"
  c12_body="$(mktemp)"
  c12_code="$(curl -s -o "$c12_body" -w '%{http_code}' -H "Authorization: Bearer $c12_tok" -H "x-goog-user-project: $PROJECT" \
    -G "https://monitoring.googleapis.com/v3/projects/$PROJECT/alertPolicies" --data-urlencode 'filter=display_name="clinic-run-egress-daily"')"
  c12_n="$(jq -r '(.alertPolicies // []) | length' "$c12_body" 2>/dev/null)"
  if [ "$c12_code" = 200 ] && [ "${c12_n:-0}" -ge 1 ]; then
    pass "C12 egress alert policy exists"
  else
    fail "C12 egress alert policy clinic-run-egress-daily not found (HTTP $c12_code, matches: ${c12_n:-none}, $(jq -r '.error.message // empty' "$c12_body" 2>/dev/null | cut -c1-120))"
  fi
  rm -f "$c12_body"

  # C13: Neon project region and fixed size (needs neonctl; reported as SKIP, never as PASS).
  if command -v neonctl >/dev/null && [ -n "${NEON_PROJECT_ID:-}" ]; then
    local c13
    c13="$(neonctl projects get "$NEON_PROJECT_ID" -o json 2>/dev/null | jq -r '[.region_id, .default_endpoint_settings.autoscaling_limit_min_cu, .default_endpoint_settings.autoscaling_limit_max_cu] | map(tostring) | join(" ")')"
    [ "$c13" = "aws-us-east-1 0.25 0.25" ] && pass "C13 Neon aws-us-east-1 fixed 0.25 CU" || fail "C13 Neon '${c13:-unreadable}'"
  else
    echo "SKIP  C13 Neon region and size: needs neonctl and NEON_PROJECT_ID (check the console instead)"
  fi

  # C14: the billing account is SHARED (PLAN 11.1 Q14), so the free tiers are shared with the
  # projects in scripts/shared_billing_projects.txt. A project that joins (or leaves) the account
  # changes the headroom and must be re-measured with scripts/shared_headroom.py first.
  if [ -z "${BILLING_GCLOUD_ACCOUNT:-}" ] && [ -n "${CIRCLECI:-}" ]; then
    echo "SKIP  C14 project list: billing checks run locally as BILLING_GCLOUD_ACCOUNT (the CI deployer has no billing role on the shared account)"
  elif [ -z "${BILLING_GCLOUD_ACCOUNT:-}" ]; then
    fail "C14 BILLING_GCLOUD_ACCOUNT unset: the billing user must list the projects on the billing account"
  elif [ -n "${BILLING_ACCOUNT:-}" ]; then
    local c14 want14
    c14="$(gcb billing projects list --billing-account "$BILLING_ACCOUNT" --format='value(projectId)' 2>/dev/null | sort | tr '\n' ' ')"
    want14="$(sort scripts/shared_billing_projects.txt | tr '\n' ' ')"
    [ "$c14" = "$want14" ] && pass "C14 billing account holds exactly the recorded projects" || fail "C14 projects on the billing account: ${c14:-unreadable} (recorded: $want14)"
  else
    fail "C14 skipped: set BILLING_ACCOUNT"
  fi

  # C20: the default Compute service account has no roles/editor (Terraform removes the binding).
  local num c20
  # CI has the number in GOOGLE_PROJECT_NUMBER (no resourcemanager.projects.get needed).
  num="${GOOGLE_PROJECT_NUMBER:-$(gc projects describe "$PROJECT" --format='value(projectNumber)' 2>/dev/null)}"
  if [ -n "$num" ]; then
    c20="$(gc projects get-iam-policy "$PROJECT" --format=json 2>/dev/null | jq -r --arg m "serviceAccount:${num}-compute@developer.gserviceaccount.com" '[.bindings[]? | select(.role == "roles/editor") | .members[]? | select(. == $m)] | length')"
    [ "$c20" = 0 ] && pass "C20 default Compute SA has no roles/editor" || fail "C20 default Compute SA roles/editor bindings: ${c20:-unreadable}"
  else
    fail "C20 could not read the project number"
  fi

  # C18: logging stays default plus the one free exclusion.
  local sinks ret excl
  sinks="$(gc logging sinks list --project "$PROJECT" --format='value(name)' | sort | tr '\n' ' ')"
  ret="$(gc logging buckets describe _Default --location=global --project "$PROJECT" --format='value(retentionDays)')"
  excl="$(gc logging sinks describe _Default --project "$PROJECT" --format=json | jq -r '[.exclusions[]?.name] | join(",")')"
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
