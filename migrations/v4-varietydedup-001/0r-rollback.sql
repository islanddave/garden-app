-- Rollback for 0a-data-fix.sql (V4-VARIETYDUP-001 + V4-CWARCHIVE-001).
-- Reverses exactly the rows 0a touched, by explicit id — never a blanket
-- "everything currently pointing at the survivor" undo, which would also catch rows that pointed
-- at the survivor before this migration ran. Safe to run even if 0a was only partially applied
-- (each statement is independently guarded).

-- Alaska Mix: restore the loser, repoint its one planting back.
UPDATE plant_varieties
   SET deleted_at = NULL
 WHERE id = 'f2c6edd8-7b8f-4bd2-a443-a7e1070fa6d7'
   AND deleted_at IS NOT NULL;

UPDATE plants
   SET variety_id = 'f2c6edd8-7b8f-4bd2-a443-a7e1070fa6d7', updated_at = now()
 WHERE id = '7ea304c4-5ae5-4408-94e5-546d706e3392'
   AND variety_id = 'a11dd600-84b4-4bd6-8611-f85336bc3c2e';

-- California Wonder family: restore the three archived rows. 'Emerald Green' (7a6ab71f) was never
-- touched by 0a, so there is nothing to reverse for it.
UPDATE plant_varieties
   SET deleted_at = NULL
 WHERE id IN (
   '960c10f5-80e9-4a92-8e8c-da70f54c89f0',
   '750c8334-1aaa-493b-bcef-02d7a9378a39',
   '1eff5046-f6a1-4f5d-82df-85a35e890849'
 )
   AND deleted_at IS NOT NULL;

-- Verify:
-- SELECT id, name, deleted_at FROM plant_varieties
--  WHERE id IN ('f2c6edd8-7b8f-4bd2-a443-a7e1070fa6d7','960c10f5-80e9-4a92-8e8c-da70f54c89f0',
--               '750c8334-1aaa-493b-bcef-02d7a9378a39','1eff5046-f6a1-4f5d-82df-85a35e890849');
-- SELECT id, variety_id FROM plants WHERE id = '7ea304c4-5ae5-4408-94e5-546d706e3392';
