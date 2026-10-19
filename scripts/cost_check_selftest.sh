#!/usr/bin/env bash
#
# Proves scripts/cost_check.sh --static by mutation. Each case copies the scanned parts of the
# repo to a throwaway directory, applies ONE mutation (a banned flag, region, resource or a known
# bypass), and requires the checker to exit non-zero with the expected message. Control cases
# (a comment that names a banned flag, `docker run --network`, the unmutated tree) must pass.
# A mutation that changes nothing is itself a failure, so a typo here cannot make a case vacuous.
#
# Also exercises infra/plan_gate.sh. Nothing touches the repo or any cloud.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PRISTINE="$WORK/pristine"
mkdir -p "$PRISTINE"

# The parts of the repo the checker reads.
( cd "$ROOT" && tar -cf - \
    --exclude=node_modules --exclude=.terraform --exclude=.venv --exclude=__pycache__ \
    --exclude=apps/booking/src/generated \
    .circleci infra scripts docs/evidence Makefile apps/booking/vercel.json apps/booking/next.config.ts apps/booking/src packages/ui/src packages/api/src ) | ( cd "$PRISTINE" && tar -xf - )

PASSES=0; FAILS=0; N=0
ok()  { PASSES=$((PASSES + 1)); printf 'PASS  %s\n' "$1"; }
bad() { FAILS=$((FAILS + 1)); printf 'FAIL  %s\n' "$1"; }

DIR=""
fresh() { N=$((N + 1)); DIR="$WORK/case.$N"; cp -R "$PRISTINE" "$DIR"; }
sum() { cksum "$DIR/$1" 2>/dev/null | cut -d' ' -f1; }

# mutate_sub <file> <perl -pe expression>   |   mutate_add <file> <text>   |   mutate_write <file> <text>
MUTATED=1
mutate_sub()   { local before; before="$(sum "$1")"; ( cd "$DIR" && perl -pi -e "$2" "$1" ); [ "$(sum "$1")" != "$before" ] || MUTATED=0; }
mutate_add()   { mkdir -p "$(dirname "$DIR/$1")"; printf '%s\n' "$2" >> "$DIR/$1"; }
mutate_rm()      { [ -e "$DIR/$1" ] || MUTATED=0; rm -f "$DIR/$1"; }
mutate_write() { mkdir -p "$(dirname "$DIR/$1")"; printf '%s\n' "$2" > "$DIR/$1"; }

# expect_fail <name> <expected substring> <mutation cmd...>
expect_fail() {
  local name="$1" want="$2"; shift 2
  fresh; MUTATED=1
  "$@"
  if [ "$MUTATED" = 0 ]; then bad "$name (the mutation changed nothing)"; return; fi
  local out rc
  out="$(cd "$DIR" && bash scripts/cost_check.sh --static 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ] && grep -qF -- "$want" <<<"$out"; then ok "$name"
  else bad "$name (exit $rc; wanted '$want'; got: $(grep -E '^FAIL' <<<"$out" | head -2 | tr '\n' '|'))"; fi
}

# expect_pass <name> <mutation cmd...>
expect_pass() {
  local name="$1"; shift
  fresh; MUTATED=1
  "$@"
  if [ "$MUTATED" = 0 ]; then bad "$name (the mutation changed nothing)"; return; fi
  local out rc
  out="$(cd "$DIR" && bash scripts/cost_check.sh --static 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ]; then ok "$name"; else bad "$name (exit $rc: $(grep -E '^FAIL' <<<"$out" | head -2 | tr '\n' '|'))"; fi
}

CI=.circleci/config.yml
TF=infra/terraform/variables.tf
nop() { :; }

echo "== controls (must pass) =="
expect_pass "unmutated tree passes" nop
expect_pass "a comment naming banned flags is ignored" mutate_add "$CI" '      # gcloud run deploy x --allow-unauthenticated --min-instances 5 --scaling=1 allUsers us-west1'
expect_pass "docker run --network is not a Cloud Run flag" mutate_add "$CI" '      - run: docker run --rm --network clinic_default busybox true'
expect_pass "--no-allow-unauthenticated is accepted" nop
expect_pass "allowed regions in a new file" mutate_write scripts/regions.sh 'echo us-east4 us-east1 us-east4-docker.pkg.dev'

echo "== ship-api deploy flags (CI) =="
expect_fail "delete --max-instances"        "max-instances missing: ship-api"        mutate_sub "$CI" 's/ --max-instances 3//'
expect_fail "max-instances 30"              "max-instances out of range: ship-api"   mutate_sub "$CI" 's/--max-instances 3/--max-instances 30/'
expect_fail "max-instances 0"               "max-instances out of range: ship-api"   mutate_sub "$CI" 's/--max-instances 3/--max-instances 0/'
expect_fail "max-instances=9"               "max-instances out of range: ship-api"   mutate_sub "$CI" 's/--max-instances 3/--max-instances=9/'
expect_fail "min-instances 1"               "min-instances missing or not 0: ship-api" mutate_sub "$CI" 's/--min-instances 0/--min-instances 1/'
expect_fail "min-instances=1"               "min-instances missing or not 0: ship-api" mutate_sub "$CI" 's/--min-instances 0/--min-instances=1/'
expect_fail "delete --min-instances"        "min-instances missing or not 0: ship-api" mutate_sub "$CI" 's/ --min-instances 0//'
expect_fail "--allow-unauthenticated"       "public-access flag: ship-api"           mutate_sub "$CI" 's/--no-traffic/--no-traffic --allow-unauthenticated/'
expect_fail "--no-invoker-iam-check"        "public-access flag: ship-api"           mutate_sub "$CI" 's/--no-traffic/--no-traffic --no-invoker-iam-check/'
expect_fail "--no-cpu-throttling"           "always-on or network flag: ship-api"    mutate_sub "$CI" 's/--no-traffic/--no-traffic --no-cpu-throttling/'
expect_fail "--vpc-connector"               "always-on or network flag: ship-api"    mutate_sub "$CI" 's/--no-traffic/--no-traffic --vpc-connector c/'
expect_fail "--network=default"             "always-on or network flag: ship-api"    mutate_sub "$CI" 's/--no-traffic/--no-traffic --network=default/'
expect_fail "--subnet"                      "always-on or network flag: ship-api"    mutate_sub "$CI" 's/--no-traffic/--no-traffic --subnet s/'
expect_fail "--vpc-egress"                  "always-on or network flag: ship-api"    mutate_sub "$CI" 's/--no-traffic/--no-traffic --vpc-egress all/'
expect_fail "--gpu"                         "always-on or network flag: ship-api"    mutate_sub "$CI" 's/--no-traffic/--no-traffic --gpu 1/'
expect_fail "--min 5"                       "always-on or network flag: ship-api"    mutate_sub "$CI" 's/--no-traffic/--no-traffic --min 5/'
expect_fail "--scaling=1"                   "manual-scaling flag: ship-api"          mutate_sub "$CI" 's/--no-traffic/--no-traffic --scaling=1/'
expect_fail "--source"                      "managed build or --source: ship-api"    mutate_sub "$CI" 's/--no-traffic/--no-traffic --source ./'
expect_fail "--flags-file"                  "managed build or --source: ship-api"    mutate_sub "$CI" 's/--no-traffic/--no-traffic --flags-file=f.yaml/'
expect_fail "scalingMode annotation"        "manual-scaling flag: ship-api"          mutate_sub "$CI" 's/--no-traffic/--no-traffic --update-annotations=run.googleapis.com\/scalingMode=manual/'

