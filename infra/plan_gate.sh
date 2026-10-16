#!/usr/bin/env bash
#
# Pre-apply cost gate. Fails CLOSED: it exits 0 only when the plan text was produced and
# contains none of the banned resources, flags or regions. A missing ripgrep, a failing
# `terraform show` or an empty plan is a failure, never a pass.
#
#   bash infra/plan_gate.sh tfplan              # runs `terraform show -no-color tfplan`
#   bash infra/plan_gate.sh --text plan.txt     # check an existing plan rendering
#
# Exit: 0 clean, 1 banned match found, 2 the gate itself could not run.
set -uo pipefail

PATTERN='min_instance|min_instance_count|scaling_mode|manual_instance_count|invoker_iam_disabled|worker_pool|google_cloud_run|google_compute_router_nat|google_compute_global_address|google_compute_forwarding_rule|google_redis|google_sql|google_compute_address|google_vpc_access_connector|google_compute_instance|google_container_cluster|google_compute_region_network_endpoint_group|google_compute_backend_service|REMOTE_REPOSITORY|user_managed|google_cloud_scheduler|google_monitoring_uptime_check|containerscanning|ondemandscanning|cloudbuild|europe-west|STANDARD_IA|dual-region|multi-region'

if ! command -v rg >/dev/null 2>&1; then
  echo "plan_gate: ripgrep (rg) is required but not installed" >&2
  exit 2
fi

text=""
cleanup=""
case "${1:-}" in
  --text)
    text="${2:-}"
    ;;
  "")
    echo "usage: plan_gate.sh <tfplan> | --text <plan.txt>" >&2
    exit 2
    ;;
  *)
    text="$(mktemp)"
    cleanup="$text"
    if ! terraform show -no-color "$1" > "$text"; then
      echo "plan_gate: terraform show failed" >&2
      rm -f "$cleanup"
      exit 2
    fi
    ;;
esac

if [ -z "$text" ] || [ ! -s "$text" ]; then
  echo "plan_gate: plan text is missing or empty" >&2
  [ -n "$cleanup" ] && rm -f "$cleanup"
  exit 2
fi

rg -n -e "$PATTERN" "$text"
rc=$?
[ -n "$cleanup" ] && rm -f "$cleanup"

case "$rc" in
  0) echo "plan_gate: STOP: the plan contains a banned resource, flag or region (see above)" >&2; exit 1 ;;
  1) echo "plan_gate: clean"; exit 0 ;;
  *) echo "plan_gate: ripgrep failed (exit $rc)" >&2; exit 2 ;;
esac
