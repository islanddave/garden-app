#!/usr/bin/env bash
# P0 weekly data-integrity check — garden-app (data-audit plan V100 §P0; authored W3.D 2026-07-28).
# Repo home when it ships: garden-app/scripts/integrity-weekly-check.sh
# Six check classes: (1) per-class orphans (checked-edge list + unattached), (2) care-dupe delta,
# (3) phantom photo-event delta, (4) user_stats-vs-xp_events drift, (5) S3<->DB mismatch,
# (6) cultivar faceting — untyped + missing derived type tag (V4-INTAKE-001, added 2026-08-05).
# DELTA semantics: ALERT only when current > baseline (growth). Shrinkage = improvement note
# (baseline refresh rides the repair's own commit). NO tables are created; run snapshots persist
# as workflow artifacts; the committed baseline lives at scripts/integrity-baselines.json.
# DB access is a single READ ONLY transaction. Exit codes: 0=OK, 1=ALERT (sink signal), 2=ERROR.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL required}"
BASELINE_FILE="${BASELINE_FILE:-scripts/integrity-baselines.json}"
OUT="${OUT:-integrity-report.json}"
PHOTOS_BUCKET="${PHOTOS_BUCKET:-}"   # empty => S3 class reports UNVERIFIED (never a false alert)
RUN_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
GIT_SHA="${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

[ -f "$BASELINE_FILE" ] || { echo "FATAL: baseline file $BASELINE_FILE missing" >&2; exit 2; }