echo "== the bypasses from the review =="
expect_fail "separate 'services update --min-instances=1'" "always-on or network flag" mutate_add "$CI" '      - run: gcloud run services update clinic-api --min-instances=1'
expect_fail "gcloud beta run deploy with several bad flags" "public-access flag"        mutate_add "$CI" '      - run: gcloud beta run deploy x --min-instances 5 --allow-unauthenticated --no-cpu-throttling'
expect_fail "IAM binding to allUsers in CI"        "public-access flag"                 mutate_add "$CI" '      - run: gcloud run services add-iam-policy-binding clinic-api --member=allUsers --role=roles/run.invoker'
expect_fail "gcloud run deploy in a NEW script"    "min-instances missing or not 0: scripts/deploy.sh" mutate_write scripts/deploy.sh 'gcloud run deploy x --image y --max-instances 3'
expect_fail "gcloud run deploy in the Makefile"    "min-instances missing or not 0: Makefile" mutate_add Makefile $'deploy:\n\tgcloud run deploy x --image y --max-instances 3'
expect_fail "bootstrap deploy made public"         "public-access flag: infra/bootstrap.sh" mutate_sub infra/bootstrap.sh 's/--no-allow-unauthenticated/--allow-unauthenticated/'
expect_fail "bootstrap region africa-south1"       "region outside us-east4/us-east1"   mutate_sub infra/bootstrap.sh 's/^REGION=us-east4/REGION=africa-south1/'
expect_fail "bootstrap invoker binding to allUsers" "public-access flag"                mutate_sub infra/bootstrap.sh 's/serviceAccount:\$\{sa\}@/allUsers:\${sa}@/'
expect_fail "array-form deploy ( \"\${G[@]}\" run deploy )" "min-instances missing or not 0" mutate_add scripts/arr.sh '"${G[@]}" run deploy x --image y --max-instances 3'

echo "== migrate job =="
expect_fail "jobs deploy without --max-retries 0" "job missing --task-timeout or --max-retries 0" mutate_add "$CI" '      - run: gcloud run jobs deploy j --image i --task-timeout 600s'
expect_fail "jobs deploy without --task-timeout"  "job missing --task-timeout or --max-retries 0" mutate_add "$CI" '      - run: gcloud run jobs deploy j --image i --max-retries 0'
expect_fail "jobs deploy with --max-retries 3"    "job missing --task-timeout or --max-retries 0" mutate_add "$CI" '      - run: gcloud run jobs deploy j --image i --task-timeout 600s --max-retries 3'

echo "== image build and registry =="
expect_fail "build without --provenance=false"  "docker build flags" mutate_sub "$CI" 's/--provenance=false //'
expect_fail "build without --sbom=false"        "docker build flags" mutate_sub "$CI" 's/--sbom=false //'
expect_fail "build with --push instead of --load" "docker build flags" mutate_sub "$CI" 's/--load/--push/'
expect_fail "docker pull of a variable"         "docker pull or cache-from" mutate_add "$CI" '      - run: docker pull "$IMAGE"'
expect_fail "--cache-from a registry"           "docker pull or cache-from" mutate_sub "$CI" 's/--sbom=false --load/--sbom=false --cache-from type=registry --load/'
expect_fail "gcloud builds submit"              "managed build or --source" mutate_add "$CI" '      - run: gcloud builds submit --tag x'

echo "== CircleCI cost =="
expect_fail "resource_class large"      "resource_class outside small/medium" mutate_sub "$CI" 's/resource_class: small/resource_class: large/'
expect_fail "resource_class arm.large"  "resource_class outside small/medium: release (arm.large)" mutate_add "$CI" '    resource_class: arm.large'
expect_fail "resource_class gpu"        "resource_class outside small/medium" mutate_add "$CI" '    resource_class: gpu.nvidia.small'
expect_fail "resource_class quoted"     "resource_class outside small/medium" mutate_add "$CI" '    resource_class: "large"'
expect_fail "resource_class medium+"    "resource_class outside small/medium: release (medium+)" mutate_add "$CI" '    resource_class: medium+'
expect_fail "resource_class windows"    "resource_class outside small/medium" mutate_add "$CI" '    resource_class: windows.large'
expect_fail "docker_layer_caching: true" "docker_layer_caching enabled" mutate_add "$CI" '      docker_layer_caching: true'
expect_fail "docker_layer_caching: True" "docker_layer_caching enabled" mutate_add "$CI" '      docker_layer_caching: True'
expect_fail "docker_layer_caching: yes"  "docker_layer_caching enabled" mutate_add "$CI" '      docker_layer_caching: yes'

echo "== regions =="
for r in us-east5 asia-east1 europe-north1 us-west1 us-central1 africa-south1 europe-west3; do
  expect_fail "region token $r" "region outside us-east4/us-east1: scripts/regions.sh ($r)" mutate_add scripts/regions.sh "echo $r"
done
expect_fail 'terraform location = "EU"'   "region outside us-east4/us-east1: infra/terraform/variables.tf (EU)" mutate_add "$TF" 'locals { l = { location = "EU" } }'
expect_fail "--location=EU"               "region outside us-east4/us-east1: scripts/regions.sh (EU)" mutate_add scripts/regions.sh 'gcloud storage buckets create gs://b --location=EU'
expect_fail "--region eu"                 "region outside us-east4/us-east1: scripts/regions.sh (eu)" mutate_add scripts/regions.sh 'x --region eu'

echo "== terraform =="
tf() { mutate_add "infra/terraform/extra.tf" "$1"; }
for t in 'invoker_iam_disabled = true' 'scaling_mode = "MANUAL"' 'manual_instance_count = 1' 'min_instance_count = 1' \
         'resource "google_compute_router_nat" "n" {}' 'resource "google_sql_database_instance" "d" {}' \
         'resource "google_redis_instance" "r" {}' 'resource "google_vpc_access_connector" "c" {}' \
         'resource "google_compute_address" "a" {}' 'resource "google_compute_instance" "i" {}' \
         'resource "google_container_cluster" "k" {}' 'resource "google_cloud_run_v2_service" "s" {}' \
         'resource "google_cloud_run_v2_worker_pool" "w" {}' 'resource "google_cloud_scheduler_job" "j" {}' \
         'resource "google_monitoring_uptime_check_config" "u" {}' 'format = "REMOTE_REPOSITORY"' \
         'replication { user_managed { } }' 'members = ["allUsers"]' \
         'x = "cloudbuild.googleapis.com"' 'x = "compute.googleapis.com"' 'x = "containerscanning.googleapis.com"'; do
  expect_fail "terraform: $t" "terraform banned resource or API" tf "$t"
