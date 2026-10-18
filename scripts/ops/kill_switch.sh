#!/usr/bin/env bash
#
# Egress kill switch (docs/adr/0023). Removes the web front doors' roles/run.invoker binding from
# clinic-api and clinic-realtime so every request becomes an unbilled IAM denial, and puts the
# exact previous state back on --restore.
#
#   kill_switch.sh                      dry run: reads the policies, prints what would change
#   kill_switch.sh --apply              records the prior state to the state file, then removes
#   kill_switch.sh --restore            dry run of the restore
#   kill_switch.sh --restore --apply    re-adds exactly the bindings that were removed and checks
#                                       the invoker members match the recorded policy
#
# Options: --mode iam (the only mode, see below), --state-file PATH, --project P, --region R.
# --project and --region exist only so a mistaken value is refused: this script acts on
# sil-clinic-booking in us-east4 and nothing else, and every gcloud call names both explicitly.
#
# Removed identities: clinic-web (the booking proxy, the ADR text) and clinic-admin (the admin
# app, which C2 in cost_check.sh lists as an invoker too and which bills the same egress).
# clinic-smoke is left alone: it is CI-only and cannot generate public traffic.
#
# There is deliberately no "scale clinic-api to max 0" mode. docs/adr/0023 specifies the IAM removal;
# Cloud Run's accepted range for --max-instances is not verified to include 0 here, and a
# max-instances outside 1..3 is a banned value in cost_check.sh (static and live C1). --mode scale
# is rejected with exit 2 rather than shipped untested.
#
# Exit codes: 0 done / nothing to do, 1 a gcloud call or the read-back check failed (the state
# file is kept so --restore still works), 2 refused (bad usage, wrong project/region, state conflict).
set -euo pipefail

PROJECT=sil-clinic-booking
REGION=us-east4
SERVICES=(clinic-api clinic-realtime)
IDENTITIES=(clinic-web clinic-admin)
ROLE=roles/run.invoker

APPLY=0
RESTORE=0
STATE="${KILL_SWITCH_STATE:-$HOME/.clinic-kill-switch/state.json}"

die() { echo "kill_switch: $*" >&2; exit "${2:-2}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    --restore) RESTORE=1 ;;
    --state-file) shift; STATE="${1:?--state-file needs a path}" ;;
    --project) shift; [ "${1:-}" = "$PROJECT" ] || die "refusing project '${1:-}': this script only acts on $PROJECT" ;;
    --region) shift; [ "${1:-}" = "$REGION" ] || die "refusing region '${1:-}': this script only acts in $REGION" ;;
    --mode) shift; [ "${1:-}" = iam ] || die "mode '${1:-}' is not supported (only 'iam'; see the header for why there is no scale mode)" ;;
    -h|--help) sed -n '2,29p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

command -v gcloud >/dev/null || die "gcloud not found" 1
command -v jq >/dev/null || die "jq not found" 1

g() { gcloud "$@" --project "$PROJECT"; }
member_of() { printf 'serviceAccount:%s@%s.iam.gserviceaccount.com' "$1" "$PROJECT"; }

# service_exists <svc>: 0 yes, 1 no (not found). Any other gcloud failure aborts.
service_exists() {
  local err
  if err="$(g run services describe "$1" --region "$REGION" --format='value(metadata.name)' 2>&1 >/dev/null)"; then return 0; fi
  case "$err" in
    *"Cannot find service"*|*"not found"*|*"NOT_FOUND"*) return 1 ;;
    *) die "could not describe $1: $err" 1 ;;
  esac
}

policy_of() { g run services get-iam-policy "$1" --region "$REGION" --format=json; }

# invoker_members <policy json>: sorted run.invoker members, one per line.
invoker_members() { jq -r --arg r "$ROLE" '[.bindings[]? | select(.role == $r) | .members[]?] | sort | .[]' <<<"$1"; }

