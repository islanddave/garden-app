-- V4-POT-001 S1 — container_type enum constraint on plants
-- Date: 2026-06-18
-- Scope: ADD COLUMN IF NOT EXISTS for container_type/container_size (safety — columns exist
--        on prod and test DBs but have no migration trail). Add CHECK constraint NOT VALID so
--        the lambda validation (ALLOWED_CONTAINER) and the DB agree. validate in 0c.
--
-- Enum mirrors dropdownRegistry.js PLANT_CONTAINER_TYPE_OPTIONS and
-- lambda/plants/index.js ALLOWED_CONTAINER (both added in PLANT-CONTAINER-001 commit).
-- Values: fabric_bag, plastic_pot, terracotta, ceramic, raised_bed, in_ground,
--         tray_cell, hanging_basket, window_box, other.
--
-- Safe additive: ADD COLUMN is idempotent via IF NOT EXISTS; constraint is NOT VALID so
-- existing rows are not scanned here (scan deferred to 0c after sweep).

BEGIN;

ALTER TABLE public.plants
  ADD COLUMN IF NOT EXISTS container_type TEXT NULL,
  ADD COLUMN IF NOT EXISTS container_size TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_plants_container_type'
  ) THEN
    ALTER TABLE public.plants
      ADD CONSTRAINT chk_plants_container_type
      CHECK (container_type IS NULL OR container_type = ANY (ARRAY[
        'fabric_bag','plastic_pot','terracotta','ceramic',
        'raised_bed','in_ground','tray_cell','hanging_basket',
        'window_box','other'
      ])) NOT VALID;
  END IF;
END$$;

INSERT INTO public.schema_version (version, applied_at, notes)
VALUES ('4.0.0-pot-001', now(), 'V4-POT-001 S1: container_type/size column safety + CHECK constraint NOT VALID')
ON CONFLICT (version) DO NOTHING;

COMMIT;