done

echo "== default service account =="
expect_fail "ship-api deploy without --service-account" "run deploy missing --service-account: ship-api" mutate_sub "$CI" 's/ --service-account "clinic-api-runtime@[^"]*"//'
expect_fail "migrate job without --service-account" "run deploy missing --service-account" mutate_sub "$CI" 's/ --service-account "clinic-migrate@[^"]*"//'
expect_fail "bootstrap service shell without --service-account" "run deploy missing --service-account: infra/bootstrap.sh" mutate_sub infra/bootstrap.sh 's/--service-account "clinic-api-runtime/--svc-acct "clinic-api-runtime/'
expect_fail "editor removal deleted" "does not remove roles/editor" mutate_write infra/terraform/default_sa.tf '# removed'
expect_fail "editor removal for another role" "does not remove roles/editor" mutate_sub infra/terraform/default_sa.tf 's#"roles/editor"#"roles/viewer"#'
expect_fail "editor removal for another member" "does not remove roles/editor" mutate_sub infra/terraform/default_sa.tf 's#compute@developer#other@developer#'
expect_fail "editor removal only in a comment" "does not remove roles/editor" mutate_write infra/terraform/default_sa.tf '# resource "google_project_iam_member_remove" "d" { role = "roles/editor" member = "x-compute@developer.gserviceaccount.com" }'

echo "== web =="
VJ=apps/booking/vercel.json
expect_fail "vercel.json second region"  "vercel.json not pinned" mutate_sub "$VJ" 's/"iad1"/"iad1", "sfo1"/'
expect_fail "vercel.json git deploys on" "vercel.json not pinned" mutate_sub "$VJ" 's/false/true/'
expect_fail "vercel.json git missing"    "vercel.json not pinned" mutate_write "$VJ" '{"regions":["iad1"]}'
expect_fail "vercel.json invalid"        "vercel.json not pinned" mutate_write "$VJ" '{not json'
expect_fail "next unoptimized false"     "next images not unoptimized" mutate_sub apps/booking/next.config.ts 's/unoptimized: true/unoptimized: false/'
expect_fail "next unoptimized removed"   "next images not unoptimized" mutate_sub apps/booking/next.config.ts 's/.*unoptimized.*//'
expect_fail "next unoptimized only in a comment next to false" "next images not unoptimized" mutate_sub apps/booking/next.config.ts 's/unoptimized: true/unoptimized: false \/\/ unoptimized: true/'
expect_fail "preferredRegion sfo1"       "preferredRegion other than iad1" mutate_add apps/booking/src/app/page.tsx 'export const preferredRegion = "sfo1";'
expect_fail "preferredRegion all"        "preferredRegion other than iad1" mutate_add apps/booking/src/app/page.tsx 'export const preferredRegion = "all";'
expect_fail "edge runtime"               "edge runtime under apps/" mutate_add apps/booking/src/app/page.tsx 'export const runtime = "edge";'
expect_fail "second route.js under api"  "apps/booking/src/app/api route files" mutate_write apps/booking/src/app/api/extra/route.js 'export const GET = () => 1;'
expect_fail "second route.tsx under api" "apps/booking/src/app/api route files" mutate_write apps/booking/src/app/api/extra2/route.tsx 'export const GET = () => 1;'
expect_fail "docs route imports the proxy (alias)"    "doc route not force-static" mutate_add apps/booking/src/app/docs/route.ts 'import { forward } from "@/lib/proxy/forward";'
expect_fail "docs route imports the proxy (relative)" "doc route not force-static" mutate_add apps/booking/src/app/docs/route.ts 'import { x } from "../../lib/proxy/x";'
expect_fail "docs route fetches Cloud Run"            "doc route not force-static" mutate_add apps/booking/src/app/docs/route.ts 'const r = await fetch("https://x.run.app");'
expect_fail "docs route re-exports the proxy handler" "doc route not force-static" mutate_add apps/booking/src/app/redoc/route.ts 'export { GET } from "../api/[...path]/route";'
expect_fail "force-static only in a comment"          "doc route not force-static" mutate_sub apps/booking/src/app/docs/route.ts 's/^export const dynamic = "force-static";/export const dynamic = "force-dynamic"; \/\/ force-static/'

echo "== spend cap evidence (C11) =="
EV=docs/evidence/spend-cap-2026-10-18.md
expect_pass "recorded Configured evidence passes" nop
expect_fail "evidence file missing"          "C11 cap status not readable via API; evidence file missing" mutate_rm "$EV"
expect_fail "evidence empty"                 "does not record 'Spend cap status: Configured'" mutate_write "$EV" ""
expect_fail "status Not applicable"          "does not record 'Spend cap status: Configured'" mutate_sub "$EV" 's/Spend cap status: Configured/Spend cap status: Not applicable/'
expect_fail "status blank"                   "does not record 'Spend cap status: Configured'" mutate_sub "$EV" 's/Spend cap status: Configured/Spend cap status:/'
expect_fail "status only mentioned in prose" "does not record 'Spend cap status: Configured'" mutate_sub "$EV" 's/^- Spend cap status: Configured/Spend cap status: Configured (prose)/'
expect_fail "budget id missing"              "does not name budget id" mutate_sub "$EV" 's/bfd734ab-ef98-414a-8bb1-b6442c1dec94/REDACTED/g'
expect_fail "a different budget id"          "does not name budget id" mutate_sub "$EV" 's/bfd734ab-ef98-414a-8bb1-b6442c1dec94/c193126c-b3ca-4076-98b6-e451c5c531ed/g'
fresh; out="$(cd "$DIR" && bash scripts/cost_check.sh --static 2>&1)"
if grep -F "C11" <<<"$out" | grep -qF "cap status not readable via API; see docs/evidence/spend-cap-2026-10-18.md"; then ok "the pass line says the status is not readable via API and points at the evidence"; else bad "C11 pass wording"; fi

