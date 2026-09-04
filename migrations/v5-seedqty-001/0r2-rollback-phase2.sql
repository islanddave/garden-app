-- v5-seedqty-001 / 0r2-rollback-phase2.sql — undoes 0b ONLY.
-- Run BEFORE 0r1. Rolling back 0a first would drop the columns this file reads from.
--
-- Restores quantity_on_hand from seed_count for exactly the rows 0b moved, and disarms the pairing
-- CHECK. Recovery is possible because 0b MOVED the value rather than recomputing it: seed_count
-- holds the original quantity_on_hand verbatim, so this is exact, not a reconstruction.
--
-- The target set is "rows 0b touched", identified as (seed_count IS NOT NULL AND
-- seed_count_estimated = false AND quantity_on_hand = 1). That is deliberately narrower than 0b's
-- own predicate: after the writing release ships, NEW lots also carry seed_count, and rolling their
-- counts back into quantity_on_hand would re-create the original bug on rows that never had it.
-- A lot the user has since edited to a different quantity_on_hand is likewise left alone.
--
-- LIMIT OF THIS ROLLBACK, stated rather than discovered later: it cannot distinguish a 0b-backfilled
-- row from a NEW saved lot that happens to sit at quantity_on_hand=1 with a counted seed_count —
-- which is every new lot. Run it only in the window before the writing release has created lots, or
-- restrict it to the six ids recorded in 0b's header.

BEGIN;

ALTER TABLE public.inventory_items
  DROP CONSTRAINT IF EXISTS chk_inventory_seed_count_basis_pairing;

UPDATE public.inventory_items
   SET quantity_on_hand     = seed_count,
       seed_count           = NULL,
       seed_count_estimated = NULL
 WHERE category = 'seeds'
   AND deleted_at IS NULL
   AND quantity_on_hand = 1
   AND seed_count IS NOT NULL
   AND seed_count_estimated = false
   AND seed_count > 5;   -- the 0b predicate, mirrored: only rows whose count was a >5 quantity

DELETE FROM public.schema_version WHERE version = '5.0.0-seedqty-001b';

COMMIT;
