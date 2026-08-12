-- 0c-validate.sql
-- V4-ANCHORBASE-001. Run AFTER 0a (checks 1-3, 5-6) and again after 0b (checks 4-7). Read-only.
-- Every row must report PASS. A FAIL on check 5 or 7 means the marking rule has been violated and
-- the backfill must be rolled back before anything reads it.

\echo '== 1. table exists =='
SELECT CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL' END AS result, count(*) AS found
  FROM information_schema.tables
 WHERE table_schema = 'public' AND table_name = 'plant_anchor_derivation';

\echo '== 2. every column the backfill and route use is present, with the expected type =='
WITH want(column_name, data_type) AS (VALUES
  ('id','uuid'), ('user_id','text'), ('plant_id','uuid'),
  ('anchor_date','date'), ('anchor_field','text'),
  ('source','text'), ('confidence','text'), ('model_version','text'),
  ('evidence_date','date'), ('offset_days','smallint'), ('offset_source','text'),
  ('offset_sample_n','smallint'), ('clamped_to_today','boolean'), ('derived_on','date'),
  ('created_at','timestamp with time zone'), ('updated_at','timestamp with time zone'),
  ('superseded_at','timestamp with time zone'), ('superseded_by','text')
)
SELECT CASE WHEN count(*) FILTER (WHERE c.column_name IS NULL OR c.data_type <> w.data_type) = 0
            THEN 'PASS' ELSE 'FAIL' END AS result,
       count(*) FILTER (WHERE c.column_name IS NULL) AS missing,
       count(*) FILTER (WHERE c.column_name IS NOT NULL AND c.data_type <> w.data_type) AS wrong_type
  FROM want w
  LEFT JOIN information_schema.columns c
         ON c.table_schema = 'public' AND c.table_name = 'plant_anchor_derivation'
        AND c.column_name = w.column_name;

\echo '== 3. constraints and indexes present =='
SELECT CASE WHEN count(*) = 4 THEN 'PASS' ELSE 'FAIL' END AS result, count(*) AS found
  FROM pg_constraint
 WHERE conrelid = 'public.plant_anchor_derivation'::regclass AND contype = 'c'
   AND conname IN ('plant_anchor_derivation_source_chk', 'plant_anchor_derivation_confidence_chk',
                   'plant_anchor_derivation_field_chk', 'plant_anchor_derivation_offset_chk');

SELECT CASE WHEN count(*) = 3 THEN 'PASS' ELSE 'FAIL' END AS result, count(*) AS found
  FROM pg_indexes
 WHERE schemaname = 'public' AND tablename = 'plant_anchor_derivation'
   AND indexname IN ('uq_plant_anchor_derivation_live', 'idx_plant_anchor_derivation_user_live',
                     'idx_plant_anchor_derivation_model_source');

\echo '== 4. tier census — POST-BACKFILL. Compare against the measurement before trusting it. =='
\echo '   Expected on prod 2026-08-12: 64 rows / sow 0 / transplant 0 / proxy 7 / baseline 57.'
SELECT source, confidence, count(*) AS rows,
       round(100.0 * count(*) / NULLIF(sum(count(*)) OVER (), 0), 1) AS pct
  FROM public.plant_anchor_derivation
 WHERE superseded_at IS NULL
 GROUP BY source, confidence
 ORDER BY rows DESC;

\echo '== 5. MARKING RULE — no live derivation for a planting that has an observed anchor =='
\echo '   A FAIL here means a derived date and an observed date coexist. Roll back.'
SELECT CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result, count(*) AS violations
  FROM public.plant_anchor_derivation d
  JOIN public.plants p ON p.id = d.plant_id
 WHERE d.superseded_at IS NULL
   AND (p.sown_at IS NOT NULL OR p.transplanted_at IS NOT NULL OR p.planted_out_at IS NOT NULL);

\echo '== 6. ADDITIVE-ONLY PROOF — public.plants was not written to =='
\echo '   updated_at on the anchorless set must predate the backfill. A FAIL means the backfill'
\echo '   fired plants triggers (set_updated_at / garden_node_bump) and touched user rows.'
SELECT CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result, count(*) AS touched_today
  FROM public.plants p
  JOIN public.plant_anchor_derivation d ON d.plant_id = p.id AND d.superseded_at IS NULL
 WHERE p.updated_at >= d.created_at;

\echo '== 7. no derived anchor in the future, and every clamp is flagged =='
SELECT CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result, count(*) AS future_anchors
  FROM public.plant_anchor_derivation
 WHERE superseded_at IS NULL AND anchor_date > (now() AT TIME ZONE 'America/New_York')::date;

SELECT CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result, count(*) AS unflagged_clamps
  FROM public.plant_anchor_derivation
 WHERE superseded_at IS NULL AND NOT clamped_to_today
   AND anchor_date <> (evidence_date + offset_days);

\echo '== 8. offset discipline — only the baseline tier carries one =='
SELECT CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS result, count(*) AS violations
  FROM public.plant_anchor_derivation
 WHERE source <> 'add_date_baseline' AND (offset_days <> 0 OR offset_source IS NOT NULL);
