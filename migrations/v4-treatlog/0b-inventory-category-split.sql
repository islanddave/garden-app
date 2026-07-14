-- V4-TREATLOG-001 — split nutrients_and_amendments → fertilizer + amendment.
-- BACKWARD-COMPATIBLE: new CHECK is a SUPERSET (keeps 'nutrients_and_amendments' valid) so the
-- currently-deployed prod app (old category list) keeps working until the new code promotes. The
-- deprecated value has zero rows after the reclassify below; drop it in a later tightening pass.
ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_category_check;
ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_category_check
  CHECK (category = ANY (ARRAY[
    'seeds','growing_media','lighting','shelving','tools','pest_control','containers',
    'climate_control','nutrients_and_amendments','fertilizer','amendment','other']));

-- Reclassify the 8 existing rows (NPK plant-foods → fertilizer; soil/mineral conditioners → amendment).
UPDATE inventory_items SET category='fertilizer', updated_at=now() WHERE id IN (
  '7019388e-0c48-4fd1-af12-b5a26929dbcd', -- Bloom City Seaweed & Kelp Fertilizer
  'df6e5880-8e8f-4396-9415-1d6a319ce250', -- Espoma Organic Tomato-Tone 3-4-6
  'a699b300-e5a2-4be9-9ccc-a8159aa5621d'  -- FoxFarm Grow Big 6-4-4
);
UPDATE inventory_items SET category='amendment', updated_at=now() WHERE id IN (
  '23fdbcb2-ce71-4102-b297-5730711fe94c', -- Brut Organic Worm Castings
  '8a38dea7-d791-421c-8f58-6ee3fe3c1d4d', -- Wiggle Worm Organic Worm Castings
  'b46f4852-c092-4d58-9424-0b6d2d2c3f89', -- Epsom Salt (Magnesium Sulfate)
  '29c2a148-a28d-489c-b43d-c16b74eb8efe', -- Gypsum Powder Calcium Sulfate
  '1c0c8a43-487b-454f-a370-b7d0aee1d852'  -- Xtreme Gardening Mykos Root Inoculant
);
