#!/usr/bin/env bash
# V4-HARVRATCHET-001 — propagate improved per-cultivar weight factors into stored harvest weights.
#
# WHAT THIS TURNS ON. Dave's ask: "the ratchet is the point — the estimate visibly improves as more
# harvests get weighed." Two thirds of that already shipped and nobody wired the last third:
#   - v4-cal1-slicec-001/0f-autocapture.sql already turns every dual count+weight harvest into a
#     calibration sample, automatically, with no effort beyond putting the bowl on the scale.
#   - v4-cal1-slicec-001/0c-backfill-basis.sql re-derives every non-user-measured weight through
#     resolve_harvest_weight and says so in its own header: "RE-RUNNABLE ... Run it again after any
#     new sample lands to propagate the improved factor."
# Nothing ever ran 0c again. So samples accumulated and the 360-odd stored estimates never moved.
# This is that scheduled re-run — a job, not a redesign.
#
# WHY IT IS NOT JUST `psql -f 0c`. Re-deriving blind would have shipped two real harms:
#
#   1. THE RATCHET CAN RUN BACKWARDS, VISIBLY. Measured live: estimated rows average ~172 g against
#      ~114 g for user-weighed rows, and 21 of 23 paired cultivars come in BELOW the catalogue
#      reference. So the first unguarded run drops the season total in one step. Dave asked for a
#      number that visibly improves; a total that silently falls by a third reads as "the more I
#      weigh, the less I grew" and extinguishes the behaviour the ratchet exists to reward. Hence
#      --max-total-drop-pct: a large one-step move is REPORTED for a decision, never auto-applied.
#
#   2. BAD SAMPLES PROPAGATE. Live outliers among PROMOTED cultivars: Aster at 0.69 g/count against
#      a 6 g reference (0.12x) and Pineapple Tomatillo at 1.50 vs 8 (0.19x). Both are confidence
#      'high' on n=2, so resolve_harvest_weight WILL use them. (The two Beefsteak rows at 16 g and
#      28 g per count against a 350 g reference are the loudest bad data in the set, but they land
#      at confidence 'low', which the resolver does not promote — so they are reported and are not
#      currently propagating.) An unreviewed outlier is refused, not silently spread.
#
# SAFETY MODEL, in order:
#   - DRY-RUN BY DEFAULT. --apply is required to write anything.
#   - MEASURED-SAFE. The row predicate is copied verbatim from 0c: a weight the user typed is never
#     re-derived. Losing a real measurement to an estimate is the one unrecoverable outcome here.
#   - FAIL-CLOSED on unreviewed outliers and on an oversized total move. Both exit 1 (the alert
#     signal integrity-weekly.yml already established) WITHOUT applying.
#   - IDEMPOTENT. With no new samples the resolver is a pure function of unchanged inputs, so a
#     second run reports 0 changed rows.
#   - The derivation is NEVER reimplemented here. It calls resolve_harvest_weight, the same function
#     both Lambda write paths use, so this job cannot drift from live writes.
#
# Exit codes follow the house convention (cf. integrity-weekly-check.sh):
#   0 = OK (applied, or dry-run with nothing blocking)   1 = ALERT (blocked; nothing written)
#   2 = ERROR (input/DB unusable)
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL required}"
ACK_FILE="${ACK_FILE:-scripts/harvest-weight-ratchet-ack.json}"
OUT="${OUT:-harvest-ratchet-report.json}"
OUTLIER_FACTOR="${OUTLIER_FACTOR:-5}"          # flag a promoted factor >5x or <1/5x its reference
MAX_TOTAL_DROP_PCT="${MAX_TOTAL_DROP_PCT:-25}" # refuse a one-step move larger than this
APPLY=0
for a in "$@"; do case "$a" in --apply) APPLY=1 ;; --dry-run) APPLY=0 ;; esac; done

[ -f "$ACK_FILE" ] || { echo "FATAL: ack file $ACK_FILE missing" >&2; exit 2; }
ACK_JSON="$(cat "$ACK_FILE")"

# ── Analysis. One READ ONLY transaction; nothing below writes. ────────────────────────────────────
#
# `promoted` mirrors resolver v4's own gate (confidence IN ('high','medium') OR sample_n >= 5) so
# the outlier scan looks at exactly the factors the resolver will actually USE. Scanning every
# derived row instead would flag single-sample provisionals the resolver already refuses, burying
# the two that matter.
# The analysis SQL goes to a temp file rather than a heredoc inside $( ): bash 3.2 (the macOS
# default) mis-parses a heredoc nested in a command substitution, and this script has to run both
# on a GitHub runner and on Dave's Mac.
WORKDIR="$(mktemp -d)"; trap 'rm -rf "$WORKDIR"' EXIT
cat > "$WORKDIR/analyze.sql" <<'SQL'
BEGIN TRANSACTION READ ONLY;

