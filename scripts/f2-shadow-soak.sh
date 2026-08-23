#!/usr/bin/env bash
# scripts/f2-shadow-soak.sh — V4-WATERMATH-001 F2: Water Ledger SHADOW SOAK (dry-only, zero-write).
#
# WHAT ONE SOAK SAMPLE MEASURES
#   Two DRY invokes of garden-daily-plan against the SAME live data:
#     leg 1 (plain):  {"dryRun": true}                                   -> legacy water verdicts
#     leg 2 (ledger): {"dryRun": true,
#                      "flagOverrides": {"CARE_WATER_LEDGER_ENABLED": true}}
#                                                                        -> ledger water verdicts
#   then a per-planting diff of the water verdicts across the two responses' `plans`
#   (buckets: water_due -> "due", rain_skipped -> "skipped", no_history -> "never").
#   ASYMMETRY, HANDLED HONESTLY: the ledger emits rows for DUE plantings only — a planting
#   that is not due under the ledger simply has NO row (its day-credits/snoozes/amounts already
#   spoke through D), so an absent row is recorded as verdict "notdue", never as missing data.
#   The never-watered path (dW==null) is byte-identical by design and shows up as "same".
#
# WHAT THE SOAK FEEDS — the FLIP GATE for CARE_WATER_LEDGER_ENABLED (Dave's explicit approval
# required; canon watering-cadence-math-design-V100-20260812.md Part 5, status doc
# project-state/waterledger-f2-status-20260812.md). Entry criteria the accumulated soak reports
# are evidence for:
#   1. F0 chips live >=2 weeks; weather_daily >=30d; observed in-window: >=1 qualifying rain day,
#      >=1 >=85F day, >=1 evening-watering day.
#   2. Override-rate baseline (moisture_check taps / depth-annotated waterings) accumulating.
#   3. THIS shadow soak: stored per-planting diffs across real calendar days. The tuning lever is
#      ledgerParams.GLOBAL_NORMALIZATION — if the soak shows a median effective-interval shift
#      per crop class beyond +-10%, that ONE constant moves; never hand-edits to per-crop profiles.
#   4. Pre-flip checks owed elsewhere: shared-vessel sibling verify query; event-window query cost
#      in CloudWatch during the soak.
#
# WHAT THIS SOAK STRUCTURALLY CANNOT SEE (BUG-ETNOAMPLITUDE-001, 2026-08-20). Every sample diffs a
# 30-day window, so a demand curve that is only wrong ACROSS months is invisible to it, at any
# sample count. That is how the ET denominator shipped as a per-MONTH self-reference — each month
# divided by its own mean, multiplier ~1.0 year-round, September actually SHORTENING intervals in
# 11 of 11 archive years — with the flip gate showing green. The seasonal criterion now lives where
# it can execute: ledger.test.js `describe('seasonal amplitude')`. This item previously read
# "ET0_ref Sep/Oct refresh as those months accrue", which was the defect's own maintenance step —
# refreshing Sep/Oct to their measured means would have driven those months to exactly 1.0. There
# is no per-month reference left to refresh; ledgerParams.ET0_REF_PEAK is one site-wide constant
# and the only legitimate reason to move it is a fresh multi-year archive pull.
#
# SCHEDULING: running this nightly is a SEPARATE ops decision, deliberately NOT made here.
# This script produces one soak sample per run and installs nothing anywhere.
#
# SAFETY: dry-only BY CONSTRUCTION — there is no --live and both payloads always carry
# {"dryRun": true}; the entrypoint hard-rejects flagOverrides on any live run regardless
# (handler.resolveInvokeOptions). Preflight greps the DEPLOYED zip for A0.2 (payload honored),
# A0.3 (dry responses carry plans[]) AND A0.4 (flagOverrides honored): without A0.4 the deployed
# code SILENTLY IGNORES the override and the "ledger leg" would really be a plain flag-OFF run
# diffing as vacuously identical. Both dry responses are verified dryRun===true after the fact.
#
# OUTPUT (idempotent per plan date — a same-day rerun overwrites the same file):
#   $OUT_DIR/soak-YYYYMMDD.json     date = the response's plan date (ET), not the local clock.
#   Default OUT_DIR is gardening-docs project-state/f2-soak — OUTSIDE this repo on purpose;
#   soak artifacts are operational data and must not be committed to garden-app.
#   Report JSON:
#     { schema, plan_date, generated_at, function, region, flag_overrides,
#       summary: { plantings, due_legacy, due_ledger, verdict_flips,
#                  skipped_legacy, skipped_ledger, never_both },
#       plantings: [ { plant_id, name, user_id, space_id,
#                      legacy: { verdict, due, days_since, overdue_by, interval },
#                      ledger: { verdict, due, days_since, overdue_by, interval,
#                                D, due_at, wi_eff, confidence, drivers },   # ledger.* only on rows
#                      delta_class, verdict_flip } ] }                       # the fold produced
#   delta_class = "same" when the verdicts agree, else "<legacy>-><ledger>" over
#   {due, skipped, never, notdue}. verdict_flip (summed as summary.verdict_flips) = due-ness
#   differs between legs — the number the flip gate watches.
#
# USAGE:
#   scripts/f2-shadow-soak.sh                          # today (ET), default output dir
#   scripts/f2-shadow-soak.sh --out-dir /tmp/f2-smoke  # redirect the report (smoke tests use this)
#   scripts/f2-shadow-soak.sh --today 2026-08-13       # explicit plan date — NOTE the fetchers still
#                                                      #   read weather relative to NOW, so a past
#                                                      #   date is NOT a historical replay; soak
#                                                      #   samples must be real calendar days.
#
# NOTES for agents:
#   * The AWS CLI on this Mac has NO default region — every aws call here passes --region us-east-1.
#   * Exit 0 = report written (flips are DATA, not failure). Any preflight/invoke/shape problem dies
#     loudly with nothing half-written (report lands via atomic rename).
set -euo pipefail

