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

# C11 (evidence half): the API cannot say whether a budget has a spend cap, so the console value is
# recorded in docs/evidence/spend-cap-2026-10-18.md and read here. It must exist, name the budget id
# and record "Spend cap status: Configured"; anything else fails.
SPEND_CAP_EVIDENCE=docs/evidence/spend-cap-2026-10-18.md
SPEND_CAP_BUDGET_ID=bfd734ab-ef98-414a-8bb1-b6442c1dec94
spend_cap_evidence() {
  local f=$SPEND_CAP_EVIDENCE
  if [ ! -f "$f" ]; then fail "C11 cap status not readable via API; evidence file missing: $f"; return; fi
  if ! grep -qE '^- Spend cap status: Configured[[:space:]]*$' "$f"; then
    fail "C11 cap status not readable via API; $f does not record 'Spend cap status: Configured' (the budget is alerts-only until it does)"; return
  fi
  if ! grep -qF "$SPEND_CAP_BUDGET_ID" "$f"; then
    fail "C11 cap status not readable via API; $f does not name budget id $SPEND_CAP_BUDGET_ID"; return
  fi
  pass "C11 cap status not readable via API; see $f (records Configured for budget $SPEND_CAP_BUDGET_ID)"
}

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
  "clinic-realtime deploy not pinned",
);
my %hits; my $lines = 0; my $deploys = 0; my $realtime_deploys = 0;
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
    if ($line =~ /\brun\s+deploy\s+clinic-realtime\b/) {
      # The live-feed gateway scales from zero to at most two instances on demand and back to zero:
      # one stream per instance (concurrency 1, which is also what Cloud Run requires below 1 vCPU),
      # at most a quarter or a half vCPU, request-based billing (no --no-cpu-throttling, checked
      # above), the 15-minute request timeout, and no public access.
      # The release pipeline must deploy it exactly once; the bootstrap shell is pinned the same way.
      $realtime_deploys++ if $file =~ m{^\.circleci/};
      my $ok = $line =~ /--min-instances[= ]+0(?!\d)/
            && $line =~ /--max-instances[= ]+2(?!\d)/
            && $line =~ /--concurrency[= ]+1(?!\d)/
            && $line =~ /--cpu[= ]+(?:0\.25|0\.5)(?![\d.])/
            && $line =~ /--memory[= ]+(?:128|256|512)Mi(?!\w)/
            && $line =~ /--timeout[= ]+900(?!\d)/
            && $line =~ /--no-allow-unauthenticated/;
      hit("clinic-realtime deploy not pinned", $label) unless $ok;
    }
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

hit("clinic-realtime deploy not pinned", "the pipeline has no single gcloud run deploy clinic-realtime") if $realtime_deploys != 1;
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

  spend_cap_evidence

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

  if [ -f apps/booking/next.config.ts ]; then
    if grep -vE '^[[:space:]]*(//|\*|/\*)' apps/booking/next.config.ts | qgrep -E 'unoptimized:[[:space:]]*true' \
       && ! grep -vE '^[[:space:]]*(//|\*|/\*)' apps/booking/next.config.ts | qgrep -E 'unoptimized:[[:space:]]*false'; then
      pass "next images unoptimized"
    else
      fail "next images not unoptimized (or only in a comment)"
    fi
  else
    fail "apps/booking/next.config.ts missing"
  fi

  if [ -d apps/booking/src ]; then
    local pr
    pr="$(grep -rEhv '^[[:space:]]*(//|\*|/\*)' apps/*/src packages/*/src 2>/dev/null | grep -E 'preferredRegion' | grep -vE 'preferredRegion[[:space:]]*=[[:space:]]*(\[[[:space:]]*)?["'"'"']iad1["'"'"'][[:space:]]*\]?' || true)"
    if [ -n "$pr" ]; then fail "preferredRegion other than iad1 under apps/*/src or packages/*/src"; else pass "no non-iad1 preferredRegion"; fi
    if grep -rEhv '^[[:space:]]*(//|\*|/\*)' apps/*/src packages/*/src 2>/dev/null | qgrep -E "runtime[[:space:]]*=[[:space:]]*[\"']edge[\"']"; then
      fail "edge runtime under apps/*/src or packages/*/src"
    else
      pass "no edge runtime"
    fi
  fi

  if [ -d apps/booking/src/app/api ]; then
    local routes n
    routes="$(find apps/booking/src/app/api -type f -name 'route.*' | sort)"
    n="$(printf '%s\n' "$routes" | grep -c . || true)"
    if [ "$n" = 1 ] && [ "$routes" = 'apps/booking/src/app/api/[...path]/route.ts' ]; then
      pass "exactly one route file under apps/booking/src/app/api"
    else
      fail "apps/booking/src/app/api route files: expected only [...path]/route.ts, found: $(printf '%s' "$routes" | tr '\n' ' ')"
    fi
  fi

  local dr src
  for dr in docs redoc openapi.json; do
    src="$(find "apps/booking/src/app/$dr" -maxdepth 1 -type f -name 'route.*' 2>/dev/null | head -1)"
    if [ -z "$src" ]; then fail "static doc route missing: apps/booking/src/app/$dr"; continue; fi
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

