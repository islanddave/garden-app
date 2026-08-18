-- Rollback for 0a-data-fix.sql (V4-VARIETYDUP-001 + V4-CWARCHIVE-001).
-- Reverses exactly the rows 0a touched, by explicit id — never a blanket
-- "everything currently pointing at the survivor" undo, which would also catch rows that pointed
-- at the survivor before this migration ran.
--
-- TRANSACTIONAL, and it removes 0a's schema_version receipt. Removing the receipt is not
-- bookkeeping: every post gate in gates.yml self-arms on
-- `EXISTS (... schema_version WHERE version='4.36.0-varietydedup-001')`, so deleting the row
-- disarms them back to vacuously-green instead of leaving the invariant sweep permanently red
-- against a state that was deliberately rolled back.
--
-- SCOPE BOUND — READ BEFORE RUNNING. 0a repoints BY RELATION (every planting on the loser); this
-- file repoints back BY LITERAL, one plants.id. Those agree only while exactly one planting moves,
-- which is precisely what pre_no_other_planting_on_alaska_loser asserts before 0a is allowed to
-- run. If that pre-gate ever fires and someone applies 0a anyway, this rollback is INCOMPLETE —
-- extend it (or add the snap_ ledger pattern from v4-croptypealoe-001/0b-data.sql) first.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

-- Alaska Mix: restore the loser, repoint its one planting back.
UPDATE public.plant_varieties
   SET deleted_at = NULL
 WHERE id = 'f2c6edd8-7b8f-4bd2-a443-a7e1070fa6d7'
   AND deleted_at IS NOT NULL;

UPDATE public.plants
   SET variety_id = 'f2c6edd8-7b8f-4bd2-a443-a7e1070fa6d7', updated_at = now()
 WHERE id = '7ea304c4-5ae5-4408-94e5-546d706e3392'
   AND variety_id = 'a11dd600-84b4-4bd6-8611-f85336bc3c2e';

-- California Wonder family: restore the three archived rows. 'Emerald Green' (7a6ab71f) was never
-- touched by 0a, so there is nothing to reverse for it.
UPDATE public.plant_varieties
   SET deleted_at = NULL
 WHERE id IN (
   '960c10f5-80e9-4a92-8e8c-da70f54c89f0',
   '750c8334-1aaa-493b-bcef-02d7a9378a39',
   '1eff5046-f6a1-4f5d-82df-85a35e890849'
 )
   AND deleted_at IS NOT NULL;

-- Drop 0a's receipt. DELETE rather than a '-rollback' marker row (both idioms exist in this repo:
-- v4-acqmature-001/0r-rollback.sql:85 deletes, v4-rapinidtm-001 inserts) because here the receipt is
-- load-bearing, not decorative — the post gates key their EXISTS off this exact version string, so
-- leaving it behind would keep them armed against a state that no longer exists.
DELETE FROM public.schema_version WHERE version = '4.36.0-varietydedup-001';

COMMIT;

-- Verify:
-- SELECT id, name, deleted_at FROM plant_varieties
--  WHERE id IN ('f2c6edd8-7b8f-4bd2-a443-a7e1070fa6d7','960c10f5-80e9-4a92-8e8c-da70f54c89f0',
--               '750c8334-1aaa-493b-bcef-02d7a9378a39','1eff5046-f6a1-4f5d-82df-85a35e890849');
-- SELECT id, variety_id FROM plants WHERE id = '7ea304c4-5ae5-4408-94e5-546d706e3392';