WITH ack AS (
  SELECT coalesce(array_agg(value::text), ARRAY[]::text[]) AS ids
    FROM json_array_elements_text((:'ack')::json -> 'reviewed_cultivar_ids') AS value
),
promoted AS (
  SELECT d.cultivar_id, d.unit, d.grams_per_unit, d.sample_n, d.confidence,
         c.display_name,
         coalesce((pv.unit_weights ->> d.unit)::numeric,
                  (ct.unit_weights ->> d.unit)::numeric) AS ref_g
    FROM cultivar_weight_derived d
    JOIN cultivar c ON c.id = d.cultivar_id
    LEFT JOIN plant_varieties pv ON pv.id = d.cultivar_id
    LEFT JOIN crop_types ct ON ct.slug = c.crop_type_slug
   WHERE d.confidence IN ('high','medium') OR d.sample_n >= 5
),
outliers AS (
  SELECT p.*, round(p.grams_per_unit / nullif(p.ref_g,0), 3) AS ratio
    FROM promoted p
   WHERE p.ref_g IS NOT NULL
     AND (p.grams_per_unit / nullif(p.ref_g,0) > (:'factor')::numeric
       OR p.grams_per_unit / nullif(p.ref_g,0) < 1.0/(:'factor')::numeric)
),
unreviewed AS (
  SELECT o.* FROM outliers o, ack WHERE NOT (o.cultivar_id::text = ANY(ack.ids))
),
-- The same row set 0c touches, resolved as it would be TODAY. Measured-safe predicate verbatim.
proposed AS (
  SELECT h.id, h.weight_grams AS old_g, h.weight_basis AS old_basis,
         rw.weight_grams AS new_g, rw.weight_basis AS new_basis
    FROM harvest_log h
    JOIN event_log e ON e.id = h.event_id AND e.deleted_at IS NULL
    CROSS JOIN LATERAL public.resolve_harvest_weight(e.plant_id, h.unit, h.quantity, NULL) rw
   WHERE h.deleted_at IS NULL
     AND NOT (h.weight_estimated IS FALSE AND h.unit NOT IN ('g','kg','lb','oz'))
),
changed AS (
  SELECT * FROM proposed
   WHERE old_g IS DISTINCT FROM new_g OR old_basis IS DISTINCT FROM new_basis
),
-- A DEMOTION is the ratchet running backwards: a row falling from a sample-backed basis back to a
-- catalogue one, which also retracts the user-facing "estimated from your own weighings" sentence.
-- Reported loudly rather than blocked — it is a real signal about the resolver's tier ordering, not
-- corruption, and hiding it would make the ratchet claim unfalsifiable.
demotions AS (
  SELECT * FROM changed WHERE old_basis = 'cultivar_sample' AND new_basis IS DISTINCT FROM 'cultivar_sample'
),
totals AS (
  SELECT coalesce(sum(old_g),0) AS old_total, coalesce(sum(new_g),0) AS new_total FROM proposed
)
SELECT json_build_object(
  'rows_in_scope',    (SELECT count(*) FROM proposed),
  'rows_changed',     (SELECT count(*) FROM changed),
  'demotions',        (SELECT count(*) FROM demotions),
  'old_total_g',      (SELECT round(old_total,1) FROM totals),
  'new_total_g',      (SELECT round(new_total,1) FROM totals),
  'total_change_pct', (SELECT CASE WHEN old_total = 0 THEN 0
                            ELSE round(100.0 * (new_total - old_total) / old_total, 2) END FROM totals),
  'basis_composition_after', (SELECT coalesce(json_object_agg(b, n), '{}'::json)
     FROM (SELECT coalesce(new_basis,'(none)') b, count(*) n FROM proposed GROUP BY 1) t),
  'unreviewed_outliers', (SELECT coalesce(json_agg(json_build_object(
       'cultivar_id', cultivar_id, 'name', display_name, 'unit', unit,
       'sample_g', round(grams_per_unit,2), 'reference_g', ref_g,
       'ratio', ratio, 'sample_n', sample_n, 'confidence', confidence)), '[]'::json) FROM unreviewed)
) ;
SQL

REPORT="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qAt \
  -v ack="$ACK_JSON" -v factor="$OUTLIER_FACTOR" -f "$WORKDIR/analyze.sql")" \
  || { echo "FATAL: analysis query failed" >&2; exit 2; }

