-- V4-EVENTSOURCE-001 / 0br — DATA-ONLY rollback of 0b. Reverts the backfill WITHOUT dropping the
-- column, which is what you want if 0b classified something wrongly but 0a is fine. To remove the
-- column itself, use 0r-rollback.sql (dropping the column takes the backfill with it).
--
-- WHY A TIMESTAMP BOUND AND NOT `WHERE source IS NOT NULL`. Once the app_status writer
-- (lambda/plants, lambda/projects) and the lambda/events writers are deployed, live traffic writes
-- `source` on new rows. An unbounded reset would wipe THOSE too — legitimate, first-party
-- provenance that 0b never touched — and there would be no way to recover it. The bound below is
-- the max(created_at) measured on prod IMMEDIATELY BEFORE 0b ran, so this reverts exactly the rows
-- 0b could have reached and nothing newer.
--
-- MEASURED PRE-STATE, prod Neon, 2026-08-04 18:52:09Z, immediately before the 0b apply:
--   total rows                      12,100
--   rows with source IS NULL        12,100   (100% — the column had never been written)
--   max(created_at)                 2026-08-04 17:20:28.211257+00
--   created_by fingerprint          md5 = 053fbc2af55fc0329ade44f3409e0935
-- Because the pre-state was uniformly NULL, "restore the prior value" and "set NULL" are the same
-- operation for every row in the bound. A row-level snapshot (id, source, updated_at, created_at)
-- was also taken; if a future 0b re-run starts from a non-uniform pre-state, this file must be
-- regenerated from that snapshot instead of relying on the uniformity above.
--
-- NOT ROLLED BACK: set_updated_at bumped event_log.updated_at on the classified rows and there is
-- no pre-image in the DB to restore it from. Verified inert before the run — `rg -uuu` over
-- lambda/, src/ and scripts/ finds no comparison, filter, ORDER BY, or business read of
-- event_log.updated_at (the one hit, lambda/events/index.js PATCH, sets it and returns it).

BEGIN;

UPDATE public.event_log
   SET source = NULL
 WHERE source IS NOT NULL
   AND created_at <= '2026-08-04 17:20:28.211257+00'::timestamptz;

DELETE FROM public.schema_version
 WHERE version = '4.21.3-eventsource-001-backfill';

COMMIT;

-- Verify: expect 12100 / 12100 if this fully reverted a prod that has taken no new traffic.
--   SELECT count(*), count(*) FILTER (WHERE source IS NULL) FROM public.event_log
--    WHERE created_at <= '2026-08-04 17:20:28.211257+00'::timestamptz;