# ---------- DB metrics (one READ ONLY txn, one JSON result) ----------
DB_JSON="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qAt <<'SQL'
BEGIN TRANSACTION READ ONLY;
SELECT json_build_object(
  'event_unattached_total', (SELECT count(*) FROM event_log WHERE deleted_at IS NULL AND plant_id IS NULL),
  'event_unattached_by_type', (SELECT coalesce(json_object_agg(event_type, n), '{}'::json)
     FROM (SELECT event_type, count(*) n FROM event_log
           WHERE deleted_at IS NULL AND plant_id IS NULL GROUP BY 1) t),
  'events_to_deleted_plants', (SELECT count(*) FROM event_log e LEFT JOIN plants p ON p.id = e.plant_id
     WHERE e.deleted_at IS NULL AND e.plant_id IS NOT NULL AND (p.id IS NULL OR p.deleted_at IS NOT NULL)),
  'photos_to_deleted_events', (SELECT count(*) FROM photos ph LEFT JOIN event_log e ON e.id = ph.event_id
     WHERE ph.deleted_at IS NULL AND ph.event_id IS NOT NULL AND (e.id IS NULL OR e.deleted_at IS NOT NULL)),
  'harvest_log_to_deleted_events', (SELECT count(*) FROM harvest_log hl LEFT JOIN event_log e ON e.id = hl.event_id
     WHERE hl.deleted_at IS NULL AND hl.event_id IS NOT NULL AND (e.id IS NULL OR e.deleted_at IS NOT NULL)),
  -- MISSING parent, not merely soft-deleted (narrowed 2026-08-03, BUG-EVTCASCADE-001).
  -- The original predicate treated a SOFT-DELETED parent as an orphan, which made this metric a
  -- census of deliberate policy rather than of corruption: garden-app never claws a reward back
  -- when its source event is undone or its planting is deleted (same rule the events Lambda states
  -- for XP/streak/achievements), so every undo-after-award legitimately produced a "+1 orphan" and
  -- the metric could only ever ratchet upward — 10 of 10 live rows were this benign case. A row
  -- pointing at a HARD-DELETED / never-existent parent is real referential damage and still alerts.
  'critter_state_orphans', (SELECT count(*) FROM critter_state cs WHERE cs.deleted_at IS NULL AND (
       (cs.source_event_id IS NOT NULL AND NOT EXISTS
          (SELECT 1 FROM event_log e WHERE e.id = cs.source_event_id))
    OR (cs.plant_id IS NOT NULL AND NOT EXISTS
          (SELECT 1 FROM plants p WHERE p.id = cs.plant_id)))),
  -- Rate, not census (added 2026-08-03). event_unattached_total below is a CUMULATIVE count of a
  -- shipped, intentional product path — project-level harvest/photo logging, the rows V4-HARVESTQTY-001
  -- deliberately surfaces as "unattributed" — running ~2/day. As an alert metric it breached any fixed
  -- baseline within days and would have demanded a weekly re-baseline forever, which is how a monitor
  -- trains you to ignore it. The total stays REPORTED (trend/forensics); the ALERT moved here, to a
  -- 7-day inflow that fires on a genuine SPIKE and returns to normal on its own.
  'event_unattached_new_7d', (SELECT count(*) FROM event_log
     WHERE deleted_at IS NULL AND plant_id IS NULL AND created_at >= NOW() - INTERVAL '7 days'),
  'favorites_orphans', (SELECT count(*) FROM favorites f WHERE
       (f.entity_type = 'plant'   AND NOT EXISTS (SELECT 1 FROM plants p         WHERE p.id  = f.entity_id AND p.deleted_at  IS NULL))
    OR (f.entity_type = 'project' AND NOT EXISTS (SELECT 1 FROM plant_projects pp WHERE pp.id = f.entity_id AND pp.deleted_at IS NULL))),
  'entity_memory_orphans', (SELECT count(*) FROM entity_memory em WHERE
       (em.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM plant_projects pp WHERE pp.id = em.project_id AND pp.deleted_at IS NULL))
    OR (em.plant_id   IS NOT NULL AND NOT EXISTS (SELECT 1 FROM plants p          WHERE p.id  = em.plant_id   AND p.deleted_at  IS NULL))),
  -- Must enumerate EVERY parent photos_must_have_parent recognises, or a legal row reads as a
  -- violation. That CHECK is 7-clause; this predicate is the same 7 minus the pending_tag escape.
  -- space_id added 2026-08-02 (V4-SPACEPHOTO-001): it is a valid parent both in the live CHECK and
  -- in the app, so without this the FIRST space photo ever uploaded takes the count 0 -> 1 and pages
  -- a weekly ALERT for a perfectly correct row. Exactly the BUG-PHOTOPARENT-001 failure recorded in
  -- integrity-baselines.json, where inventory_item_id was the missing clause and produced 6 false
  -- positives. When the CHECK gains a clause, it gains one here in the same commit.
  -- W-INTEG (2026-08-12): the pending_tag ESCAPE, the seventh clause of the CHECK and the one this
  -- predicate had always omitted. The rule one line above says "the same 7 minus the pending_tag
  -- escape" — which was correct only while nothing could produce such a row. A quick-tag photo (or
  -- a batch-undo fallback, W-BATCHNULL) legitimately sits parentless AND pending, so without this
  -- the FIRST one pages a weekly ALERT for a row the CHECK explicitly permits. That is the THIRD
  -- recurrence of the BUG-PHOTOPARENT-001 class the baselines file already warns about twice.
  -- A row that is parentless and NOT pending is still a genuine violation and still counted.
  'photos_parentless', (SELECT count(*) FROM photos WHERE deleted_at IS NULL
     AND project_id IS NULL AND event_id IS NULL AND plant_id IS NULL AND location_id IS NULL
     AND inventory_item_id IS NULL AND space_id IS NULL
     AND intake_status IS DISTINCT FROM 'pending_tag'),
  'photos_to_deleted_inventory', (SELECT count(*) FROM photos ph LEFT JOIN inventory_items i ON i.id = ph.inventory_item_id
     WHERE ph.deleted_at IS NULL AND ph.inventory_item_id IS NOT NULL AND (i.id IS NULL OR i.deleted_at IS NOT NULL)),
  'care_dupe_groups', (SELECT count(*) FROM (
     SELECT plant_id, (event_date AT TIME ZONE 'America/New_York')::date d, count(*) c
     FROM event_log WHERE deleted_at IS NULL AND event_type = 'watering' AND plant_id IS NOT NULL
     GROUP BY 1, 2 HAVING count(*) > 1) g),
  'care_dupe_excess', (SELECT coalesce(sum(c - 1), 0) FROM (
     SELECT plant_id, (event_date AT TIME ZONE 'America/New_York')::date d, count(*) c
     FROM event_log WHERE deleted_at IS NULL AND event_type = 'watering' AND plant_id IS NOT NULL
     GROUP BY 1, 2 HAVING count(*) > 1) g),
  'harvest_multi_groups', (SELECT count(*) FROM (
     SELECT plant_id, (event_date AT TIME ZONE 'America/New_York')::date d, count(*) c
     FROM event_log WHERE deleted_at IS NULL AND event_type = 'harvest' AND plant_id IS NOT NULL
     GROUP BY 1, 2 HAVING count(*) > 1) g),
  'phantom_photo_events', (SELECT count(*) FROM event_log e
     WHERE e.deleted_at IS NULL AND e.event_type = 'photo'
       AND NOT EXISTS (SELECT 1 FROM photos p WHERE p.event_id = e.id)),
  'user_stats_drift', (SELECT count(*) FROM (
     SELECT le.user_id FROM (SELECT user_id, SUM(amount) ledger_xp FROM xp_events GROUP BY 1) le
     FULL OUTER JOIN user_stats us ON us.user_id = le.user_id
     WHERE (le.user_id IS NOT NULL AND us.user_id IS NULL)
        OR (le.user_id IS NOT NULL AND us.user_id IS NOT NULL AND le.ledger_xp <> us.xp)) d),
  -- Class 6: cultivar faceting (V4-INTAKE-001, L-239). Two DISTINCT failure shapes, because a
  -- cultivar can fall out of the by-type view two different ways and the existing scripts only
  -- ever covered the second one:
  --   (a) cultivars_untyped — crop_type_slug IS NULL. This IS the "Unsorted" class. NOTHING
  --       detected it before this metric: check-cultivar-faceting.mjs filters to
  --       `crop_type_slug IS NOT NULL`, and healthcheck-cultivar-facets.mjs derives the DESIRED
  --       tag set from the cultivar row, so a null slug yields no desired type tag and therefore
  --       no gap. Both scripts report OK on precisely the population that is broken. A NULL slug
  --       does not error anywhere — the cultivar just silently vanishes from every faceted view.
  --   (b) cultivars_missing_type_tag — has a crop_type_slug but no derived type: tag link, i.e.
  --       a write that reached plant_varieties without the applyDerive tail (direct-Neon inserts,
  --       a loader that skipped the heal). This is the check-cultivar-faceting.mjs predicate,
  --       reproduced verbatim so the weekly job does not depend on anyone remembering to run it.
  -- Both baseline at 0 and must STAY 0: unlike a census of accumulated debris, any nonzero here
  -- is a live intake regression. Remediate (b) with scripts/reconcile-cultivar-facets.mjs; (a)
  -- needs the crop type actually supplied at the write site — the reconciler cannot invent one.
  'cultivars_untyped', (SELECT count(*) FROM plant_varieties v
     WHERE v.deleted_at IS NULL AND v.crop_type_slug IS NULL),
  'cultivars_missing_type_tag', (SELECT count(*) FROM plant_varieties v
     WHERE v.deleted_at IS NULL AND v.crop_type_slug IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM entity_tag et JOIN tag t ON t.id = et.tag_id
         WHERE et.entity_type = 'cultivar' AND et.entity_id = v.id AND et.deleted_at IS NULL
           AND t.source = 'derived' AND t.facet = 'type' AND t.slug = v.crop_type_slug
           AND t.deleted_at IS NULL)),
  'db_photo_rows_live', (SELECT count(*) FROM photos WHERE deleted_at IS NULL)
);
ROLLBACK;
SQL
)" || { echo "FATAL: DB metrics query failed" >&2; exit 2; }
echo "$DB_JSON" | jq -e . > "$WORKDIR/db.json" || { echo "FATAL: DB metrics not valid JSON" >&2; exit 2; }

