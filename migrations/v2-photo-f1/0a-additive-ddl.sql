-- 0a-additive-ddl.sql
-- V2-PHOTO-F1 Session 1 — featured_photo_id column on featurable entities
-- Spec: v2-photo-audit-20260513.md (drift finding: no cover/hero photo concept)
-- Decision (Dave, 2026-05-13):
--   * Add featured_photo_id to projects/plants/locations/inventory_items
--   * Varieties EXCLUDED from F1
--   * Nullable, ON DELETE SET NULL (deletes don't cascade to entity rows)
--   * Auto-promote: first upload to a parent with NULL featured_photo_id promotes itself (Lambda-side)
--   * PATCH validation strict: featured_photo_id must already be linked (Lambda-side)
--
-- L-058 sweep status: NOT REQUIRED.
--   The column is nullable with no CHECK constraint requiring NOT NULL.
--   No NOT VALID constraint exists. VALIDATE step is not run.
--   gates.yml sweep section is empty and documents this rationale.
--
-- Safety: All DDL is IF NOT EXISTS / DROP-and-recreate idempotent.
-- Re-running this script on a partially-applied env is a no-op.

-- ============================================================
-- 1. plant_projects.featured_photo_id
-- ============================================================
ALTER TABLE public.plant_projects
  ADD COLUMN IF NOT EXISTS featured_photo_id UUID
    REFERENCES public.photos(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_plant_projects_featured_photo
  ON public.plant_projects(featured_photo_id)
  WHERE featured_photo_id IS NOT NULL;

-- ============================================================
-- 2. plants.featured_photo_id
-- ============================================================
ALTER TABLE public.plants
  ADD COLUMN IF NOT EXISTS featured_photo_id UUID
    REFERENCES public.photos(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_plants_featured_photo
  ON public.plants(featured_photo_id)
  WHERE featured_photo_id IS NOT NULL;

-- ============================================================
-- 3. locations.featured_photo_id
-- ============================================================
ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS featured_photo_id UUID
    REFERENCES public.photos(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_locations_featured_photo
  ON public.locations(featured_photo_id)
  WHERE featured_photo_id IS NOT NULL;

-- ============================================================
-- 4. inventory_items.featured_photo_id
-- NOTE: inventory_items already has a `featured_image_id` column from V1
--   (legacy concept tied to image_url). This new column is the V2 unified
--   featured-photo pointer that links to photos.id. We do NOT drop or
--   rename featured_image_id in this migration (per Migration Authoring Rule,
--   destructive DDL ships after code is live). Session 2/3 can collapse them.
-- ============================================================
ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS featured_photo_id UUID
    REFERENCES public.photos(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_inventory_items_featured_photo
  ON public.inventory_items(featured_photo_id)
  WHERE featured_photo_id IS NOT NULL;

-- ============================================================
-- 5. photos.inventory_item_id
-- Gap discovered during Session 1 lambda implementation: photos table tags
-- by project/event/location/plant but had no inventory_item link, so the
-- inventory-items featured_photo auto-promote + strict-validate flow had
-- no linkage column to check against. Adding here keeps Session 1 self-
-- contained. ON DELETE CASCADE matches the spirit of the other photo links
-- (a deleted inventory item nukes its photos; soft-delete is the normal path).
-- ============================================================
ALTER TABLE public.photos
  ADD COLUMN IF NOT EXISTS inventory_item_id UUID
    REFERENCES public.inventory_items(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_photos_inventory_item
  ON public.photos(inventory_item_id)
  WHERE inventory_item_id IS NOT NULL;

-- ============================================================
-- 5. Schema version record
-- ============================================================
INSERT INTO public.schema_version (version, description)
VALUES ('2.1.0a', 'V2-PHOTO-F1 Session 1: featured_photo_id on projects/plants/locations/inventory_items (nullable, ON DELETE SET NULL) + photos.inventory_item_id (ON DELETE CASCADE) + partial indexes')
ON CONFLICT (version) DO NOTHING;
