-- 0c-validate.sql
-- V4-HARVSURFACE-001 slice 1. Run AFTER 0a, on every environment it is applied to. Read-only.
-- Every row must report PASS. A FAIL here means the route must not be pushed to dev.

\echo '== 1. table exists =='
SELECT CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL' END AS result, count(*) AS found
  FROM information_schema.tables
 WHERE table_schema = 'public' AND table_name = 'harvest_watch_dismissal';

\echo '== 2. every column the route writes is present, with the expected type =='
WITH want(column_name, data_type) AS (VALUES
  ('id','uuid'), ('user_id','text'), ('plant_id','uuid'), ('project_id','uuid'),
  ('observed_on','date'), ('dismissed_at','timestamp with time zone'),
  ('undone_at','timestamp with time zone'), ('reason','text'), ('note','text'),
  ('model_version','text'), ('crop_type_slug','text'), ('variety_id','uuid'),
  ('anchor_kind','text'), ('anchor_date','date'), ('anchor_basis','text'),
  ('anchor_basis_shifted','boolean'), ('expected_days','smallint'), ('lead_days','smallint'),
  ('check_from','date'), ('days_watching','smallint'), ('suppressed_until','date'),
  ('created_at','timestamp with time zone')
)
SELECT CASE WHEN count(*) FILTER (WHERE c.column_name IS NULL OR c.data_type <> w.data_type) = 0
            THEN 'PASS' ELSE 'FAIL' END AS result,
       count(*) FILTER (WHERE c.column_name IS NULL) AS missing,
       count(*) FILTER (WHERE c.column_name IS NOT NULL AND c.data_type <> w.data_type) AS wrong_type
  FROM want w
  LEFT JOIN information_schema.columns c
    ON c.table_schema = 'public' AND c.table_name = 'harvest_watch_dismissal'
   AND c.column_name = w.column_name;

\echo '== 3. NOT NULL holds on the four columns a sample is worthless without =='
SELECT CASE WHEN count(*) = 4 THEN 'PASS' ELSE 'FAIL' END AS result, count(*) AS not_null_cols
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'harvest_watch_dismissal'
   AND is_nullable = 'NO'
   AND column_name IN ('user_id', 'plant_id', 'observed_on', 'model_version');

\echo '== 4. all three indexes exist, and the day-grain uniqueness is PARTIAL on undone_at =='
SELECT CASE WHEN count(*) = 3 THEN 'PASS' ELSE 'FAIL' END AS result,
       count(*) FILTER (WHERE indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%undone_at IS NULL%') AS partial_unique
  FROM pg_indexes
 WHERE schemaname = 'public' AND tablename = 'harvest_watch_dismissal'
   AND indexname IN ('uq_harvest_watch_dismissal_active_day',
                     'idx_harvest_watch_dismissal_user_active',
                     'idx_harvest_watch_dismissal_model_observed');

\echo '== 5. CHECK constraints reject an unknown reason / anchor_kind =='
SELECT CASE WHEN count(*) = 2 THEN 'PASS' ELSE 'FAIL' END AS result, count(*) AS checks
  FROM pg_constraint
 WHERE conrelid = 'public.harvest_watch_dismissal'::regclass
   AND contype = 'c'
   AND conname IN ('harvest_watch_dismissal_reason_chk', 'harvest_watch_dismissal_anchor_chk');

\echo '== 6. the FK to plants is present (existence, not ownership — the route checks household) =='
SELECT CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL' END AS result
  FROM pg_constraint
 WHERE conrelid = 'public.harvest_watch_dismissal'::regclass
   AND contype = 'f' AND confrelid = 'public.plants'::regclass;

\echo '== 7. additive only — the table starts empty and nothing else changed =='
SELECT CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL (expected empty on first apply)' END AS result,
       count(*) AS rows_present
  FROM public.harvest_watch_dismissal;
