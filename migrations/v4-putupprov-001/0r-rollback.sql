-- 0r-rollback.sql — V4-PUTUPPROV-001 rollback.
--
-- THIS FILE DELIBERATELY DOES NOT DROP THE COLUMNS. Read this before "completing" it.
--
-- The v4-putup-001 rollback pattern does NOT transfer here. That migration created two EMPTY tables,
-- so dropping them was lossless. This one ALTERs a POPULATED table, and
--   ALTER TABLE preservation_log DROP COLUMN source_kind, source_label
-- destroys every recorded provenance value — which IS the feature's entire payload. Every put-up
-- logged as "Warner Farms" or "u_pick / Clarkdale Fruit Farm" since the ship would be silently
-- reduced to an unattributed row, and nothing in the app could reconstruct it.
--
-- v4-putup-001/0r states the doctrine for this table family already: "prefer leaving the additive
-- [objects] in place (harmless) and rolling back the CODE instead." That applies with more force to
-- columns than it did to empty tables.
--
-- SO: the primary rollback lever for this feature is a CODE rollback. The columns are nullable with
-- no default and no non-NULL writes from an older bundle, so leaving them in place is inert — an
-- older Lambda simply never mentions them and an older frontend never renders them.
--
-- WHAT THIS FILE DOES: drops the five new CONSTRAINTS, restores the method CHECK to its pre-D6
-- 13-value form, and deletes the schema_version row — enough to un-gate the schema and let a
-- re-apply of 0a run clean, without touching a byte of user data.
--
-- Also used by the gates.yml step-2 rehearsal: run 0r on staging, re-apply 0a, re-run post gates.
-- That is what makes the rollback tested rather than asserted.
--
-- ⚠ THE DATA-DESTROYING STEP IS PROVIDED BELOW, COMMENTED OUT, AND IS VALID ONLY IN THE WINDOW
--   BEFORE THE FEATURE HAS BEEN USED ONCE (verify: SELECT count(*) FROM preservation_log
--   WHERE source_kind IS NOT NULL  → must be 0). Uncommenting it after that is deliberate data loss
--   and is a Dave-gated decision, not a cleanup step.

BEGIN;

ALTER TABLE public.preservation_log DROP CONSTRAINT IF EXISTS chk_preservation_log_source_kind;
ALTER TABLE public.preservation_log DROP CONSTRAINT IF EXISTS chk_preservation_log_source_other;
ALTER TABLE public.preservation_log DROP CONSTRAINT IF EXISTS chk_preservation_log_source_label_nonblank;
ALTER TABLE public.preservation_log DROP CONSTRAINT IF EXISTS chk_preservation_log_source_label_len;
ALTER TABLE public.preservation_log DROP CONSTRAINT IF EXISTS chk_preservation_log_source_plant;

-- Restore the pre-D6 method vocabulary (drops 'purchased_preserved').
-- NOTE: this FAILS if any row already uses purchased_preserved — correctly. Reassign those rows
-- first, or leave the widened CHECK in place (it is a superset and harms nothing).
ALTER TABLE public.preservation_log DROP CONSTRAINT IF EXISTS chk_preservation_log_method;
ALTER TABLE public.preservation_log ADD CONSTRAINT chk_preservation_log_method
  CHECK (method IN (
    'roast_freeze','whole_freeze','blanch_freeze','dehydrate','powder','passata',
    'can_water_bath','can_pressure','jam_preserve','ferment','cure_store','cold_store','other'
  ));

-- ⚠ DATA-DESTROYING — pre-first-use only. See header.
-- ALTER TABLE public.preservation_log DROP COLUMN IF EXISTS source_kind;
-- ALTER TABLE public.preservation_log DROP COLUMN IF EXISTS source_label;

DELETE FROM public.schema_version WHERE version = '4.15.0-putupprov-001';

COMMIT;
