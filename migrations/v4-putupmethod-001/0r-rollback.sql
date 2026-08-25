-- 0r-rollback.sql — V4-PUTUPTAXONOMY-001 rollback: narrow the method vocab back to 14.
--
-- A NARROWING IS NOT THE MIRROR OF A WIDENING. The forward migration is born valid because every
-- existing row already satisfies the wider constraint; this one is NOT, because by the time anyone
-- rolls back, Dave may have logged a pesto. ADD CONSTRAINT validates against every existing row and
-- raises 23514 if one fails — so the rollback would abort, which is the CORRECT outcome (silently
-- dropping his records to restore a constraint would be worse) but is a hard stop, not a no-op.
--
-- So this file REFUSES rather than destroys, and says which rows are in the way. Run the SELECT
-- first: if it returns anything, decide what those rows should become BEFORE rolling back. There is
-- no honest automatic answer — pesto is not passata (that mis-filing is the defect BD-034 exists to
-- fix) and re-filing it as 'other' would need a method_other_text this file cannot invent.
--
--   SELECT id, method, preserved_at, quantity_value, quantity_unit
--     FROM public.preservation_log
--    WHERE method IN ('quick_pickle','pesto','hot_sauce','ferment_mash');
--
-- If that returns zero rows the transaction below is safe and complete. If it returns rows, the
-- ALTER will fail the whole transaction and nothing is lost.

BEGIN;

ALTER TABLE public.preservation_log DROP CONSTRAINT IF EXISTS chk_preservation_log_method;
ALTER TABLE public.preservation_log ADD CONSTRAINT chk_preservation_log_method
  CHECK (method IN (
    'roast_freeze','whole_freeze','blanch_freeze','dehydrate','powder','passata',
    'can_water_bath','can_pressure','jam_preserve','ferment','cure_store','cold_store',
    'purchased_preserved','other'
  ));

DELETE FROM public.schema_version WHERE version = '4.40.0-putupmethod-001';

COMMIT;
