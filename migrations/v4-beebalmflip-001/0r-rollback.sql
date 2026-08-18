-- 0r-rollback.sql — V4-BEEBALMFLIP-001 rollback.
--
-- Re-NULLs exactly the two cells 0a-data.sql sets, and ONLY where they still hold the value this
-- migration wrote. If Dave has since hand-corrected a value, the guard means this file leaves it
-- alone rather than destroying the correction — the same first-write-wins discipline as the
-- forward migration, inverted.
--
-- There is no DDL to undo: 0a is data-only, both columns predate it. Nothing here can strand a
-- view or a constraint.
--
-- SAFETY: idempotent. Re-running after a successful rollback matches 0 rows.
--
-- NOTE: this restores bee_balm to the pre-migration state, which per
-- src/data/harvest-attributes-v1.json's (pre-flip) not_harvest_tracked.contested.bee_balm note
-- was itself a deliberate, brief-authorized state (Left NULL per brief), not a defect — unlike
-- the v4-croptype-002 rollback note, rolling this migration back does not reintroduce a bug. It
-- does mean bee_balm silently drops back out of the Today "Ready to pick" band eligibility. If
-- this rollback is ever run, the JSON's by_crop_type.bee_balm entry and the
-- migrations/v4-harvattr-001/0b-data.sql seed row added alongside this migration should be
-- reverted in the same commit, or harvestAttributesSync.test.js will report a JSON/SQL mismatch
-- against a DB state that no longer matches either.

BEGIN;

UPDATE public.crop_types SET repeat_interval_days=NULL, updated_at=now()
 WHERE slug='bee_balm' AND deleted_at IS NULL AND repeat_interval_days=14 AND harvest_habit='cut_and_come_again';
UPDATE public.crop_types SET harvest_habit=NULL, updated_at=now()
 WHERE slug='bee_balm' AND deleted_at IS NULL AND harvest_habit='cut_and_come_again';

DELETE FROM public.schema_version WHERE version='4.34.0-beebalmflip-001';

COMMIT;