# ---------- S3 <-> DB (class 5; fail-soft to UNVERIFIED) ----------
S3_STATUS="UNVERIFIED"; S3_NOT_IN_DB="null"; DB_NOT_IN_S3="null"; S3_SAMPLE="[]"
if [ -n "$PHOTOS_BUCKET" ]; then
  # aws's OWN exit status must gate MEASURED (a pipeline would report sort's rc and a
  # connect failure would masquerade as "0 keys" -> false mass data-loss alert).
  if aws s3api list-objects-v2 --bucket "$PHOTOS_BUCKET" --query 'Contents[].Key' --output text \
       --cli-connect-timeout 10 --cli-read-timeout 60 > "$WORKDIR/s3raw" 2>"$WORKDIR/s3err"; then
    tr '\t' '\n' < "$WORKDIR/s3raw" | grep -v '^thumbs/' | grep -v '^None$' | grep -v '^$' \
      | sort -u > "$WORKDIR/s3keys" || true
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qAt \
      -c "BEGIN TRANSACTION READ ONLY; COPY (SELECT storage_path FROM photos ORDER BY storage_path) TO STDOUT; ROLLBACK;" \
      | sort -u > "$WORKDIR/dbpaths" || { echo "FATAL: storage_path query failed" >&2; exit 2; }
    NKEYS=$(wc -l < "$WORKDIR/s3keys" | tr -d ' '); NDB=$(wc -l < "$WORKDIR/dbpaths" | tr -d ' ')
    if [ "$NKEYS" -lt $((NDB / 2)) ]; then
      # Partial/empty listing sanity guard: never convert a truncated list into a data-loss alert.
      echo "WARN: S3 listing implausibly small ($NKEYS keys vs $NDB DB paths) — S3 class UNVERIFIED" >&2
    else
      S3_NOT_IN_DB=$(comm -23 "$WORKDIR/s3keys" "$WORKDIR/dbpaths" | wc -l | tr -d ' ')
      DB_NOT_IN_S3=$(comm -13 "$WORKDIR/s3keys" "$WORKDIR/dbpaths" | wc -l | tr -d ' ')
      S3_SAMPLE=$(comm -23 "$WORKDIR/s3keys" "$WORKDIR/dbpaths" | head -10 | jq -R . | jq -s .)
      S3_STATUS="MEASURED"
    fi
  else
    echo "WARN: S3 list failed (network, or role lacks s3:ListBucket on photos bucket) — S3 class UNVERIFIED" >&2
    head -3 "$WORKDIR/s3err" >&2 || true
  fi