REGION=us-east-1
FN=garden-daily-plan
OUT_DIR="${F2_SOAK_DIR:-/Users/davenichols/AI/Claude/Projects/Gardening/project-state/f2-soak}"
TODAY=""

die() { echo "ERROR: $*" >&2; exit 1; }
usage() { sed -n '2,68p' "$0" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --today) [[ $# -ge 2 ]] || die "--today requires a YYYY-MM-DD argument"; TODAY="$2"; shift 2 ;;
    --today=*) TODAY="${1#--today=}"; shift ;;
    --out-dir) [[ $# -ge 2 ]] || die "--out-dir requires a directory argument"; OUT_DIR="$2"; shift 2 ;;
    --out-dir=*) OUT_DIR="${1#--out-dir=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (run with --help for usage; there is deliberately no --live)" ;;
  esac
done

if [[ -n "$TODAY" ]]; then
  [[ "$TODAY" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die "--today must be YYYY-MM-DD (got: $TODAY)"
  echo "[warn] --today relabels the plan date but the fetchers read weather relative to NOW;" >&2
  echo "[warn] a past date is not a historical replay — soak samples should be real calendar days." >&2
fi
for c in aws curl unzip python3; do command -v "$c" >/dev/null || die "required command not found: $c"; done

TMPD=$(mktemp -d "${TMPDIR:-/tmp}/f2-shadow-soak.XXXXXX")
trap 'rm -rf "$TMPD"' EXIT

# ---------- pre-flight deploy gate (read-only; same pattern as rerun-daily-plan.sh) ----------
echo "[preflight] checking the DEPLOYED $FN for A0.2/A0.3/A0.4 support..."
CODE_URL=$(aws lambda get-function --function-name "$FN" --region "$REGION" \
  --query 'Code.Location' --output text) || die "could not read deployed code location for $FN"
curl -sSf "$CODE_URL" -o "$TMPD/code.zip" || die "could not download the deployed code zip"
IDX="$TMPD/deployed-index.js"
unzip -p "$TMPD/code.zip" index.js > "$IDX" 2>/dev/null || die "could not extract index.js from the deployed zip"
grep -q 'A0.2-EVENT-OVERRIDES' "$IDX" || die "deployed $FN PREDATES event-override support (A0.2-EVENT-OVERRIDES
       sentinel absent) — a 'dry' invoke against it would follow env DRY_RUN (LIVE in prod). Nothing was invoked."
grep -q 'A0.3-DRY-PLANS' "$IDX" || die "deployed $FN PREDATES dry-plans support (A0.3-DRY-PLANS sentinel absent) —
       its dry responses carry no plans[], so there is nothing to diff. Nothing was invoked."
grep -q 'A0.4-FLAG-OVERRIDES' "$IDX" || die "deployed $FN PREDATES flag-override support (A0.4-FLAG-OVERRIDES
       sentinel absent) — it would SILENTLY IGNORE flagOverrides and the ledger leg would really be a plain
       flag-OFF run, making the diff vacuously empty. Promote + deploy the A0.4 change first. Nothing was invoked."
echo "[preflight] OK — deployed entrypoint honors dryRun/today/ping and dry-run flagOverrides."

# ---------- payloads (both legs dry BY CONSTRUCTION) ----------
if [[ -n "$TODAY" ]]; then
  P_PLAIN="{\"dryRun\": true, \"today\": \"$TODAY\"}"
  P_LEDGER="{\"dryRun\": true, \"today\": \"$TODAY\", \"flagOverrides\": {\"CARE_WATER_LEDGER_ENABLED\": true}}"
else
  P_PLAIN='{"dryRun": true}'
  P_LEDGER='{"dryRun": true, "flagOverrides": {"CARE_WATER_LEDGER_ENABLED": true}}'
fi

# ---------- invoke both legs ----------
invoke_leg() { # $1=label $2=payload $3=outfile
  echo "[invoke:$1] $FN region=$REGION payload=$2"
  local meta
  meta=$(aws lambda invoke \
    --function-name "$FN" \
    --region "$REGION" \
    --cli-binary-format raw-in-base64-out \
    --payload "$2" \
    --output json \
    "$3") || die "aws lambda invoke failed ($1 leg)"
  echo "[invoke:$1] metadata: $meta"
  local fn_err
  fn_err=$(printf '%s' "$meta" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("FunctionError",""))')
  [[ -z "$fn_err" ]] || die "Lambda reported FunctionError=$fn_err on the $1 leg (see $3)"
  # The invariant that makes this a SOAK and not an incident: both legs must really have been dry,
  # and both must carry plans[] (A0.3). Checked from the response — what ACTUALLY happened, not
  # what was requested.
  python3 - "$3" "$1" <<'PY'
import json, sys
try:
    resp = json.load(open(sys.argv[1]))
except Exception as e:
    sys.exit(f"ERROR: could not parse the {sys.argv[2]} response as JSON: {e}")
if resp.get("dryRun") is not True:
    sys.exit(f"INVARIANT VIOLATION: {sys.argv[2]} leg response dryRun != true. "
             "Do NOT invoke again until this is understood.")
if not isinstance(resp.get("plans"), list):
    sys.exit(f"ERROR: {sys.argv[2]} leg dry response has no plans[] despite the A0.3 sentinel — "
             "do not trust this deploy for soak diffs.")
print(f"[invoke:{sys.argv[2]}] dry run complete (no writes): today={resp.get('today')} rows={resp.get('rows')}")
PY
}

invoke_leg plain  "$P_PLAIN"  "$TMPD/plain.json"
invoke_leg ledger "$P_LEDGER" "$TMPD/ledger.json"

# ---------- diff + report ----------
mkdir -p "$OUT_DIR" || die "could not create output dir: $OUT_DIR"
python3 - "$TMPD/plain.json" "$TMPD/ledger.json" "$OUT_DIR" "$FN" "$REGION" <<'PY'
import datetime, json, os, re, sys

plain = json.load(open(sys.argv[1]))
ledger = json.load(open(sys.argv[2]))
out_dir, fn, region = sys.argv[3], sys.argv[4], sys.argv[5]

if plain.get("today") != ledger.get("today"):
    sys.exit(f"ERROR: plan dates differ between legs ({plain.get('today')} vs {ledger.get('today')}) — "
             "the pair likely straddled midnight ET; rerun so both legs share one plan date.")
plan_date = plain.get("today") or ""
if not re.match(r"^\d{4}-\d{2}-\d{2}$", plan_date):
    sys.exit(f"ERROR: response carried no valid plan date: {plan_date!r}")

# One verdict per planting per leg. Buckets are the engine's own taxonomy (engine.generatePlanForUser):
# water_due -> due, rain_skipped -> skipped (due but saturation-suppressed), no_history -> never
# (never-watered; byte-identical across legs by design). Everything else emits no row = notdue.
BUCKETS = (("water_due", "due"), ("rain_skipped", "skipped"), ("no_history", "never"))

def verdicts(resp):
    rows = {}
    for entry in resp.get("plans") or []:
        tasks = ((entry.get("plan") or {}).get("tasks")) or {}
        for bucket, verdict in BUCKETS:
            for r in tasks.get(bucket) or []:
                if r.get("id") is None:
                    continue
                # plant ids are unique across users/spaces (a planting has one assignee); if a future
                # data shape ever violates that, last-writer-wins here and the counts stay per-planting.
                rows[r["id"]] = {"row": r, "verdict": verdict,
                                 "user_id": entry.get("user_id"), "space_id": entry.get("space_id")}
    return rows

def side(entry):
    # ABSENT = NOT-DUE, recorded as such. The ledger leg emits rows only where the fold says due
    # (or saturation-skips a due planting); "no row" is a verdict, not a gap.
    if entry is None:
        return {"verdict": "notdue", "due": False}
    r = entry["row"]
    out = {"verdict": entry["verdict"], "due": entry["verdict"] == "due",
           "days_since": r.get("days_since"), "overdue_by": r.get("overdue_by"),
           "interval": r.get("interval")}
    lg = r.get("ledger")
    if isinstance(lg, dict):  # additive key, present only on fold-produced rows (ledger leg)
        out.update({"D": lg.get("d"), "due_at": lg.get("due_at"), "wi_eff": lg.get("wi_eff"),
                    "confidence": lg.get("confidence"), "drivers": lg.get("drivers")})
    return out

L, G = verdicts(plain), verdicts(ledger)
plantings, flips = [], 0
for pid in sorted(set(L) | set(G), key=str):
    l, g = L.get(pid), G.get(pid)
    src = g or l
    lv, gv = side(l), side(g)
    flip = lv["due"] != gv["due"]
    flips += flip
    plantings.append({
        "plant_id": pid, "name": src["row"].get("name"),
        # v2: `crop` and `in_ground` are stored because the FLIP GATE is per-CROP-CLASS
        # ("median effective-interval shift per crop class <= +-10%") and v1 stored neither, so
        # scripts/f2-flip-gate.py had to fall back to grouping on the leading token of the planting
        # NAME — which turned 44 real classes into 86 singletons and made every class n=1. A
        # per-class bound evaluated on n=1 classes is not a bound. The engine already returns both
        # fields on every row; v1 simply dropped them.
        "crop": src["row"].get("crop"), "in_ground": src["row"].get("in_ground"),
        "user_id": src.get("user_id"), "space_id": src.get("space_id"),
        "legacy": lv, "ledger": gv,
        "delta_class": "same" if lv["verdict"] == gv["verdict"] else f"{lv['verdict']}->{gv['verdict']}",
        "verdict_flip": bool(flip),
    })

summary = {
    "plantings": len(plantings),
    "due_legacy": sum(1 for p in plantings if p["legacy"]["due"]),
    "due_ledger": sum(1 for p in plantings if p["ledger"]["due"]),
    "verdict_flips": flips,
    "skipped_legacy": sum(1 for p in plantings if p["legacy"]["verdict"] == "skipped"),
    "skipped_ledger": sum(1 for p in plantings if p["ledger"]["verdict"] == "skipped"),
    "never_both": sum(1 for p in plantings if p["legacy"]["verdict"] == p["ledger"]["verdict"] == "never"),
}
report = {
    # v2 adds per-planting `crop` + `in_ground` (see the plantings append above). Additive only —
    # every v1 field keeps its name and meaning, so a v1 reader is unaffected and f2-flip-gate.py
    # accepts both, degrading v1 samples to name-based crop grouping with a warning.
    "schema": "f2-soak-v2",
    "plan_date": plan_date,
    "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    "function": fn, "region": region,
    "flag_overrides": {"CARE_WATER_LEDGER_ENABLED": True},
    "summary": summary,
    "plantings": plantings,
}
out_path = os.path.join(out_dir, f"soak-{plan_date.replace('-', '')}.json")
tmp_path = out_path + ".tmp"
with open(tmp_path, "w") as f:
    json.dump(report, f, indent=1)
    f.write("\n")
os.replace(tmp_path, out_path)  # idempotent per day: a same-day rerun atomically overwrites

if not plantings:
    print("[soak] WARNING: zero water-verdict rows in BOTH legs — a real garden never looks like this; "
          "check the responses before trusting the sample.")
print(f"[soak] {plan_date}: {summary['plantings']} plantings, {summary['due_legacy']} due-legacy, "
      f"{summary['due_ledger']} due-ledger, {summary['verdict_flips']} verdict-flips")
print(f"[soak] report written: {out_path}")
PY