echo "== Artifact Registry gate (C5) =="
ar() { ( cd "$PRISTINE" && bash scripts/cost_check.sh "$@" 2>&1 ) || true; }  # exits 1 on a FAIL; the text is judged
KEPT=200000000; GO=50000000   # 2 Go images at the 25 MB cap, not yet pushed
# The ceiling is derived from the live secret version count: ($0.50 - n x $0.06) / $0.10 per GiB.
for pair in "4 2791728742" "5 2147483648" "6 1503238553" "7 858993459" "9 0"; do
  set -- $pair
  if [ "$(ar --ar-ceiling "$1" | head -1)" = "$2" ]; then ok "C5: $1 live secret versions leave a ceiling of $2 B"; else bad "C5: $1 secret versions should leave $2 B (got '$(ar --ar-ceiling "$1" | head -1)')"; fi
done
CEIL5=2147483648; CEIL4=2791728742; CEIL6=1503238553
for n in 0 128198964 $((CEIL5 - GO - 1)); do
  if ar --ar-size "$n" no 5 | grep -q "^PASS  C5 repository size $n (go in repository: no, secret versions: 5) leaves $((CEIL5 - n - GO)) B"; then ok "C5: $n B passes with the Go cap projected and the exact headroom"; else bad "C5: $n B (go no, 5 versions) should pass with headroom $((CEIL5 - n - GO))"; fi
done
if ar --ar-size $((CEIL5 - GO)) no 5 | grep -q "^FAIL  C5"; then ok "C5: exactly at the ceiling after the Go projection fails"; else bad "C5: at the ceiling (go no) should fail"; fi
if ar --ar-size $((CEIL5 - 1)) yes 5 | grep -q "^PASS  C5"; then ok "C5: one byte under with the Go images already pushed passes"; else bad "C5: CEIL-1 (go yes) should pass"; fi
if ar --ar-size "$CEIL5" yes 5 | grep -q "^FAIL  C5"; then ok "C5: exactly at the ceiling fails"; else bad "C5: at the ceiling (go yes) should fail"; fi
if ar --ar-size 543337040 yes 5 | grep -q "^PASS  C5"; then ok "C5: the measured 543,337,040 B passes with 5 secret versions under the \$0.50 ceiling"; else bad "C5: 543337040 with 5 versions should pass"; fi
for pair in "4 $CEIL4" "5 $CEIL5" "6 $CEIL6"; do
  set -- $pair
  if ar --ar-size $(($2 - 1)) yes "$1" | grep -q "^PASS  C5"; then ok "C5: one byte under the ceiling passes with $1 secret versions"; else bad "C5: $(($2 - 1)) with $1 versions should pass"; fi
  if ar --ar-size "$2" yes "$1" | grep -q "^FAIL  C5"; then ok "C5: exactly the ceiling fails with $1 secret versions"; else bad "C5: $2 with $1 versions should fail"; fi
  if ar --ar-size $(($2 + 1)) yes "$1" | grep -q "^FAIL  C5"; then ok "C5: one byte over the ceiling fails with $1 secret versions"; else bad "C5: $(($2 + 1)) with $1 versions should fail"; fi
done
if ar --ar-size "$CEIL5" yes 4 | grep -q "^PASS  C5"; then ok "C5: the size that fails with 5 versions passes with 4 (the ceiling follows the live count)"; else bad "C5: CEIL5 with 4 versions should pass"; fi
if ar --ar-size 1 yes 9 | grep -q "^FAIL  C5"; then ok "C5: with 9 secret versions nothing is left for the registry"; else bad "C5: 9 versions should fail"; fi
for n in 0 128198964 178200000 199999999 200000000; do
  [ "$n" = 0 ] && continue
  if ar --ar-kept "$n" | grep -q "^PASS  C5 kept images $n <= $KEPT"; then ok "C5: kept images total $n is within the bound"; else bad "C5: kept images total $n should pass"; fi
done
if ar --ar-kept 0 | grep -q "^FAIL  C5 kept images"; then ok "C5: a kept-images total of 0 fails (an empty list is not a pass)"; else bad "C5: a kept-images total of 0 should fail"; fi
for n in 200000001 250000000; do
  if ar --ar-kept "$n" | grep -q "^FAIL  C5 kept images"; then ok "C5: kept images total $n is over the bound"; else bad "C5: kept images total $n should fail"; fi
done
# unreadable input never passes: empty, text, sign, exponent, space, hex, leading zeros (octal traps), overflow
for bad_in in "" abc -5 4.5e8 "1 2" 0x10 08 09 0777 00 9223372036854775807 99999999999999999 1000000000000000; do
  if ar --ar-size "$bad_in" yes 5 | grep -q "^FAIL  C5"; then ok "C5 --ar-size: '$bad_in' fails, never passes"; else bad "C5 --ar-size: '$bad_in' should fail"; fi
  if ar --ar-kept "$bad_in" | grep -q "^FAIL  C5"; then ok "C5 --ar-kept: '$bad_in' fails, never passes"; else bad "C5 --ar-kept: '$bad_in' should fail"; fi
done
for bad_v in "" 08 abc -1 99999999999999999; do
  if ar --ar-size 1000 yes "$bad_v" | grep -q "^FAIL  C5"; then ok "C5 --ar-size: secret version count '$bad_v' fails"; else bad "C5 --ar-size: secret version count '$bad_v' should fail"; fi
done

# ---- the live C5 run end to end, against stand-in gcloud and curl (third-party tools; the logic under test is ours) ----
STUB="$WORK/livestub"; mkdir -p "$STUB/bin"
cat > "$STUB/bin/gcloud" <<'FAKE'
#!/usr/bin/env bash
case "$*" in
  *"auth print-access-token"*) printf '%s\n' "${STUB_TOKEN-SECRETTOKEN123}" ;;
  *"repositories describe clinic"*) echo '{"cleanupPolicies":{"delete-old":{},"delete-untagged":{},"keep-2":{}}}' ;;
  *"packages list"*)
    # what `gcloud ... --format='value(name)'` prints today: the bare package name (STUB_PKG_FULL=1: the full resource path)
    pre=""; [ -n "${STUB_PKG_FULL:-}" ] && pre="projects/p/locations/us-east4/repositories/clinic/packages/"
    printf '%s\n' "${pre}clinic-api" ${STUB_GO:+"${pre}clinic-realtime"} ;;
  *"docker images list"*)
    if [ -n "${STUB_IMAGES_ERR:-}" ]; then echo "ERROR: (gcloud.artifacts.docker.images.list) PERMISSION_DENIED: deployer@sil-clinic-booking.iam.gserviceaccount.com lacks permission" >&2; exit 1; fi
    cat "$STUB_IMAGES" ;;
  *"secrets list"*) [ -n "${STUB_LIST_FAIL:-}" ] && exit 1; [ -n "${STUB_LIST_EMPTY:-}" ] && exit 0; for i in $(seq 1 "${STUB_SECRETS:-5}"); do echo "s$i"; done ;;
  *"secrets versions list"*)
    [ -n "${STUB_VERSIONS_FAIL:-}" ] && exit 1
    [ -n "${STUB_VERSIONS_JUNK:-}" ] && { echo "not json"; exit 0; }
    if [ -n "${STUB_VERSIONS_N:-}" ]; then printf '[%s]\n' "$(seq 1 "$STUB_VERSIONS_N" | paste -sd, -)"; else echo '[{"name":"v1"}]'; fi ;;
  *"secrets describe"*) echo '{"replication":{"automatic":{}}}' ;;
  *) exit 1 ;;