# C5 (Artifact Registry): a cost guard with two bounds and a note that is not a bound.
#
# 1. The ceiling comes from the approved monthly total, not from a free tier. Artifact Registry's
#    free 0.5 GiB is per ACCOUNT (cloud.google.com/artifact-registry/pricing, read 2026-10-19:
#    "0.5 gibibyte month and above $0.000136986 / 1 gibibyte hour, per 1 month / account"), and this
#    project shares its billing account with projects that already use it up, so every byte of ours is
#    billed: $0.000136986 x 730 h = $0.10 per GiB-month. The approved total is $0.50 a month.
#    Secret Manager takes $0.06 per active version, counted LIVE (C7) so a new secret lowers the
#    registry's share instead of silently breaking the total. What is left, at $0.10 per GiB, is the
#    ceiling. With 5 live versions that is $0.20, 2 GiB; with 4 it is 2.6 GiB.
# 2. The kept versions' `metadata.imageSizeBytes`, summed (shared layers are counted once per image, so
#    this over-counts: the conservative direction). Two API images of about 64.1 MB plus two Go images
#    of at most 25 MB = 178.2 MB, rounded up to 200 MB. The Go gateway is not built yet (#71), so this
#    bound already budgets for an image that is not in the registry.
# 3. The repository `sizeBytes` is larger than the kept images while layers of deleted images wait for
#    the registry's daily garbage collection ("Deleting images doesn't immediately delete the referenced
#    layers. Unreferenced layers are deleted daily", docs.cloud.google.com/artifact-registry/docs/docker/manage-images).
#    The difference is reported, not judged.
# The ceiling is checked against sizeBytes PLUS the Go images that are not in the repository yet, at the
# 25 MB cap the Go build is to enforce (a cap, not a measured size: replace it with the measured size once
# #71 builds the image), so the headroom printed is the one that will be left.
AR_PRICE_MICRODOLLARS_PER_GIB_MONTH=100000   # $0.000136986 per GiB-hour x 730 h
COST_CEILING_MICRODOLLARS=500000             # the approved total: $0.50 a month (raised from about $0.34 by the engineer, 2026-10-19)
SECRET_VERSION_MICRODOLLARS=60000            # Secret Manager, per active version a month
GIB_BYTES=1073741824
AR_KEPT_IMAGES_BOUND_BYTES=200000000
AR_GO_PACKAGE=clinic-realtime                # not built yet (#71): counted as projected until it exists
AR_GO_VERSIONS=2
AR_GO_IMAGE_BYTES=25000000                   # the cap for the Go image, not a measurement
MAX_DIGITS=15                                # sizes above this are not sizes; also keeps the arithmetic far from overflow

