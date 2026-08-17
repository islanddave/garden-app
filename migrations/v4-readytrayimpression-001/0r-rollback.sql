-- 0r-rollback.sql
-- V4-READYTRAYIMPRESSION-001 rollback. Rehearse on STAGING before applying 0a to prod.
--
-- The table is standalone: nothing references it, its only outbound FK is to public.plants, and no
-- user-ENTERED data lives in it — the drop cannot cascade into anything a person typed.
--
-- What it CAN destroy is unreconstructible, and more completely than watch_impression's: that table
-- at least records a server-ranked list, whereas the tray's contents are a CLIENT-side merge of a
-- readiness ranking and a recency fallback, capped and collapsed against a viewport. Nothing on the
-- server ever knew what was on the screen. There is no endpoint, no backfill and no log that can
-- regenerate which plantings were shown on a past day, in which region, at which slot, under which
-- model_version. Every accumulated row is the only copy of itself.
--
-- So: before dropping a table that has been accumulating, dump it. It is small (<=28 rows/user/day):
--
--   \copy public.ready_impression TO 'ready_impression-<date>.csv' CSV HEADER
--
-- After a rollback+reapply the CSV is the ONLY restore path (note: id is GENERATED ALWAYS — a
-- restore must either strip the id column or use OVERRIDING SYSTEM VALUE).

BEGIN;

DROP TABLE IF EXISTS public.ready_impression;

COMMIT;