esac
FAKE
cat > "$STUB/bin/curl" <<'FAKE'
#!/usr/bin/env bash
echo "ARGV: $*" >> "$STUB_DIR/curl.argv"
out=""; want_code=""; prev=""
for a in "$@"; do [ "$prev" = -o ] && out="$a"; [ "$prev" = -w ] && want_code=1; prev="$a"; done
if [ ! -t 0 ]; then cat >> "$STUB_DIR/curl.stdin" 2>/dev/null; fi
case "$*" in
  *artifactregistry.googleapis.com*) [ -n "$out" ] && printf '{"sizeBytes":"%s"}' "${STUB_SIZE-}" > "$out"; code="${STUB_HTTP:-200}" ;;
  *) [ -n "$out" ] && echo '{}' > "$out"; code=000 ;;
esac
[ -n "$want_code" ] && printf '%s' "$code"
exit 0
FAKE
chmod +x "$STUB/bin/gcloud" "$STUB/bin/curl"
printf '[{"metadata":{"imageSizeBytes":"64099567"}},{"metadata":{"imageSizeBytes":"64099397"}}]' > "$STUB/images.json"
printf '[]' > "$STUB/empty.json"
live_run() { # <script> <env assignments...> ; prints the C5 / C7 / C12 lines
  local script="$1"; shift
  rm -f "$STUB/curl.argv" "$STUB/curl.stdin"
  ( cd "$PRISTINE" && env PATH="$STUB/bin:$PATH" STUB_DIR="$STUB" STUB_IMAGES="$STUB/images.json" CIRCLECI=true \
      COST_CHECK_ALLOW_UNVERIFIED="C11-budgets C13 C14" PROJECT=p "$@" bash "$script" --live 2>&1 ) | grep -E "C5|C7|C12|^note" || true
}
L="scripts/cost_check.sh"
out="$(live_run "$L" STUB_GO=1 STUB_SIZE=543337040 STUB_SECRETS=5)"
if grep -q "^PASS  C5 AR repository sizeBytes=543337040, headroom $((CEIL5 - 543337040)) B" <<<"$out"; then ok "C5 live: 543,337,040 B with 5 versions and the Go images pushed passes with the exact headroom"; else bad "C5 live: 543 MB / 5 versions / go pushed should pass (got: $(grep C5 <<<"$out" | head -2 | tr '\n' '|'))"; fi
out="$(live_run "$L" STUB_SIZE=$((CEIL5 - 40000000)) STUB_SECRETS=5)"
if grep -q "^FAIL  C5 AR the approved total" <<<"$out" && grep -q "cannot hold" <<<"$out" && grep -q "engineer decides" <<<"$out"; then ok "C5 live: a size that only fits without the Go cap projected fails and says the approved total does not hold"; else bad "C5 live: projected Go cap should fail plainly"; fi
out="$(live_run "$L" STUB_GO=1 STUB_SIZE=$((CEIL5 + 1)) STUB_SECRETS=4)"
if grep -q "^PASS  C5 AR repository" <<<"$out"; then ok "C5 live: with 4 secrets the ceiling follows the live count"; else bad "C5 live: 4 secrets should pass just above the 5-secret ceiling"; fi
out="$(live_run "$L" STUB_GO=1 STUB_SIZE=$CEIL5 STUB_SECRETS=5)"
if grep -q "^FAIL  C5 AR the approved total" <<<"$out"; then ok "C5 live: exactly the ceiling fails"; else bad "C5 live: exactly the ceiling should fail"; fi
out="$(live_run "$L" STUB_GO=1 STUB_SIZE=543337040 STUB_HTTP=401)"
if grep -q "^FAIL  C5 AR repository read refused or failed (HTTP 401)" <<<"$out"; then ok "C5 live: an HTTP 401 is reported as a refused call, not a missing field"; else bad "C5 live: HTTP 401 should be named"; fi
out="$(live_run "$L" STUB_GO=1 STUB_SIZE="")"
if grep -q "^FAIL  C5 AR repository sizeBytes is 'missing from an HTTP 200 response'" <<<"$out"; then ok "C5 live: a missing sizeBytes in a 200 is a failure of its own kind"; else bad "C5 live: missing sizeBytes should fail"; fi
out="$(live_run "$L" STUB_GO=1 STUB_SIZE=0420000000)"
if grep -q "^FAIL  C5 AR repository sizeBytes is '0420000000'" <<<"$out"; then ok "C5 live: a leading-zero size is not accepted"; else bad "C5 live: a leading-zero size should fail"; fi
out="$(live_run "$L" STUB_GO=1 STUB_SIZE=420000000 STUB_TOKEN=)"
if grep -q "^FAIL  C5 AR could not mint an access token" <<<"$out"; then ok "C5 live: a failed token fetch is named as such"; else bad "C5 live: an empty token should be named"; fi
out="$(live_run "$L" STUB_GO=1 STUB_SIZE=420000000 STUB_IMAGES="$STUB/empty.json")"
if grep -q "^FAIL  C5 AR the registry returned no images at all" <<<"$out" && ! grep -q "^PASS  C5 AR kept images" <<<"$out"; then ok "C5 live: an empty image list fails and never passes as 0 B"; else bad "C5 live: an empty image list should fail"; fi
out="$(live_run "$L" STUB_GO=1 STUB_SIZE=420000000 STUB_IMAGES_ERR=1)"
if grep -q "^FAIL  C5 AR the CI identity may not list docker images" <<<"$out" && grep -q "artifactregistry.dockerimages.list" <<<"$out" && ! grep -q "@" <<<"$out"; then ok "C5 live: a permission error names the missing permission and prints no account"; else bad "C5 live: a permission error should name the permission and hide the account (got: $(grep 'FAIL  C5' <<<"$out" | head -1))"; fi
# A count that cannot be read is never 0: every failure fails C5 and C7, whatever the registry says.
for scen in "STUB_LIST_FAIL=1|listing the secrets failed" "STUB_LIST_EMPTY=1|the secret list is empty" "STUB_VERSIONS_FAIL=1|listing the versions of a secret failed" "STUB_VERSIONS_JUNK=1|were not a list" "STUB_VERSIONS_N=12000|not a number"; do
  env_part="${scen%%|*}"; want="${scen#*|}"
  out="$(live_run "$L" STUB_GO=1 STUB_SIZE=420000000 "$env_part")"
  if grep -q "^FAIL  C5 AR the registry ceiling cannot be worked out: .*$want" <<<"$out" && grep -q "^FAIL  C7 active secret versions cannot be counted" <<<"$out" && ! grep -q "^PASS  C5 AR repository" <<<"$out" && ! grep -q "^PASS  C7" <<<"$out"; then ok "secret count: '$env_part' fails C5 and C7 (never a count of 0)"; else bad "secret count: '$env_part' should fail C5 and C7 (got: $(grep -E 'C5|C7' <<<"$out" | head -3 | tr '\n' '|'))"; fi