# A whole number: digits only, no leading zero (08 and 0777 are octal traps in shell arithmetic), at
# most MAX_DIGITS long.
is_whole_number() {
  case "$1" in
    0) return 0 ;;
    ''|0*|*[!0-9]*) return 1 ;;
  esac
  [ "${#1}" -le "$MAX_DIGITS" ]
}
# ar_budget_ceiling_bytes <live secret versions>: the registry's share of the approved total, in bytes.
ar_budget_ceiling_bytes() {
  is_whole_number "$1" || return 1
  local left=$((COST_CEILING_MICRODOLLARS - $1 * SECRET_VERSION_MICRODOLLARS))
  [ "$left" -gt 0 ] || { echo 0; return 0; }
  echo $((left * GIB_BYTES / AR_PRICE_MICRODOLLARS_PER_GIB_MONTH))
}
# ar_projected_bytes <sizeBytes> <go_in_repository yes|no>: the Go images not yet pushed are added.
ar_projected_bytes() {
  if [ "$2" = yes ]; then echo "$1"; else echo $(($1 + AR_GO_VERSIONS * AR_GO_IMAGE_BYTES)); fi
}
# ar_repo_within_budget <sizeBytes> <go yes|no> <live secret versions>: strictly under the ceiling after the projection.
ar_repo_within_budget() {
  is_whole_number "$1" && is_whole_number "${3:-}" || return 1
  [ "$(ar_projected_bytes "$1" "${2:-no}")" -lt "$(ar_budget_ceiling_bytes "$3")" ]
}
# ar_headroom_bytes <sizeBytes> <go yes|no> <live secret versions>
ar_headroom_bytes() { echo $(($(ar_budget_ceiling_bytes "$3") - $(ar_projected_bytes "$1" "${2:-no}"))); }
ar_kept_within_bound() { is_whole_number "$1" && [ "$1" -ge 1 ] && [ "$1" -le "$AR_KEPT_IMAGES_BOUND_BYTES" ]; }
# dollars <microdollars>: 500000 -> 0.5000
dollars() { printf '%d.%04d' $(($1 / 1000000)) $((($1 % 1000000) / 100)); }
# redact: no account names in CI output
redact() { sed -E 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/<account>/g'; }

# Checks that could not run in this environment are UNVERIFIED, never a quiet pass. Each one is named;
# the run ends PARTIAL, and exits non-zero unless COST_CHECK_ALLOW_UNVERIFIED lists it.
UNVERIFIED=""
unverified() { # <id> <reason>
  UNVERIFIED="$UNVERIFIED $1"; printf 'UNVERIFIED  %s: %s\n' "$1" "$2"
}
# finish_unverified <allow list>: prints the verdict line parts, returns 0 when every unverified id is allowed.
unverified_allowed() {
  local id; for id in $UNVERIFIED; do case " ${1:-} " in *" $id "*) ;; *) return 1 ;; esac; done
}

# c6_judge <package> <all versions> <tagged versions>: C6 counts tagged versions only; untagged ones
# are pending cleanup (delete-untagged) and are a note, not a failure.
c6_judge() {
  local base="$1" all="$2" tagged="$3"
  if [ "$tagged" -le 2 ]; then pass "C6 $base tagged versions=$tagged"; else fail "C6 artifact-registry $base tagged versions=$tagged > 2"; fi
  if [ "$all" -gt "$tagged" ]; then echo "note  C6 $base has $((all - tagged)) untagged version(s) pending the delete-untagged cleanup policy ($all versions in all); their bytes are capped by C5"; fi
}

gc() { # gcloud with the engineer's account when GCLOUD_ACCOUNT is set
  if [ -n "${GCLOUD_ACCOUNT:-}" ]; then gcloud --account "$GCLOUD_ACCOUNT" "$@"; else gcloud "$@"; fi
}

gcb() { # billing-account reads, as BILLING_GCLOUD_ACCOUNT (callers check it is set)
  gcloud --account "$BILLING_GCLOUD_ACCOUNT" "$@"
}

