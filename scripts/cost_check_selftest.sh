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