done
out="$(live_run "$L" STUB_GO=1 STUB_SIZE=420000000 STUB_SECRETS=1)"
if grep -q "^PASS  C7 active secret versions=1" <<<"$out" && grep -q "^PASS  C5 AR repository" <<<"$out"; then ok "secret count: a one-secret project is read normally"; else bad "secret count: one secret should pass"; fi
out="$(live_run "$L" STUB_GO=1 STUB_SIZE=420000000 STUB_VERSIONS_N=1000 STUB_SECRETS=1)"
if grep -q "^FAIL  C7 active secret versions=1000 > 6" <<<"$out"; then ok "secret count: 1,000 versions is read as 1,000 and fails C7's bound"; else bad "secret count: 1,000 should fail C7's bound (got: $(grep C7 <<<"$out" | head -2 | tr '\n' '|'))"; fi
if ar --ar-ceiling 0005 | grep -q "bad secret version count '0005'" && ar --ar-ceiling 12345 | grep -q "^[0-9]*$" ; then ok "secret count: a leading-zero count is rejected by the ceiling helper"; else bad "secret count: leading zeros should be rejected"; fi

# the access token never appears on a command line (C5 and C12), only on stdin
live_run "$L" STUB_GO=1 STUB_SIZE=420000000 >/dev/null
if [ -s "$STUB/curl.argv" ] && ! grep -q "SECRETTOKEN123" "$STUB/curl.argv" && grep -q "Authorization: Bearer SECRETTOKEN123" "$STUB/curl.stdin" && [ "$(grep -c 'Authorization: Bearer' "$STUB/curl.stdin")" -ge 2 ]; then ok "the token is sent on stdin for both the registry (C5) and the monitoring (C12) call, and is in no curl argv"; else bad "the token must be on stdin for C5 and C12 and in no argv"; fi
# the Go package is recognised in the format gcloud prints today and in the full-path format
out="$(live_run "$L" STUB_GO=1 STUB_SIZE=543337040 STUB_SECRETS=5)"
if grep -q "go images in repository: yes, projected add: 0 B" <<<"$out"; then ok "C5 live: the realtime package is recognised from the bare name gcloud prints"; else bad "C5 live: a bare 'clinic-realtime' package name should count as pushed (got: $(grep 'C5 AR repository' <<<"$out" | head -1 | cut -c1-200))"; fi
out="$(live_run "$L" STUB_GO=1 STUB_PKG_FULL=1 STUB_SIZE=543337040 STUB_SECRETS=5)"
if grep -q "go images in repository: yes, projected add: 0 B" <<<"$out"; then ok "C5 live: the realtime package is recognised from the full resource path too"; else bad "C5 live: a full-path package name should count as pushed"; fi
out="$(live_run "$L" STUB_SIZE=543337040 STUB_SECRETS=5)"
if grep -q "go images in repository: no, projected add: 50000000 B" <<<"$out"; then ok "C5 live: without a realtime package the Go cap is projected"; else bad "C5 live: no realtime package should project the Go cap"; fi
# a threshold hidden anywhere in the live C5 is caught by behaviour, whatever its spelling
live_mutant() { # <name> <perl expression> [size] [pristine PASS count] [mutant PASS count]
  local size="${3:-420000000}" want_good="${4:-1}" want_bad="${5:-0}"
  local f="$PRISTINE/scripts/cost_check.mut.sh"; cp "$PRISTINE/scripts/cost_check.sh" "$f"; perl -pi -e "$2" "$f"
  if cmp -s "$f" "$PRISTINE/scripts/cost_check.sh"; then bad "C5 mutation '$1': the mutation changed nothing"; rm -f "$f"; return; fi
  local good bad_out
  good="$(live_run "scripts/cost_check.sh" STUB_GO=1 STUB_SIZE="$size" STUB_SECRETS=5 | grep -c '^PASS  C5 AR repository')"
  bad_out="$(live_run "scripts/cost_check.mut.sh" STUB_GO=1 STUB_SIZE="$size" STUB_SECRETS=5 | grep -c '^PASS  C5 AR repository')"
  local dbg; dbg="$(live_run "scripts/cost_check.mut.sh" STUB_GO=1 STUB_SIZE="$size" STUB_SECRETS=5 | grep 'C5 AR repository\|C5 AR the' | head -2 | cut -c1-200)"
  rm -f "$f"
  if [ "$good" = "$want_good" ] && [ "$bad_out" = "$want_bad" ]; then ok "C5 mutation caught by behaviour: $1"; else bad "C5 mutation '$1' was NOT caught (pristine $good, mutant $bad_out): $dbg"; fi
}
live_mutant "400 MB literal in front of the helper" 's/^(\s*)if ar_repo_within_budget "\$c5_size"/$1if [ "\${c5_size:-0}" -ge "\$((3 << 27))" ]; then c5_x=1; fi; if [ "\${c5_size:-0}" -ge "\$((3 << 27))" ]; then false; elif ar_repo_within_budget "\$c5_size"/'
live_mutant "(( )) arithmetic with a product" 's/^(\s*)if ar_repo_within_budget "\$c5_size"/$1if (( c5_size >= 400*999*999 )); then false; elif ar_repo_within_budget "\$c5_size"/'
live_mutant "plain 400000000 literal" 's/^(\s*)if ar_repo_within_budget "\$c5_size"/$1if [ "\$c5_size" -ge 400000000 ]; then false; elif ar_repo_within_budget "\$c5_size"/'
live_mutant "ceiling pinned to four secrets" 's/ar_budget_ceiling_bytes "\$SECRET_VERSIONS_LIVE"/ar_budget_ceiling_bytes 4/; s/"\$c5_go" "\$SECRET_VERSIONS_LIVE"; then/"\$c5_go" 4; then/' $((CEIL5 + 1000000)) 0 1
f="$PRISTINE/scripts/cost_check.mut.sh"; cp "$PRISTINE/scripts/cost_check.sh" "$f"; perl -pi -e 's/-lt 1 \]; then/-lt 0 ]; then/' "$f"
if ! cmp -s "$f" "$PRISTINE/scripts/cost_check.sh" \
   && [ "$(live_run scripts/cost_check.sh STUB_GO=1 STUB_SIZE=420000000 STUB_IMAGES="$STUB/empty.json" | grep -c '^FAIL  C5 AR the registry returned no images')" = 1 ] \
   && [ "$(live_run scripts/cost_check.mut.sh STUB_GO=1 STUB_SIZE=420000000 STUB_IMAGES="$STUB/empty.json" | grep -c '^FAIL  C5 AR the registry returned no images')" = 0 ]; then ok "C5 mutation caught by behaviour: empty image list passes again"; else bad "C5 mutation 'empty image list passes again' was NOT caught"; fi