else
  echo "WARN: PHOTOS_BUCKET unset — S3 class UNVERIFIED" >&2
fi

# ---------- Compare vs baseline ----------
jq -n \
  --slurpfile db "$WORKDIR/db.json" \
  --slurpfile base "$BASELINE_FILE" \
  --arg run_at "$RUN_AT" --arg git_sha "$GIT_SHA" \
  --arg s3_status "$S3_STATUS" --arg baseline_file "$BASELINE_FILE" \
  --argjson s3_not_in_db "$S3_NOT_IN_DB" --argjson db_not_in_s3 "$DB_NOT_IN_S3" \
  --argjson s3_sample "$S3_SAMPLE" '
  ($db[0] + {s3_not_in_db: $s3_not_in_db, db_not_in_s3: $db_not_in_s3}) as $cur
  | $base[0].metrics as $b
  | ($base[0].alert_metrics) as $alertable
  # Threshold metrics (added 2026-08-03) read "current > baseline" as "over the ceiling", not as
  # "drifted from a census". Being UNDER one is the normal resting state, so they are excluded from
  # improvements — otherwise every healthy run emits a permanent "improved … refresh the baseline"
  # line, which is both noise and actively wrong advice (dropping the ceiling to the last quiet week
  # would guarantee a false alert on the next busy one).
  | (($base[0].threshold_metrics) // []) as $thresholds
  | [ $alertable[] as $k
      | select(($cur[$k] != null) and ($b[$k] != null) and ($cur[$k] > $b[$k]))
      | "\($k) grew above baseline: \($b[$k]) -> \($cur[$k]) (+\($cur[$k] - $b[$k]))"
        + (if $k == "phantom_photo_events" then " [AMBIGUITY: no client-version attribution exists; a stale pre-v3.73 client is indistinguishable from a funnel regression — evidence W0.2b-r1 stale-client-baseline]" else "" end)
        + (if $k == "db_not_in_s3" then " [DATA LOSS CLASS: DB row references a missing S3 object]" else "" end) ] as $alerts
  | [ $alertable[] as $k
      | select(($cur[$k] != null) and ($b[$k] != null) and ($cur[$k] < $b[$k])
               and (($thresholds | index($k)) == null))
      | "\($k) improved: \($b[$k]) -> \($cur[$k]) (refresh baseline with the repair commit)" ] as $improvements
  | ([ $alertable[] | select($cur[.] == null) | "metric \(.) UNMEASURED this run" ]
     + (if $s3_status != "MEASURED" then ["S3<->DB class UNVERIFIED (bucket list unavailable this run)"] else [] end)) as $warnings
  | { job: "integrity-weekly",
      run_at: $run_at,
      git_sha: $git_sha,
      status: (if ($alerts | length) > 0 then "ALERT"
               elif ($warnings | length) > 0 then "OK_WITH_UNVERIFIED"
               else "OK" end),
      alerts: $alerts,
      improvements: $improvements,
      warnings: $warnings,
      metrics: ($cur + {s3_status: $s3_status, s3_not_in_db_sample: $s3_sample}),
      baseline: { file: $baseline_file, seeded_at: $base[0].seeded_at, evidence: $base[0].evidence_run_ids } }
  ' > "$OUT" || { echo "FATAL: report assembly failed" >&2; exit 2; }

STATUS=$(jq -r .status "$OUT")
echo "integrity-weekly: $STATUS"
jq -r '.alerts[]?, .improvements[]?, .warnings[]?' "$OUT"
[ "$STATUS" = "ALERT" ] && exit 1
exit 0
