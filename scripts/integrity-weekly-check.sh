#!/usr/bin/env bash
# P0 weekly data-integrity check — garden-app (data-audit plan V100 §P0; authored W3.D 2026-07-28).
# Repo home when it ships: garden-app/scripts/integrity-weekly-check.sh
# Five check classes: (1) per-class orphans (checked-edge list + unattached), (2) care-dupe delta,
# (3) phantom photo-event delta, (4) user_stats-vs-xp_events drift, (5) S3<->DB mismatch.
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
  'critter_state_orphans', (SELECT count(*) FROM critter_state cs WHERE cs.deleted_at IS NULL AND (
       (cs.source_event_id IS NOT NULL AND NOT EXISTS
          (SELECT 1 FROM event_log e WHERE e.id = cs.source_event_id AND e.deleted_at IS NULL))
    OR (cs.plant_id IS NOT NULL AND NOT EXISTS
          (SELECT 1 FROM plants p WHERE p.id = cs.plant_id AND p.deleted_at IS NULL)))),
  'favorites_orphans', (SELECT count(*) FROM favorites f WHERE
       (f.entity_type = 'plant'   AND NOT EXISTS (SELECT 1 FROM plants p         WHERE p.id  = f.entity_id AND p.deleted_at  IS NULL))
    OR (f.entity_type = 'project' AND NOT EXISTS (SELECT 1 FROM plant_projects pp WHERE pp.id = f.entity_id AND pp.deleted_at IS NULL))),
  'entity_memory_orphans', (SELECT count(*) FROM entity_memory em WHERE
       (em.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM plant_projects pp WHERE pp.id = em.project_id AND pp.deleted_at IS NULL))
    OR (em.plant_id   IS NOT NULL AND NOT EXISTS (SELECT 1 FROM plants p          WHERE p.id  = em.plant_id   AND p.deleted_at  IS NULL))),
  'photos_parentless', (SELECT count(*) FROM photos WHERE deleted_at IS NULL
     AND project_id IS NULL AND event_id IS NULL AND plant_id IS NULL AND location_id IS NULL),
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
  | [ $alertable[] as $k
      | select(($cur[$k] != null) and ($b[$k] != null) and ($cur[$k] > $b[$k]))
      | "\($k) grew above baseline: \($b[$k]) -> \($cur[$k]) (+\($cur[$k] - $b[$k]))"
        + (if $k == "phantom_photo_events" then " [AMBIGUITY: no client-version attribution exists; a stale pre-v3.73 client is indistinguishable from a funnel regression — evidence W0.2b-r1 stale-client-baseline]" else "" end)
        + (if $k == "db_not_in_s3" then " [DATA LOSS CLASS: DB row references a missing S3 object]" else "" end) ] as $alerts
  | [ $alertable[] as $k
      | select(($cur[$k] != null) and ($b[$k] != null) and ($cur[$k] < $b[$k]))
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
