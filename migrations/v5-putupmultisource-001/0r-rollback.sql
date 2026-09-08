-- 0r-rollback.sql — V5-PUTUPMULTISOURCE-001 rollback.
--
-- THIS ONE DOES DROP THE TABLE, and the reason it may is the reason v4-putupprov-001's rollback may
-- not. That migration ALTERs a POPULATED table, so dropping its columns destroys recorded provenance
-- with nothing left to reconstruct it from — its header says so at length and leaves the destructive
-- step commented out. This migration CREATES A NEW, EMPTY RELATION. Dropping it is the
-- v4-putup-001 case ("two empty tables, so dropping them was lossless"), not the v4-putupprov-001
-- case, and no pre-existing byte is touched.
--
-- ⚠ THE WINDOW. That is true only while the table is empty. VERIFY BEFORE RUNNING:
--
--     SELECT count(*) FROM public.preservation_source;   -- must be 0
--
-- Once Dave has recorded a single multi-source jar, this file becomes deliberate data loss and is a
-- Dave-gated decision, not a cleanup step. After that point the correct lever is a CODE ROLLBACK:
-- the table is referenced only by the /api/preservation/:id/sources routes, nothing else SELECTs it,
-- and every existing put-up surface reads the parent's own columns exactly as it did before this
-- change. An older Lambda simply never mentions the table, so leaving it in place is inert.
--
-- Also used by the gates.yml step-2 rehearsal: run 0r on staging, re-apply 0a, re-run post gates.
-- That is what makes the rollback tested rather than asserted.
--
-- No constraint or index is dropped by name: they belong to the table and go with it. Listing them
-- separately would be a second place to forget one.

BEGIN;

DROP TABLE IF EXISTS public.preservation_source;

DELETE FROM public.schema_version WHERE version = '5.0.0-putupmultisource-001';

COMMIT;
