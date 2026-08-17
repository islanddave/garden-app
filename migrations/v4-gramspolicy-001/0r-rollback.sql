-- 0r-rollback.sql
-- V4-GRAMSPOLICY-001 rollback — restore crop_types.variety_grams_required to the EXACT per-crop
-- values 0a captured, not a blanket reset.
--
-- WHY EXACT MATTERS HERE. Seven crop types already carried variety_grams_required = false before this
-- migration existed (basil, blueberry, broccoli, bunching_onion, lettuce, red_raspberry, wineberry —
-- prod, 2026-08-16). None of them is nominated by 0a, so none is in the snapshot and none is touched
-- either way. But 0a's nomination list is data, and a future edit could add a slug that is already
-- false; a blanket `SET variety_grams_required = true WHERE slug IN (...)` would then silently
-- re-ARM a crop this migration never disarmed. Restoring from the snapshot cannot do that: it writes
-- back precisely what was read, per slug.
--
-- The snapshot is also why a partial apply rolls back cleanly. On staging 0a flips 2 of the 4
-- nominated crops and withholds `squash`; the snapshot still captured all four prior values, so this
-- file restores `squash` to the true it never left. That is a no-op UPDATE, by design.
--
-- SAFETY: one boolean column, at most 4 rows, no DDL on an existing object, no harvest_log row, no
-- Lambda deploy. It does NOT rewrite any stored weight — 0a did not write one either (verified:
-- 0 rows re-priced over the ratchet's 368-row scope), so there is nothing to un-derive. If a
-- harvest-weight-ratchet.sh run happened BETWEEN 0a and this rollback, that run has its own
-- harvest_log_weight_snapshot_* table and must be undone separately, with its own undo statement;
-- this file deliberately does not reach into harvest_log.
--
-- The snapshot table is DROPPED at the end so a re-apply of 0a captures fresh prior state rather than
-- resurrecting a stale capture. Drop last, inside the same transaction, so a failed restore leaves
-- the evidence in place.

\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'crop_types_vgr_snapshot_gramspolicy_001'
       AND c.relkind = 'r'
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'REFUSING TO ROLL BACK V4-GRAMSPOLICY-001: public.crop_types_vgr_snapshot_gramspolicy_001 is absent.',
      HINT    = 'The snapshot is the only record of the prior per-crop values. Without it a rollback can only guess, and guessing would re-arm a crop that was already false. If 0a never ran on this database there is nothing to roll back.';
  END IF;
END $$;

UPDATE public.crop_types ct
   SET variety_grams_required = s.prior_value,
       updated_at             = now()
  FROM public.crop_types_vgr_snapshot_gramspolicy_001 s
 WHERE s.slug = ct.slug
   AND ct.variety_grams_required IS DISTINCT FROM s.prior_value;

DELETE FROM public.schema_version WHERE version = '4.23.17-gramspolicy-001';

DROP TABLE public.crop_types_vgr_snapshot_gramspolicy_001;

COMMIT;