# is_secret_count: a count of versions, 1 to 4 digits and no leading zero (no octal reading, no overflow).
is_secret_count() { is_whole_number "$1" && [ "${#1}" -le 4 ]; }
# count_secrets: sets SECRET_VERSIONS_LIVE (active versions over every secret) and SECRET_REPL. If any
# call fails, the list is empty, or a count is not a number, SECRET_VERSIONS_LIVE stays empty and
# SECRET_COUNT_ERROR says why: a count that could not be read is never taken as 0, because 0 versions
# would turn into the largest possible registry ceiling.
count_secrets() {
  local s n names vjson desc
  SECRET_VERSIONS_LIVE=""; SECRET_REPL=""; SECRET_COUNT_ERROR=""
  names="$(gc secrets list --project "$PROJECT" --format='value(name)' 2>/dev/null)" || { SECRET_COUNT_ERROR="listing the secrets failed"; return; }
  [ -n "$names" ] || { SECRET_COUNT_ERROR="the secret list is empty (wrong project or missing scope), so no count can be trusted"; return; }
  local total=0
  while IFS= read -r s; do
    [ -z "$s" ] && continue
    vjson="$(gc secrets versions list "$s" --project "$PROJECT" --filter='state!=DESTROYED' --format=json 2>/dev/null)" || { SECRET_COUNT_ERROR="listing the versions of a secret failed"; return; }
    n="$(jq 'length' <<<"$vjson" 2>/dev/null)" || { SECRET_COUNT_ERROR="the versions of a secret were not a list"; return; }
    is_secret_count "$n" || [ "$n" = 0 ] || { SECRET_COUNT_ERROR="a secret reported a version count that is not a number"; return; }
    total=$((total + n))
    desc="$(gc secrets describe "$s" --project "$PROJECT" --format=json 2>/dev/null)" || { SECRET_COUNT_ERROR="describing a secret failed"; return; }
    SECRET_REPL="$SECRET_REPL $(jq -r '.replication | keys[0]' <<<"$desc" 2>/dev/null)"
  done <<<"$names"
  is_secret_count "$total" || [ "$total" = 0 ] || { SECRET_COUNT_ERROR="the total version count is out of range"; return; }
  SECRET_VERSIONS_LIVE="$total"
}

# judge_c1: one tab-separated row per service on stdin (name, maxScale, template minScale, service
# minScale, cpu-throttling, scaling mode). The gateway must scale from zero to EXACTLY two instances
# on demand; the API to between one and three. Request-based billing (throttling true), automatic
# scaling and a minimum of zero hold for both.
judge_c1() {
  local name max min smin thr mode top floor
  while IFS=$'\t' read -r name max min smin thr mode; do
    top=3 floor=1
    if [ "$name" = clinic-realtime ]; then top=2 floor=2; fi
    if [ "$max" != "UNSET" ] && [ "$max" -ge "$floor" ] 2>/dev/null && [ "$max" -le "$top" ] && [ "$min" = 0 ] && [ "$smin" = 0 ] && [ "$thr" = true ] && [ "$mode" = automatic ]; then
      pass "C1 $name max=$max min=0 throttling=true scaling=automatic"
    else
      fail "C1 $name max=$max min=$min service-min=$smin throttling=$thr scaling=$mode"
    fi
  done
}