rm -f "$f"

# The structural check stays as a second, cheaper line of defence (it is a regex and can be bypassed;
# the behavioural tests above are the real protection).
live_c5_block() { awk '/^  # C5: cleanup policies/,/^  # C6:/' "$1"; }
live_c5_ok() { # <cost_check.sh>
  local b; b="$(live_c5_block "$1")"
  [ "$(wc -l <<<"$b")" -gt 12 ] || return 1
  grep -qE 'if ar_repo_within_budget "\$c5_size" "\$c5_go" "\$SECRET_VERSIONS_LIVE"; then' <<<"$b" || return 1
  grep -qE 'if ar_kept_within_bound "\$c5_kept"; then' <<<"$b" || return 1
  ! grep -vE '^[[:space:]]*#' <<<"$b" | grep -qE '[0-9]{4,}|[0-9][eE][0-9]|0[xX][0-9a-fA-F]|(^|[^<])<<([^<]|$)|[*+-][[:space:]]*[0-9]{2,}[[:space:]]*[*)]' || return 1
}
if live_c5_ok "$PRISTINE/scripts/cost_check.sh"; then ok "C5 structure: the live check uses the helpers and has no numeric literal"; else bad "C5 structure: the live check lost the helpers or gained a literal"; fi

echo "== unverified checks are never a quiet pass (C11 budgets, C13, C14) =="
v() { ( cd "$PRISTINE" && bash scripts/cost_check.sh --verdict "$1" "$2" 2>&1; echo "exit=$?" ); }
out="$(v "C11-budgets C14" "C11-budgets C13 C14")"
if grep -q "PARTIAL, not OK" <<<"$out" && grep -q "C11-budgets C14" <<<"$out" && grep -q "exit=0" <<<"$out" && ! grep -q "cost-check --verdict: OK" <<<"$out"; then ok "unverified: allowlisted ones end PARTIAL, named, never OK"; else bad "unverified: allowlisted run should end PARTIAL (got: $(tr '\n' '|' <<<"$out"))"; fi
out="$(v "C11-budgets C99" "C11-budgets C13 C14")"
if grep -q "not allowlisted" <<<"$out" && grep -q "exit=3" <<<"$out"; then ok "unverified: a check outside the allowlist fails the run (exit 3)"; else bad "unverified: an unlisted check should fail (got: $(tr '\n' '|' <<<"$out"))"; fi
out="$(v "C14" "")"
if grep -q "exit=3" <<<"$out"; then ok "unverified: with no allowlist any unverified check fails the run"; else bad "unverified: empty allowlist should fail"; fi
out="$(v "" "")"
if grep -q "verdict: OK" <<<"$out" && grep -q "exit=0" <<<"$out"; then ok "unverified: nothing unverified ends OK"; else bad "unverified: a clean run should end OK"; fi
# the live code reports skips as UNVERIFIED and never prints a bare SKIP
if ! grep -q 'echo "SKIP' "$PRISTINE/scripts/cost_check.sh" && [ "$(grep -c '^  *unverified C' "$PRISTINE/scripts/cost_check.sh")" -ge 3 ]; then ok "unverified: the live checks report C11 budgets, C13 and C14 through unverified()"; else bad "unverified: a live check still prints a bare SKIP"; fi
if grep -q 'COST_CHECK_ALLOW_UNVERIFIED="C11-budgets C13 C14"' "$PRISTINE/.circleci/config.yml"; then ok "unverified: CI lists exactly the three checks it cannot run"; else bad "unverified: the CI allowlist is missing or wrong"; fi


echo "== clinic-realtime deploy: the pinned shape, mutated one flag at a time =="
RT='deploy clinic-realtime'
rt_sub() { mutate_sub "$CI" "$1"; }
expect_fail "realtime: --min-instances 1" "min-instances missing or not 0" rt_sub 's/--min-instances 0/--min-instances 1/ if /deploy clinic-realtime/'
expect_fail "realtime: --min-instances 1 is also not the pinned shape" "clinic-realtime deploy not pinned" rt_sub 's/--min-instances 0/--min-instances 1/ if /deploy clinic-realtime/'
expect_fail "realtime: --max-instances 9" "max-instances out of range" rt_sub 's/--max-instances 2/--max-instances 9/ if /deploy clinic-realtime/'
expect_fail "realtime: --max-instances 3 (allowed for the API, not for the gateway)" "clinic-realtime deploy not pinned" rt_sub 's/--max-instances 2/--max-instances 3/ if /deploy clinic-realtime/'
expect_fail "realtime: --max-instances 1 (pinned to exactly 2)" "clinic-realtime deploy not pinned" rt_sub 's/--max-instances 2/--max-instances 1/ if /deploy clinic-realtime/'
expect_fail "realtime: no --max-instances" "max-instances missing" rt_sub 's/--max-instances 2 // if /deploy clinic-realtime/'
expect_fail "realtime: --allow-unauthenticated" "public-access flag" rt_sub 's/--no-allow-unauthenticated/--allow-unauthenticated/ if /deploy clinic-realtime/'
expect_fail "realtime: --no-invoker-iam-check" "public-access flag" rt_sub 's/--no-allow-unauthenticated/--no-allow-unauthenticated --no-invoker-iam-check/ if /deploy clinic-realtime/'
expect_fail "realtime: CPU throttling off" "always-on or network flag" rt_sub 's/--cpu-boost/--cpu-boost --no-cpu-throttling/ if /deploy clinic-realtime/'
expect_fail "realtime: a VPC connector" "always-on or network flag" rt_sub 's/--cpu-boost/--cpu-boost --vpc-connector x/ if /deploy clinic-realtime/'
expect_fail "realtime: concurrency 50" "clinic-realtime deploy not pinned" rt_sub 's/--concurrency 1 /--concurrency 50 / if /deploy clinic-realtime/'
expect_fail "realtime: 1 vCPU" "clinic-realtime deploy not pinned" rt_sub 's/--cpu 0.25/--cpu 1/ if /deploy clinic-realtime/'
expect_fail "realtime: request timeout 3600" "clinic-realtime deploy not pinned" rt_sub 's/--timeout 900/--timeout 3600/ if /deploy clinic-realtime/'
expect_fail "realtime: no service account" "run deploy missing --service-account" rt_sub 's/--service-account \S+ // if /deploy clinic-realtime/'
expect_fail "realtime: another region" "region outside us-east4/us-east1" rt_sub 's/--region us-east4/--region europe-west3/ if /deploy clinic-realtime/'
expect_fail "realtime: the deploy line is gone" "clinic-realtime deploy not pinned" rt_sub 's/gcloud run deploy clinic-realtime/gcloud run services describe clinic-realtime/'
expect_pass "realtime: 0.5 vCPU is the documented fallback" rt_sub 's/--cpu 0.25/--cpu 0.5/ if /deploy clinic-realtime/'
# The bootstrap shell (infra/bootstrap.sh service) is held to the same shape, and it does not stand
# in for the release pipeline's own deploy (the "line is gone" case above still fails with it there).
expect_fail "realtime bootstrap shell: --max-instances 3" "clinic-realtime deploy not pinned: infra/bootstrap.sh" mutate_sub infra/bootstrap.sh 's/--max-instances 2 --concurrency 1/--max-instances 3 --concurrency 1/'
expect_fail "realtime bootstrap shell: concurrency 80" "clinic-realtime deploy not pinned: infra/bootstrap.sh" mutate_sub infra/bootstrap.sh 's/--concurrency 1 /--concurrency 80 /'

