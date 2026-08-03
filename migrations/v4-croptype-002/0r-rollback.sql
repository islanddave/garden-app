-- 0r-rollback.sql — V4-CROPTYPE-002 rollback.
--
-- Re-NULLs exactly the cells 0a-data.sql sets, and ONLY where they still hold the value this
-- migration wrote. If Dave has since hand-corrected a value, the guard means this file leaves it
-- alone rather than destroying the correction — the same first-write-wins discipline as the
-- forward migration, inverted.
--
-- There is no DDL to undo: 0a is data-only, every column predates it. Nothing here can strand a
-- view or a constraint.
--
-- SAFETY: idempotent. Re-running after a successful rollback matches 0 rows.
--
-- NOTE: this restores the pre-migration state, which is the DEFECTIVE state — a planted crop type
-- with NULL harvest_habit is silently absent from "Ready to pick", and NULL first_year_harvest
-- gives a wrong sow-window close date. Roll back to unblock, then fix forward.

BEGIN;

-- 1. harvest_habit + repeat_interval_days (4 rows).
--    Interval is cleared BEFORE habit on the c&c row is irrelevant here (no ordering dependency:
--    chk_crop_types_repeat_interval only forbids 'single' + a non-NULL interval, and clearing
--    either side can never create that combination).
UPDATE public.crop_types SET repeat_interval_days=NULL, updated_at=now()
 WHERE slug='blackberry' AND deleted_at IS NULL AND repeat_interval_days=2 AND harvest_habit='repeat';
UPDATE public.crop_types SET harvest_habit=NULL, updated_at=now()
 WHERE slug='blackberry' AND deleted_at IS NULL AND harvest_habit='repeat';

UPDATE public.crop_types SET harvest_habit=NULL, updated_at=now()
 WHERE slug='carrot' AND deleted_at IS NULL AND harvest_habit='single';

UPDATE public.crop_types SET repeat_interval_days=NULL, updated_at=now()
 WHERE slug='spinach' AND deleted_at IS NULL AND repeat_interval_days=10;
UPDATE public.crop_types SET harvest_habit=NULL, updated_at=now()
 WHERE slug='spinach' AND deleted_at IS NULL AND harvest_habit='cut_and_come_again';

UPDATE public.crop_types SET harvest_habit=NULL, updated_at=now()
 WHERE slug='luffa' AND deleted_at IS NULL AND harvest_habit='single';

-- 2. first_year_harvest (21 rows: 19 true + 2 false).
UPDATE public.crop_types SET first_year_harvest=NULL, updated_at=now()
 WHERE deleted_at IS NULL AND first_year_harvest=true AND slug IN (
   'arugula','basil','bean','bitter_melon','cilantro','cucamelon','cucumber','dill','endive',
   'lettuce','luffa','melon','nasturtium','okra','potato','spinach','squash','tomatillo','watermelon'
 );

UPDATE public.crop_types SET first_year_harvest=NULL, updated_at=now()
 WHERE deleted_at IS NULL AND first_year_harvest=false AND slug IN ('bay','rosemary');

-- NOT touched by rollback (never written by 0a): garlic, shallot, lemon_verbena first_year_harvest;
-- blackberry/carrot first_year_harvest (pre-existing from v4-sowfirstyear-001); squash harvest_habit.

DELETE FROM public.schema_version WHERE version='4.17.0-croptype-002';

COMMIT;