# judge_c2 <service> <iam-disabled>: the invoker members on stdin, one per line. The API admits the
# web proxy, the admin app and the smoke identity; the gateway only the admin app and the smoke
# identity (the public booking proxy never reaches it).
judge_c2() {
  local svc="$1" dis="$2" got want who
  got="$(sort)"
  want="serviceAccount:clinic-admin@${PROJECT}.iam.gserviceaccount.com
serviceAccount:clinic-smoke@${PROJECT}.iam.gserviceaccount.com"
  who="clinic-admin and clinic-smoke"
  if [ "$svc" != clinic-realtime ]; then
    want="$want
serviceAccount:clinic-web@${PROJECT}.iam.gserviceaccount.com"
    who="clinic-web, clinic-admin and clinic-smoke"
  fi
  want="$(printf '%s\n' "$want" | sort)"
  if [ "$got" = "$want" ] && [ "$dis" = false ]; then
    pass "C2 $svc invoker members are exactly $who"
  else
    fail "C2 $svc invoker members: [$(printf '%s' "$got" | tr '\n' ' ')] iam-disabled=$dis"
  fi
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
    judge_c1 <<< "$c1"
  fi

  # C3 probes /ready, not /healthz: Google's frontend answers /healthz itself with a 404, so that path can never show the IAM result.
  # C2 + C3: invoker members are exactly the identities each service admits; direct run.app is an IAM denial.
  local svc got dis url c403 c401
  for svc in clinic-api clinic-realtime; do
    gc run services describe "$svc" --region "$REGION" --project "$PROJECT" >/dev/null 2>&1 || continue
    got="$(gc run services get-iam-policy "$svc" --region "$REGION" --project "$PROJECT" --format=json | jq -r '[.bindings[]? | select(.role == "roles/run.invoker") | .members[]] | sort | .[]')"
    dis="$(gc run services describe "$svc" --region "$REGION" --project "$PROJECT" --format=json | jq -r '.metadata.annotations["run.googleapis.com/invoker-iam-disabled"] // "false"')"
    judge_c2 "$svc" "$dis" <<< "$got"
    url="$(gc run services describe "$svc" --region "$REGION" --project "$PROJECT" --format='value(status.url)')"
    c403="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url/ready")"
    c401="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H 'X-Serverless-Authorization: Bearer junk' "$url/ready")"
    if [ "$c403" = 403 ] && [ "$c401" = 401 ]; then pass "C3 $svc run.app 403 / junk-bearer 401"; else fail "C3 $svc run.app returned $c403 / $c401 (want 403 / 401)"; fi
  done

  # C4: migration job cannot hang or retry.
  local c4
  c4="$(gc run jobs describe clinic-migrate --region "$REGION" --project "$PROJECT" --format=json 2>/dev/null | jq -r '[.spec.template.spec.template.spec.maxRetries, .spec.template.spec.template.spec.timeoutSeconds] | map(tostring) | join(" ")')"
  [ "$c4" = "0 600" ] && pass "C4 migrate job maxRetries=0 timeout=600" || fail "C4 migrate job '$c4' (want '0 600')"

  # C5: cleanup policies, then the cost ceiling and the kept images. A missing sizeBytes field, an empty
  # image list or a refused call is a FAIL, never a pass, and each says which it was.
  # gcloud's JSON for a repository omits sizeBytes (it only prints it as text), so the size comes
  # from the REST API, billed to this project. The token goes in through a header file on stdin,
  # never on curl's command line.
  local c5_policies c5_size c5_kept c5_versions c5_http c5_body c5_go c5_pkgs c5_tok c5_err c5_head c5_ceil c5_ar_micro
  count_secrets
  c5_ceil=""
  if [ -n "$SECRET_COUNT_ERROR" ]; then
    fail "C5 AR the registry ceiling cannot be worked out: $SECRET_COUNT_ERROR"
  else
    c5_ceil="$(ar_budget_ceiling_bytes "$SECRET_VERSIONS_LIVE")"
  fi
  c5_policies="$(gc artifacts repositories describe clinic --location "$REGION" --project "$PROJECT" --format=json 2>/dev/null | jq -r '(.cleanupPolicies // {}) | keys | sort | join(",")' 2>/dev/null)"
  [ "$c5_policies" = "delete-old,delete-untagged,keep-2" ] && pass "C5 AR cleanup policies" || fail "C5 AR cleanup policies '${c5_policies:-unreadable}' (want delete-old,delete-untagged,keep-2)"
  c5_tok="$(gc auth print-access-token 2>/dev/null)"
  c5_body="$(mktemp)"; c5_http=""
  if [ -z "$c5_tok" ]; then
    fail "C5 AR could not mint an access token for the CI identity, so the repository size is unknown"
  else
    c5_http="$(printf 'Authorization: Bearer %s\n' "$c5_tok" | curl -s -o "$c5_body" -w '%{http_code}' -H @- -H "x-goog-user-project: $PROJECT" "https://artifactregistry.googleapis.com/v1/projects/$PROJECT/locations/$REGION/repositories/clinic")"
  fi
  c5_size="$(jq -r '.sizeBytes // empty' "$c5_body" 2>/dev/null)"
  rm -f "$c5_body"
  c5_go=no
  c5_pkgs="$(gc artifacts packages list --repository clinic --location "$REGION" --project "$PROJECT" --format='value(name)' 2>/dev/null)" || echo "note  C5 AR could not list the packages; the Go images are counted as not pushed yet"
  # `value(name)` prints the bare package name; older output printed the full resource path. Accept both.
  sed 's#.*/##' <<<"$c5_pkgs" | grep -qx "$AR_GO_PACKAGE" && c5_go=yes
  if [ -n "$c5_tok" ] && [ -z "$SECRET_COUNT_ERROR" ]; then
    if [ "$c5_http" != 200 ]; then
      fail "C5 AR repository read refused or failed (HTTP ${c5_http:-none}); the size is unknown"
    elif ! is_whole_number "$c5_size"; then
      fail "C5 AR repository sizeBytes is '${c5_size:-missing from an HTTP 200 response}', not a size"
    else
      c5_ar_micro=$((c5_size * AR_PRICE_MICRODOLLARS_PER_GIB_MONTH / GIB_BYTES))
      if ar_repo_within_budget "$c5_size" "$c5_go" "$SECRET_VERSIONS_LIVE"; then
        c5_head="$(ar_headroom_bytes "$c5_size" "$c5_go" "$SECRET_VERSIONS_LIVE")"
        pass "C5 AR repository sizeBytes=$c5_size, headroom $c5_head B under the $c5_ceil B ceiling ($SECRET_VERSIONS_LIVE live secret versions leave \$$(dollars $((COST_CEILING_MICRODOLLARS - SECRET_VERSIONS_LIVE * SECRET_VERSION_MICRODOLLARS))) of the \$$(dollars "$COST_CEILING_MICRODOLLARS") total; go images in repository: $c5_go, projected add: $([ "$c5_go" = yes ] && echo 0 || echo $((AR_GO_VERSIONS * AR_GO_IMAGE_BYTES))) B)"
      else
        fail "C5 AR the approved total \$$(dollars "$COST_CEILING_MICRODOLLARS") a month cannot hold: $SECRET_VERSIONS_LIVE live secret versions cost \$$(dollars $((SECRET_VERSIONS_LIVE * SECRET_VERSION_MICRODOLLARS))) and the registry's $c5_size B about \$$(dollars "$c5_ar_micro"), over the $c5_ceil B ceiling (Go images already pushed: $c5_go; if not, $((AR_GO_VERSIONS * AR_GO_IMAGE_BYTES)) B are added). The engineer decides: reclaim storage, drop a secret version, or raise the approved total in COST_CEILING_MICRODOLLARS with an ADR note."
      fi
    fi
  fi
  c5_err="$(mktemp)"
  c5_versions="$(gc artifacts docker images list "$REGION-docker.pkg.dev/$PROJECT/clinic" --include-tags --project "$PROJECT" --format=json 2>"$c5_err")"
  if ! jq -e 'type == "array"' <<<"$c5_versions" >/dev/null 2>&1; then
    if grep -q "PERMISSION_DENIED" "$c5_err"; then
      fail "C5 AR the CI identity may not list docker images in the clinic repository: it needs artifactregistry.dockerimages.list (roles/artifactregistry.reader or writer on the repository)"
    else
      fail "C5 AR kept images unreadable: the registry call failed ($(redact <"$c5_err" | tr '\n' ' ' | head -c 150))"
    fi
  elif [ "$(jq 'length' <<<"$c5_versions")" -lt 1 ]; then
    fail "C5 AR the registry returned no images at all (wrong repository path, missing scope, or an emptied repository); an empty list is not a pass"
  else
    c5_kept="$(jq -r '[.[].metadata.imageSizeBytes | tonumber] | add' <<<"$c5_versions" 2>/dev/null)"
    if ar_kept_within_bound "$c5_kept"; then
      pass "C5 AR kept images total $c5_kept B <= $AR_KEPT_IMAGES_BOUND_BYTES"
      if is_whole_number "$c5_size" && [ "$c5_size" -gt "$c5_kept" ]; then
        echo "note  C5 AR repository holds $((c5_size - c5_kept)) B more than the kept images' sizes (layers shared between the images count once there, and layers of deleted images wait for the daily garbage collection)"
      fi
    else
      fail "C5 AR kept images total '${c5_kept:-unreadable}' is not within 1 to $AR_KEPT_IMAGES_BOUND_BYTES"
    fi
  fi
  rm -f "$c5_err"

  # C6: <= 2 TAGGED versions per package (the listed name is a full path; use its basename). Untagged
  # versions are what the delete-untagged cleanup policy removes on its own schedule, so counting them
  # races that policy (a fresh push shows up as extra versions until the sweep runs). They are reported
  # as a note; the bytes they hold stay capped by C5.
  local pkg base cnt tagged vjson ijson
  while IFS= read -r pkg; do
    [ -z "$pkg" ] && continue
    base="${pkg##*/}"
    vjson="$(gc artifacts versions list --package "$base" --repository clinic --location "$REGION" --project "$PROJECT" --format=json 2>/dev/null)"
    ijson="$(gc artifacts docker images list "$REGION-docker.pkg.dev/$PROJECT/clinic/$base" --include-tags --project "$PROJECT" --format=json 2>/dev/null)"
    cnt="$(jq -e 'if type == "array" then length else empty end' <<<"$vjson" 2>/dev/null)" || { fail "C6 $base versions unreadable"; continue; }
    tagged="$(jq -e 'if type == "array" then [.[] | select((.tags // []) | length > 0)] | length else empty end' <<<"$ijson" 2>/dev/null)" || { fail "C6 $base tagged versions unreadable"; continue; }
    c6_judge "$base" "$cnt" "$tagged"
  done < <(gc artifacts packages list --repository clinic --location "$REGION" --project "$PROJECT" --format='value(name)' 2>/dev/null)

  # C7 + C8: <= 6 active secret versions, automatic replication. The count also sets C5's ceiling.
  if [ -n "$SECRET_COUNT_ERROR" ]; then
    fail "C7 active secret versions cannot be counted: $SECRET_COUNT_ERROR"
    fail "C8 secret replication cannot be read: $SECRET_COUNT_ERROR"
  else
    if [ "$SECRET_VERSIONS_LIVE" -le 6 ]; then pass "C7 active secret versions=$SECRET_VERSIONS_LIVE (<= 6)"; else fail "C7 active secret versions=$SECRET_VERSIONS_LIVE > 6"; fi
    if [ "$(printf '%s\n' $SECRET_REPL | sort -u | tr '\n' ' ')" = "automatic " ]; then pass "C8 secret replication automatic"; else fail "C8 replication:$SECRET_REPL"; fi
  fi

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

  # C11: both budgets exist. The cap ACTION is a console setting and cannot be read from the API,
  # so it is judged from the recorded console evidence (spend_cap_evidence).
  spend_cap_evidence
  if [ -z "${BILLING_GCLOUD_ACCOUNT:-}" ] && [ -n "${CIRCLECI:-}" ]; then
    unverified C11-budgets "billing checks run locally as BILLING_GCLOUD_ACCOUNT (the CI deployer has no billing role on the shared account)"
  elif [ -z "${BILLING_GCLOUD_ACCOUNT:-}" ]; then
    fail "C11 BILLING_GCLOUD_ACCOUNT unset: the billing user (not the project Owner) must read the budgets"
  elif [ -n "${BILLING_ACCOUNT:-}" ]; then
    local c11
    # --billing-project: the budgets API is billed to a project the caller can use; the billing user's gcloud default quota project may not be one.
    c11="$(gcb --billing-project "$PROJECT" billing budgets list --billing-account "$BILLING_ACCOUNT" --format=json 2>/dev/null | jq -r '[.[].displayName | select(startswith("clinic-"))] | sort | join(",")')"
    [ "$c11" = "clinic-alerts-1usd,clinic-run-spend-cap-3usd" ] && pass "C11 both budgets exist (cap status not readable via API; see $SPEND_CAP_EVIDENCE)" || fail "C11 budgets '${c11:-unreadable}'"
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
  # the token goes in as a header file on stdin, never on curl's command line
  c12_code="$(printf 'Authorization: Bearer %s\n' "$c12_tok" | curl -s -o "$c12_body" -w '%{http_code}' -H @- -H "x-goog-user-project: $PROJECT" \
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
    unverified C13 "Neon region and size need neonctl and NEON_PROJECT_ID (check the console instead)"
  fi

  # C14: the billing account is SHARED (PLAN 11.1 Q14), so the free tiers are shared with the
  # projects in scripts/shared_billing_projects.txt. A project that joins (or leaves) the account
  # changes the headroom and must be re-measured with scripts/shared_headroom.py first.
  if [ -z "${BILLING_GCLOUD_ACCOUNT:-}" ] && [ -n "${CIRCLECI:-}" ]; then
    unverified C14 "project list: billing checks run locally as BILLING_GCLOUD_ACCOUNT (the CI deployer has no billing role on the shared account)"
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
  # the two judgements on their own, so the selftest can prove them without a registry
  --ar-size) if ar_repo_within_budget "${2:-}" "${3:-no}" "${4:-}"; then pass "C5 repository size ${2:-} (go in repository: ${3:-no}, secret versions: ${4:-}) leaves $(ar_headroom_bytes "$2" "${3:-no}" "$4") B under $(ar_budget_ceiling_bytes "$4")"; else fail "C5 repository size '${2:-}' (go in repository: ${3:-no}, secret versions: '${4:-}') is not under the ceiling"; fi ;;
  --ar-ceiling) ar_budget_ceiling_bytes "${2:-}" || { echo "bad secret version count '${2:-}'" >&2; exit 2; } ;;
  # the verdict logic on its own: --verdict "<unverified ids>" "<allowed ids>"
  --verdict) UNVERIFIED=" ${2:-}" ;;
  --c6) c6_judge "${2:?package}" "${3:?all}" "${4:?tagged}" ;;
  --ar-kept) if ar_kept_within_bound "${2:-}"; then pass "C5 kept images ${2:-} <= $AR_KEPT_IMAGES_BOUND_BYTES"; else fail "C5 kept images '${2:-}' is not within $AR_KEPT_IMAGES_BOUND_BYTES"; fi ;;
  # the C1 / C2 judgements on their own, so the selftest can prove them without a project
  --c1) judge_c1 < "${2:?usage: $0 --c1 FILE}" ;;
  --c2) PROJECT="${PROJECT:-sil-clinic-booking}" judge_c2 "${2:?service}" "${3:?iam-disabled}" < "${4:?members file}" ;;
  *) echo "usage: $0 [--static|--live|--ar-size BYTES yes|no VERSIONS|--ar-kept BYTES|--c6 PACKAGE ALL TAGGED|--ar-ceiling VERSIONS|--verdict 'IDS' 'ALLOWED'|--c1 FILE|--c2 SERVICE IAM_DISABLED FILE]"; exit 2 ;;
esac

echo
ALLOW="${COST_CHECK_ALLOW_UNVERIFIED:-}"
[ "$MODE" = --verdict ] && ALLOW="${3:-}"
if [ "$FAILS" -ne 0 ]; then
  echo "cost-check $MODE: $FAILS failure(s)"; exit 1
elif [ -n "${UNVERIFIED// /}" ]; then
  if unverified_allowed "$ALLOW"; then
    echo "cost-check $MODE: PARTIAL, not OK. UNVERIFIED (allowlisted in COST_CHECK_ALLOW_UNVERIFIED):${UNVERIFIED}"; exit 0
  else
    echo "cost-check $MODE: UNVERIFIED and not allowlisted:${UNVERIFIED}"; exit 3
  fi
else
  echo "cost-check $MODE: OK"; exit 0
fi
