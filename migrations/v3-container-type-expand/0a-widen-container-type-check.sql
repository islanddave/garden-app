-- v3-container-type-expand / 0a
-- Widen plants.chk_plants_container_type allowed-values list.
-- Context: bulk container/size/location backfill (2026-06-22) needed container
-- types the original CHECK didn't permit. Dave-approved adding: trough,
-- whiskey_barrel, soil_block, solo_cup. Purely additive (widens an allowed set;
-- every existing row already satisfies the narrower prior set).
--
-- APPLIED TO PROD Neon 2026-06-22 (direct ALTER, this file is the tracked record).
-- Staging/dev Neon branches: re-apply this file (or re-branch from prod) so the
-- constraint matches before any deploy that writes these values.
--
-- Prior allowed list: fabric_bag, plastic_pot, terracotta, ceramic, raised_bed,
--   in_ground, tray_cell, hanging_basket, window_box, other
-- New (this migration adds): trough, whiskey_barrel, soil_block, solo_cup

ALTER TABLE plants DROP CONSTRAINT IF EXISTS chk_plants_container_type;

ALTER TABLE plants ADD CONSTRAINT chk_plants_container_type
  CHECK (
    container_type IS NULL OR container_type = ANY (ARRAY[
      'fabric_bag'::text,
      'plastic_pot'::text,
      'terracotta'::text,
      'ceramic'::text,
      'raised_bed'::text,
      'in_ground'::text,
      'tray_cell'::text,
      'hanging_basket'::text,
      'window_box'::text,
      'trough'::text,
      'whiskey_barrel'::text,
      'soil_block'::text,
      'solo_cup'::text,
      'other'::text
    ])
  );
