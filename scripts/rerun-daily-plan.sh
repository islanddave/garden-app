#!/usr/bin/env bash
# scripts/rerun-daily-plan.sh — A0.2: manually re-run the nightly Daily Plan generator (garden-daily-plan).
#
# WHY: converts a bad nightly run from a 24h blast radius into minutes — regenerate the plan on demand.
#
# SAFETY MODEL (read before using):
#   * DRY RUN IS THE DEFAULT. Payload {"dryRun":true} — the Lambda computes plans, writes NOTHING.
#   * --live sends NO dryRun override; the deployed Lambda then follows its env DRY_RUN
#     (prod: "false" -> live). The invoke payload can NEVER force a live run (index.handler honors
#     only dryRun===true, the safe direction), so the Lambda env kill switch (DRY_RUN=true) always
#     wins — even over --live. If --live comes back dryRun:true, the kill switch is engaged.
#   * A LIVE run OVERWRITES daily_plan.items for every (user_id, plan_date) it produces. A same-day
#     re-run REPLACES the stored plan and the overwritten plan (yesterday's engine inputs) is
#     UNRECOVERABLE. Hence the loud warning + typed OVERWRITE confirmation, and no non-interactive live.
#   * PRE-FLIGHT DEPLOY GATE: entrypoints deployed before A0.2 IGNORED the invoke payload entirely —
#     against them a "dry" invoke would really run env-live. Before ANY invoke this script downloads
#     the deployed zip (read-only: aws lambda get-function -> Code.Location) and greps index.js for
#     the A0.2-EVENT-OVERRIDES sentinel. Sentinel absent = hard abort, nothing invoked.
#
# USAGE:
#   scripts/rerun-daily-plan.sh                      # dry run, Lambda-computed today (ET)
#   scripts/rerun-daily-plan.sh --today 2026-07-21   # dry run for an explicit plan date
#   scripts/rerun-daily-plan.sh --live               # LIVE re-run (warning + type OVERWRITE)
#   scripts/rerun-daily-plan.sh --live --today 2026-07-22
#
# NOTES for agents:
#   * The AWS CLI on this Mac has NO default region — every aws call here passes --region us-east-1.
#   * First execution is a SUPERVISED step (A0.2 contract). Do not run unattended until soak-verified.
#   * The Lambda response payload is printed verbatim; "dryRun" in it is what ACTUALLY happened.
#   * {"ping":true} is also supported by the post-A0.2 entrypoint (no-op liveness probe, no DB work)
#     if you ever need a zero-risk connectivity check: use --ping.
set -euo pipefail

REGION=us-east-1
FN=garden-daily-plan
LIVE=0
PING=0
TODAY=""

