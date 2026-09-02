-- 0r-rollback.sql
-- OPS-CUEINSTRUMENT-001 rollback. Rehearse on STAGING before applying 0a to prod.
--
-- The table is standalone: nothing references it and it has NO outbound FK at all (no plant_id — see
-- 0a's deviation notes), so the drop cannot cascade anywhere. No user-ENTERED data lives in it.
--
-- What it CAN destroy is unreconstructible. The cue is computed from a weather + hydrology snapshot
-- that the next nightly run overwrites in place (daily_plan upserts on (user_id, plan_date)), and
-- whether a cue was RENDERED depends on a client that leaves no other trace. There is no endpoint,
-- no backfill and no log that can regenerate which cue was on screen on a past day, in which form,
-- under which model_version. Every accumulated row is the only copy of itself — and this table
-- exists specifically because the last instrument of its kind was dropped and could not be rebuilt.
--
-- So: before dropping a table that has been accumulating, dump it. It is tiny (<=5 rows/user/day):
--
--   \copy public.weather_cue_impression TO 'weather_cue_impression-<date>.csv' CSV HEADER
--
-- After a rollback+reapply the CSV is the ONLY restore path (note: id is GENERATED ALWAYS — a
-- restore must either strip the id column or use OVERRIDING SYSTEM VALUE).

BEGIN;

DROP TABLE IF EXISTS public.weather_cue_impression;

COMMIT;