echo "== live C1 / C2 judgements for the gateway (no project needed) =="
c1() { # <name> <want PASS|FAIL> <row>
  local f="$WORK/c1.$RANDOM.tsv" out
  printf '%b\n' "$3" > "$f"
  out="$(bash "$ROOT/scripts/cost_check.sh" --c1 "$f" 2>&1)"
  if grep -q "^$2  C1" <<<"$out"; then ok "C1: $1 -> $2"; else bad "C1: $1 (wanted $2; got $(grep -E '^(PASS|FAIL)' <<<"$out" | head -1))"; fi
}
c1 "gateway max=2 min=0 throttled automatic" PASS 'clinic-realtime\t2\t0\t0\ttrue\tautomatic'
c1 "gateway max=3" FAIL 'clinic-realtime\t3\t0\t0\ttrue\tautomatic'
c1 "gateway max=1" FAIL 'clinic-realtime\t1\t0\t0\ttrue\tautomatic'
c1 "gateway max unset" FAIL 'clinic-realtime\tUNSET\t0\t0\ttrue\tautomatic'
c1 "gateway min=1" FAIL 'clinic-realtime\t2\t1\t0\ttrue\tautomatic'
c1 "gateway service-level min=1" FAIL 'clinic-realtime\t2\t0\t1\ttrue\tautomatic'
c1 "gateway throttling off (always-allocated CPU)" FAIL 'clinic-realtime\t2\t0\t0\tfalse\tautomatic'
c1 "gateway manual scaling" FAIL 'clinic-realtime\t2\t0\t0\ttrue\tmanual'
c1 "api max=3 still passes" PASS 'clinic-api\t3\t0\t0\ttrue\tautomatic'
c1 "api max=4" FAIL 'clinic-api\t4\t0\t0\ttrue\tautomatic'
c2() { # <name> <want> <service> <iam-disabled> <members...>
  local name="$1" want="$2" svc="$3" dis="$4" f="$WORK/c2.$RANDOM.txt" out; shift 4
  printf '%s\n' "$@" > "$f"
  out="$(bash "$ROOT/scripts/cost_check.sh" --c2 "$svc" "$dis" "$f" 2>&1)"
  if grep -q "^$want  C2" <<<"$out"; then ok "C2: $name -> $want"; else bad "C2: $name (wanted $want; got $(grep -E '^(PASS|FAIL)' <<<"$out" | head -1))"; fi
}
P=sil-clinic-booking
A="serviceAccount:clinic-admin@$P.iam.gserviceaccount.com"; S="serviceAccount:clinic-smoke@$P.iam.gserviceaccount.com"; W="serviceAccount:clinic-web@$P.iam.gserviceaccount.com"
c2 "gateway: admin app and smoke only" PASS clinic-realtime false "$A" "$S"
c2 "gateway: the public proxy must not be bound" FAIL clinic-realtime false "$A" "$S" "$W"
c2 "gateway: admin only (the smoke could not run)" FAIL clinic-realtime false "$A"
c2 "gateway: an extra user" FAIL clinic-realtime false "$A" "$S" "user:someone@example.com"
c2 "gateway: public" FAIL clinic-realtime false "$A" "$S" "allUsers"
c2 "gateway: invoker check disabled" FAIL clinic-realtime true "$A" "$S"
c2 "api: web, admin and smoke" PASS clinic-api false "$A" "$S" "$W"
c2 "api: the web proxy missing" FAIL clinic-api false "$A" "$S"

echo "== a blind scanner must fail, not pass =="
blind() { ( cd "$DIR" && perl -pi -e "s/run deploy/run dpl/" "$CI" infra/bootstrap.sh ); }
expect_fail "no deploy commands visible" "scanner is blind" blind

echo "== infra/plan_gate.sh =="
PG="$ROOT/infra/plan_gate.sh"
gate() { # <name> <expected exit> <plan text|__EMPTY__|__MISSING__>
  local f="$WORK/plan.$RANDOM.txt" rc
  case "$3" in __EMPTY__) : > "$f" ;; __MISSING__) f="$WORK/none.txt" ;; *) printf '%s\n' "$3" > "$f" ;; esac
  bash "$PG" --text "$f" >/dev/null 2>&1; rc=$?
  if [ "$rc" = "$2" ]; then ok "plan_gate: $1 -> exit $2"; else bad "plan_gate: $1 (exit $rc, want $2)"; fi
}
gate "clean plan" 0 'resource "google_service_account" "x" {}'
for t in 'google_compute_router_nat' 'google_sql_database_instance' 'scaling_mode = "MANUAL"' 'manual_instance_count' \
         'invoker_iam_disabled' 'worker_pool' 'google_cloud_run_v2_service' 'europe-west3' 'REMOTE_REPOSITORY' 'user_managed' 'cloudbuild'; do
  gate "banned: $t" 1 "$t"
done
gate "empty plan"   2 __EMPTY__
gate "missing plan" 2 __MISSING__
mkdir -p "$WORK/nopath"
rc=0; PATH="$WORK/nopath" /bin/bash "$PG" --text "$WORK/pristine/.circleci/config.yml" >/dev/null 2>&1 || rc=$?
if [ "$rc" = 2 ]; then ok "plan_gate: no ripgrep on PATH -> exit 2 (fails closed)"; else bad "plan_gate: no ripgrep (exit $rc, want 2)"; fi

echo
echo "cost_check selftest: $PASSES passed, $FAILS failed"
[ "$FAILS" -eq 0 ]