echo "$REPORT" > "$OUT"
python3 - "$OUT" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
print(f"  rows in scope : {r['rows_in_scope']}")
print(f"  rows changed  : {r['rows_changed']}   demotions: {r['demotions']}")
print(f"  total grams   : {r['old_total_g']} -> {r['new_total_g']}  ({r['total_change_pct']}%)")
print(f"  basis after   : {r['basis_composition_after']}")
for o in r['unreviewed_outliers']:
    print(f"  OUTLIER {o['name']} ({o['unit']}): {o['sample_g']}g vs ref {o['reference_g']}g "
          f"= {o['ratio']}x  n={o['sample_n']} {o['confidence']}  id={o['cultivar_id']}")
PY

BLOCK=0
N_OUT="$(python3 -c "import json;print(len(json.load(open('$OUT'))['unreviewed_outliers']))")"
DROP="$(python3 -c "import json;print(json.load(open('$OUT'))['total_change_pct'])")"

if [ "$N_OUT" -gt 0 ]; then
  echo "ALERT: $N_OUT promoted cultivar factor(s) diverge from their reference by more than ${OUTLIER_FACTOR}x and are unreviewed." >&2
  echo "  These are the factors resolve_harvest_weight will USE. Review each, then either correct the" >&2
  echo "  samples (void-don't-edit: cultivar_weight_void) or add the cultivar id to $ACK_FILE." >&2
  BLOCK=1
fi
if python3 -c "import sys;sys.exit(0 if float('$DROP') < -float('$MAX_TOTAL_DROP_PCT') else 1)"; then
  echo "ALERT: applying would move the stored harvest total by ${DROP}% in one step (limit ${MAX_TOTAL_DROP_PCT}%)." >&2
  echo "  A single large drop is the reward-inversion failure this guard exists to prevent. Decide" >&2
  echo "  deliberately: calibrate the catalogue first, or re-run with MAX_TOTAL_DROP_PCT raised." >&2
  BLOCK=1
fi

if [ "$BLOCK" -eq 1 ]; then echo "BLOCKED — nothing written." >&2; exit 1; fi
if [ "$APPLY" -eq 0 ]; then echo "DRY RUN — nothing written. Pass --apply to propagate."; exit 0; fi

# ── Apply. Same CTE shape as 0c so the two cannot drift. ──────────────────────────────────────────
#
# SNAPSHOT FIRST, IN THE SAME TRANSACTION. resolve_harvest_weight is not invertible: once a row is
# re-derived, the grams it previously carried cannot be reconstructed from the row, and
# cultivar_weight_derived is a VIEW, so the inputs that produced the old value are not retained
# either. Without a snapshot this job is a one-way door on numbers Dave reads. With one, a bad run
# is a single UPDATE ... FROM away from undone.
SNAP="harvest_log_weight_snapshot_$(date -u +%Y%m%d_%H%M%S)"
echo "snapshot: $SNAP"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -v snap="$SNAP" <<'SQL'
BEGIN;
-- Every row in scope, not just the changed ones: restoring must be able to put the table back
-- exactly, and "which rows changed" is a property of the run, not of the table.
CREATE TABLE :"snap" AS
  SELECT h.id, h.weight_grams, h.weight_estimated, h.weight_basis, now() AS snapshot_at
    FROM public.harvest_log h
   WHERE h.deleted_at IS NULL
     AND NOT (h.weight_estimated IS FALSE AND h.unit NOT IN ('g','kg','lb','oz'));
WITH resolved AS (
  SELECT h.id, rw.weight_grams, rw.weight_estimated, rw.weight_basis
    FROM public.harvest_log h
    JOIN public.event_log e ON e.id = h.event_id AND e.deleted_at IS NULL
    CROSS JOIN LATERAL public.resolve_harvest_weight(e.plant_id, h.unit, h.quantity, NULL) rw
   WHERE h.deleted_at IS NULL
     AND NOT (h.weight_estimated IS FALSE AND h.unit NOT IN ('g','kg','lb','oz'))
)
UPDATE public.harvest_log h
   SET weight_grams     = r.weight_grams,
       weight_estimated = r.weight_estimated,
       weight_basis     = r.weight_basis,
       updated_at       = now()
  FROM resolved r
 WHERE r.id = h.id
   AND (h.weight_grams IS DISTINCT FROM r.weight_grams
     OR h.weight_basis IS DISTINCT FROM r.weight_basis);
COMMIT;
SQL
echo "APPLIED. Undo: UPDATE harvest_log h SET weight_grams=s.weight_grams,"
echo "  weight_estimated=s.weight_estimated, weight_basis=s.weight_basis FROM $SNAP s WHERE s.id=h.id;"
