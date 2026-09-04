-- V5-PHRECORD-001 — ROLLBACK. Returns kitchen_stage_log and v_kitchen_batch_current to their
-- V5-INFLIGHTBATCH-001 shape.
--
-- ⚠ DESTRUCTIVE OF DATA, unlike the forward migration. Dropping ph_reading / ph_read_at discards
-- every reading anyone recorded. That is unavoidable — the columns are the only home for the value —
-- so if any row carries one, EXPORT FIRST:
--   SELECT batch_id, id, ph_reading, ph_read_at, entered_at FROM public.kitchen_stage_log
--    WHERE ph_reading IS NOT NULL ORDER BY batch_id, ph_read_at;
-- Rehearse this file on staging before the prod apply, per the sequencing in gates.yml.
--
-- ORDER IS FORCED, and it is not the reverse of 0a. The view depends on both columns, so the columns
-- cannot be dropped while it stands. DROP VIEW first, then the constraints and index, then the
-- columns, then re-create the view at its original definition.
--
-- DROP + CREATE, NOT CREATE OR REPLACE, and only here: CREATE OR REPLACE VIEW can APPEND columns but
-- can never REMOVE them, so the two appended columns cannot be un-appended in place. Plain DROP VIEW
-- without CASCADE on purpose — if some later object came to depend on this view, this file must fail
-- loudly rather than quietly take that object with it.
--
-- THE GRANT, and the one asymmetry this file cannot make exact. CREATE OR REPLACE preserved the
-- view's ACL on the way in; DROP + CREATE cannot, so the grant is re-issued below, guarded on the
-- role existing (garden_ro is PROD-ONLY — a bare GRANT aborts the whole transaction on staging with
-- 42704). If the view happened to carry no garden_ro grant beforehand this restores a superset by one
-- SELECT on a view over base tables that role can already read, which is not an escalation; the
-- opposite error — leaving a read-only role blind to a view it could read an hour ago — is the
-- failure v4-roschemaversion-001 was written about, and it surfaces as "there are no batches" rather
-- than as a permission error.

BEGIN;

-- ── 1. the view, out of the way ──────────────────────────────────────────────────────────────────
DROP VIEW public.v_kitchen_batch_current;

-- ── 2. constraints and index ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.kitchen_stage_log DROP CONSTRAINT IF EXISTS chk_ksl_ph_pairing;
ALTER TABLE public.kitchen_stage_log DROP CONSTRAINT IF EXISTS chk_ksl_ph_scale;
DROP INDEX IF EXISTS public.idx_ksl_ph;

-- ── 3. the columns, and every reading in them ────────────────────────────────────────────────────
ALTER TABLE public.kitchen_stage_log
  DROP COLUMN IF EXISTS ph_reading,
  DROP COLUMN IF EXISTS ph_read_at;

-- ── 4. the view, at its V5-INFLIGHTBATCH-001 definition ──────────────────────────────────────────
-- Byte-identical to migrations/v5-inflightbatch-001/0a-additive-ddl.sql §5. Copied rather than
-- referenced because a rollback that reads another file's state is not a rollback.
CREATE VIEW public.v_kitchen_batch_current AS
SELECT b.*,
       s.stage_kind          AS current_stage_kind,
       s.label               AS current_stage_label,
       s.entered_at          AS current_stage_entered_at,
       s.storage_location_id AS current_storage_location_id,
       (SELECT count(*) FROM public.kitchen_batch_input i WHERE i.batch_id = b.id)  AS input_count,
       (SELECT count(*) FROM public.preservation_log p
         WHERE p.batch_id = b.id AND p.deleted_at IS NULL)                          AS output_count
  FROM public.kitchen_batch b
  LEFT JOIN LATERAL (
       SELECT sl.stage_kind, sl.label, sl.entered_at, sl.storage_location_id
         FROM public.kitchen_stage_log sl
        WHERE sl.batch_id = b.id
        ORDER BY sl.entered_at DESC, sl.id DESC
        LIMIT 1
  ) s ON TRUE
 WHERE b.deleted_at IS NULL;

-- ── 5. the grant — prod only, guarded (see THE GRANT in the header) ──────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'garden_ro') THEN
    GRANT SELECT ON public.v_kitchen_batch_current TO garden_ro;
    RAISE NOTICE 'garden_ro exists — SELECT re-granted on v_kitchen_batch_current (prod shape)';
  ELSE
    RAISE NOTICE 'garden_ro does not exist here — grant skipped (staging shape, correct)';
  END IF;
END $$;

-- ── 6. the ledger row ────────────────────────────────────────────────────────────────────────────
-- Deleted, not marked: every post gate in gates.yml self-arms on this row, so leaving it behind would
-- keep a set of assertions live against a schema that no longer has the columns they assert.
DELETE FROM public.schema_version WHERE version = '5.0.0-phrecord-20260904';

COMMIT;

-- Verify:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='kitchen_stage_log' AND column_name LIKE 'ph_%';
--     -> 0 rows
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='v_kitchen_batch_current' AND column_name LIKE 'last_ph%';
--     -> 0 rows
--   SELECT count(*) FROM public.v_kitchen_batch_current;
--   SELECT 1 FROM public.schema_version WHERE version = '5.0.0-phrecord-20260904';  -> 0 rows