if [ "$RESTORE" = 1 ]; then
  [ -f "$STATE" ] || die "no recorded state at $STATE: nothing to restore"
  jq -e '.project == "'"$PROJECT"'" and .region == "'"$REGION"'"' "$STATE" >/dev/null \
    || die "the state file was not recorded for $PROJECT/$REGION: refusing"
  [ "$(jq '.removed | length' "$STATE")" -gt 0 ] || die "the state file lists nothing removed"
  while IFS='|' read -r svc mem; do
    echo "restore: add $ROLE for $mem on $svc"
    if [ "$APPLY" = 1 ]; then
      g run services add-iam-policy-binding "$svc" --region "$REGION" --member="$mem" --role="$ROLE" --condition=None >/dev/null
    fi
  done < <(jq -r '.removed[] | [.service, .member] | join("|")' "$STATE")
  if [ "$APPLY" != 1 ]; then echo "dry run: nothing changed (add --apply to restore)"; exit 0; fi
  rc=0
  for svc in $(jq -r '.snapshots | keys[]' "$STATE"); do
    want="$(invoker_members "$(jq -c --arg s "$svc" '.snapshots[$s]' "$STATE")")"
    got="$(invoker_members "$(policy_of "$svc")")"
    if [ "$want" = "$got" ]; then echo "verified: $svc invoker members match the recorded policy"
    else echo "MISMATCH: $svc invoker members [$(tr '\n' ' ' <<<"$got")] != recorded [$(tr '\n' ' ' <<<"$want")]" >&2; rc=1; fi
  done
  [ "$rc" = 0 ] || exit 1
  mv "$STATE" "$STATE.restored"
  echo "restored; state file moved to $STATE.restored"
  exit 0
fi

# ---- kill (dry run unless --apply) -------------------------------------------------------
if [ -f "$STATE" ]; then
  die "a recorded kill already exists at $STATE; run --restore --apply first (or move the file) so the original state is not lost"
fi

SNAP='{}'
REMOVED='[]'
for svc in "${SERVICES[@]}"; do
  if ! service_exists "$svc"; then echo "skip: $svc does not exist (harmless, docs/adr/0023)"; continue; fi
  pol="$(policy_of "$svc")"
  SNAP="$(jq -c --arg s "$svc" --argjson p "$pol" '. + {($s): $p}' <<<"$SNAP")"
  for id in "${IDENTITIES[@]}"; do
    mem="$(member_of "$id")"
    present="$(jq -r --arg r "$ROLE" --arg m "$mem" '[.bindings[]? | select(.role == $r and ((.members // []) | index($m)))] | length' <<<"$pol")"
    [ "$present" -gt 0 ] || { echo "skip: $mem holds no $ROLE on $svc"; continue; }
    cond="$(jq -r --arg r "$ROLE" --arg m "$mem" '[.bindings[]? | select(.role == $r and ((.members // []) | index($m)) and .condition != null)] | length' <<<"$pol")"
    [ "$cond" = 0 ] || die "$mem has a conditional $ROLE binding on $svc; restoring it exactly is not supported, resolve by hand"
    REMOVED="$(jq -c --arg s "$svc" --arg m "$mem" '. + [{service: $s, member: $m, role: "'"$ROLE"'"}]' <<<"$REMOVED")"
    echo "kill: remove $ROLE for $mem from $svc"
  done
done

if [ "$(jq length <<<"$REMOVED")" = 0 ]; then echo "nothing to remove: the front doors hold no invoker binding (already killed?)"; exit 0; fi
if [ "$APPLY" != 1 ]; then echo "dry run: nothing changed (add --apply to remove)"; exit 0; fi

# Record the prior state BEFORE the first mutation.
mkdir -p "$(dirname "$STATE")"
( umask 077; jq -n --arg p "$PROJECT" --arg r "$REGION" --arg t "$(date -u +%FT%TZ)" \
    --argjson snap "$SNAP" --argjson removed "$REMOVED" \
    '{project: $p, region: $r, recorded_at: $t, snapshots: $snap, removed: $removed}' > "$STATE" )
echo "prior state recorded at $STATE"

while IFS='|' read -r svc mem; do
  g run services remove-iam-policy-binding "$svc" --region "$REGION" --member="$mem" --role="$ROLE" --condition=None >/dev/null
done < <(jq -r '.[] | [.service, .member] | join("|")' <<<"$REMOVED")

rc=0
for svc in $(jq -r 'keys[]' <<<"$SNAP"); do
  left="$(invoker_members "$(policy_of "$svc")")"
  for id in "${IDENTITIES[@]}"; do
    if grep -qxF "$(member_of "$id")" <<<"$left"; then echo "STILL BOUND: $id on $svc" >&2; rc=1; fi
  done
done
[ "$rc" = 0 ] || exit 1
echo "killed: requests now get an IAM denial after the propagation delay. Undo with: $0 --restore --apply"