die() { echo "ERROR: $*" >&2; exit 1; }
usage() { sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --live) LIVE=1; shift ;;
    --ping) PING=1; shift ;;
    --today) [[ $# -ge 2 ]] || die "--today requires a YYYY-MM-DD argument"; TODAY="$2"; shift 2 ;;
    --today=*) TODAY="${1#--today=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (run with --help for usage)" ;;
  esac
done

[[ $LIVE -eq 1 && $PING -eq 1 ]] && die "--live and --ping are mutually exclusive"
if [[ -n "$TODAY" ]] && ! [[ "$TODAY" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  die "--today must be YYYY-MM-DD (got: $TODAY)"
fi
for c in aws curl unzip python3; do command -v "$c" >/dev/null || die "required command not found: $c"; done

TMPD=$(mktemp -d "${TMPDIR:-/tmp}/rerun-daily-plan.XXXXXX")
trap 'rm -rf "$TMPD"' EXIT

# ---------- pre-flight deploy gate (read-only; guards the pre-A0.2 payload-ignoring entrypoint) ----------
echo "[preflight] checking that the DEPLOYED $FN honors event overrides..."
CODE_URL=$(aws lambda get-function --function-name "$FN" --region "$REGION" \
  --query 'Code.Location' --output text) || die "could not read deployed code location for $FN"
curl -sSf "$CODE_URL" -o "$TMPD/code.zip" || die "could not download the deployed code zip"
if ! unzip -p "$TMPD/code.zip" index.js 2>/dev/null | grep -q 'A0.2-EVENT-OVERRIDES'; then
  die "deployed $FN PREDATES event-override support (A0.2-EVENT-OVERRIDES sentinel absent from index.js).
       An invoke now would IGNORE dryRun/today and follow env DRY_RUN (LIVE in prod).
       Promote + deploy the A0.2 lambda change first. Nothing was invoked."
fi
echo "[preflight] OK — deployed entrypoint honors dryRun/today/ping overrides."

# ---------- payload ----------
PAYLOAD=$(python3 - "$LIVE" "$PING" "$TODAY" <<'PY'
import json, sys
live, ping, today = sys.argv[1] == "1", sys.argv[2] == "1", sys.argv[3]
p = {}
if ping: p["ping"] = True
elif not live: p["dryRun"] = True     # default-safe: explicit dry override
# live: no dryRun key -> Lambda env DRY_RUN decides (payload cannot force live)
if today: p["today"] = today
print(json.dumps(p))
PY
)

# ---------- loud live gate ----------
if [[ $LIVE -eq 1 ]]; then
  cat >&2 <<'WARN'
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
!!  LIVE RE-RUN REQUESTED                                             !!
!!  This will OVERWRITE daily_plan.items for every (user, plan_date)  !!
!!  the run produces. A same-day re-run REPLACES the stored plan;     !!
!!  the overwritten plan (yesterday's inputs) is UNRECOVERABLE.       !!
!!  (If the Lambda env kill switch DRY_RUN=true is engaged the run    !!
!!  will still be dry — check "dryRun" in the printed response.)      !!
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
WARN
  [[ -t 0 ]] || die "--live requires an interactive terminal for typed confirmation; refusing non-interactive live run"
  printf 'Type OVERWRITE to proceed: ' >&2
  read -r CONFIRM
  [[ "$CONFIRM" == "OVERWRITE" ]] || die "confirmation not given — aborting, nothing invoked"
fi

# ---------- invoke ----------
echo "[invoke] $FN region=$REGION payload=$PAYLOAD"
META=$(aws lambda invoke \
  --function-name "$FN" \
  --region "$REGION" \
  --cli-binary-format raw-in-base64-out \
  --payload "$PAYLOAD" \
  --output json \
  "$TMPD/response.json") || die "aws lambda invoke failed"
echo "[invoke] metadata: $META"
echo "[invoke] response payload:"
cat "$TMPD/response.json"; echo
FN_ERR=$(printf '%s' "$META" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("FunctionError",""))')
[[ -z "$FN_ERR" ]] || die "Lambda reported FunctionError=$FN_ERR (see payload above)"

# ---------- verify what ACTUALLY happened ----------
python3 - "$TMPD/response.json" "$LIVE" "$PING" <<'PY'
import json, sys
try:
    resp = json.load(open(sys.argv[1]))
except Exception as e:
    sys.exit(f"ERROR: could not parse response payload as JSON: {e}")
live, ping = sys.argv[2] == "1", sys.argv[3] == "1"
if ping:
    if resp.get("ping") is True and resp.get("ok") is True:
        print("[done] ping OK — entrypoint alive, no DB work performed.")
    else:
        sys.exit(f"ERROR: ping response unexpected: {resp}")
elif live:
    if resp.get("dryRun") is True:
        print("[done] NOTE: --live requested but the run was DRY — the Lambda env kill switch "
              "(DRY_RUN=true) is engaged. No writes happened.")
    else:
        print(f"[done] LIVE run complete: today={resp.get('today')} rows={resp.get('rows')} "
              f"— daily_plan.items overwritten for that date.")
else:
    if resp.get("dryRun") is not True:
        sys.exit("INVARIANT VIOLATION: dry run requested but response dryRun != true. "
                 "Do NOT invoke again until this is understood.")
    print(f"[done] dry run complete (no writes): today={resp.get('today')} rows={resp.get('rows')}")
PY
