-- 0r-rollback.sql — V5-PUTUPCANDY-001 rollback: narrow the method vocab back to 18.
--
-- A NARROWING IS NOT THE MIRROR OF A WIDENING, and this file inherits that whole argument from
-- v4-putupmethod-001/0r-rollback.sql verbatim in shape. The forward migration is born valid because
-- every existing row already satisfies the wider constraint. This one is NOT: by the time anyone
-- rolls back, a candied batch may have been logged. ADD CONSTRAINT validates against every existing
-- row and raises 23514 if one fails, so the rollback ABORTS — which is the CORRECT outcome (silently
-- rewriting Dave's records to restore a constraint would be far worse) but is a hard stop, not a
-- no-op.
--
-- So this file REFUSES rather than destroys. Run the SELECT first; if it returns anything, decide
-- what those rows should become BEFORE rolling back. There is no honest automatic answer —
-- re-filing candy as 'dehydrate' would be wrong twice over (different process, and its shelf life is
-- 12 months against candy's weeks, so use-soon would then under-report by an order of magnitude),
-- and re-filing it as 'other' needs a method_other_text this file cannot invent.
--
--   SELECT id, method, preserved_at, quantity_value, quantity_unit, use_by_target
--     FROM public.preservation_log
--    WHERE method = 'candy';
--
-- If that returns zero rows the transaction below is safe and complete. If it returns rows, the
-- ALTER fails the whole transaction and nothing is lost.
--
-- ⚠ ORDERING, and it is the inverse of the apply. Roll the CODE back FIRST. This narrowing must not
-- precede its writer: while a bundle offering the candy option is still deployed, a save that picks
-- it 23514s and surfaces as an unexplainable failure. That is the same asymmetry the apply header
-- states, read from the other end.
--
-- The 18 values below must be EXACTLY the pre-existing vocabulary — narrower and the rollback
-- destroys a value this migration never added; wider and it fails to roll anything back.
-- src/__tests__/putUpMethodParity.test.js asserts that relationship for v4-putupmethod-001's pair
-- and must be extended to this one (see ../v5-preservunit-001/CODE-CHANGES-vocabmig-20260904.md §2).

BEGIN;

ALTER TABLE public.preservation_log DROP CONSTRAINT IF EXISTS chk_preservation_log_method;
ALTER TABLE public.preservation_log ADD CONSTRAINT chk_preservation_log_method
  CHECK (method IN (
    'roast_freeze','whole_freeze','blanch_freeze','dehydrate','powder','passata',
    'can_water_bath','can_pressure','jam_preserve','ferment','cure_store','cold_store',
    'purchased_preserved','quick_pickle','pesto','hot_sauce','ferment_mash','other'
  ));

DELETE FROM public.schema_version WHERE version = '5.0.0-putupcandy-20260904';

COMMIT;

-- Verify:
--   SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
--     JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
--    WHERE n.nspname='public' AND t.relname='preservation_log'
--      AND c.conname='chk_preservation_log_method';   -- expect 18 values, no 'candy'
--   SELECT count(*) FROM public.schema_version
--    WHERE version='5.0.0-putupcandy-20260904';       -- expect 0
