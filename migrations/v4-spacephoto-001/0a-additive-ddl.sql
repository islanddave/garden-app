-- 0a-additive-ddl.sql
-- V4-SPACEPHOTO-001 — give the Space tier a photo arm.
--
-- Adds photos.space_id (the attach target) and spaces.featured_photo_id (the hero pointer),
-- and widens photos_must_have_parent so a space-only photo is legal.
--
-- ORDERING (binding, gardening-deploy.md §Migration Authoring): this DDL MUST be applied
--   BEFORE the code that references these columns is promoted. Code-first would 500 every
--   photos request against a prod DB that lacks space_id.
--
-- PREREQ ALREADY MET: migrations/v4-spaceowner backfilled spaces.created_by in prod
--   (0 NULL owners). loadOwnedSpace() gates space writes on created_by = ANY(householdIds)
--   and rejects a NULL-owner row, so without that backfill this feature is dead on arrival.
--   NOTE staging has NOT had v4-spaceowner applied as of 2026-07-31 — apply it there first.
--
-- LIVE SHAPE VERIFIED 2026-07-31 against prod Neon (and staging, byte-identical constraint):
--   photos_must_have_parent :: CHECK ((event_id IS NOT NULL) OR (project_id IS NOT NULL)
--     OR (location_id IS NOT NULL) OR (plant_id IS NOT NULL) OR (inventory_item_id IS NOT NULL)
--     OR COALESCE((intake_status = 'pending_tag'::text), false))
--   spaces columns: id, name NOT NULL, created_by, created_at, updated_at,
--     postal_code, weather_lat, weather_lng   -- NO deleted_at column (see below)
--   photos rowcount: 977
--
-- CONSTRAINT SWAP ORDER — ADD NOT VALID → VALIDATE → DROP old (0c), never drop-then-add.
--   Dropping first opens a window with NO parent constraint on a hot, actively-written table.
--   ADD ... NOT VALID takes no full-table scan and blocks nothing; 0c validates then retires
--   the old one. (The older migrations/v4-photo-parent-widen/0a dropped first — do not copy it.)
--
-- FK DIRECTIONS — deliberately asymmetric:
--   photos.space_id → spaces(id) ON DELETE RESTRICT. NOT cascade (would destroy a photo that is
--     also attached to a planting) and NOT set-null (would strand a space-only photo in violation
--     of must-have-parent). Space deletion must reassign in the app layer first.
--     Caveat: spaces has no deleted_at, so "space soft-delete" is not currently a thing at all.
--   spaces.featured_photo_id → photos(id) ON DELETE SET NULL. Photos are SOFT-deleted, so this
--     fires only on a hard delete; the hero READ must additionally filter deleted_at IS NULL and
--     fall back, or a soft-deleted hero yields a dead presigned URL.

ALTER TABLE public.photos
  ADD COLUMN IF NOT EXISTS space_id uuid REFERENCES public.spaces(id) ON DELETE RESTRICT;

ALTER TABLE public.spaces
  ADD COLUMN IF NOT EXISTS featured_photo_id uuid REFERENCES public.photos(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_photos_space_id
  ON public.photos (space_id) WHERE space_id IS NOT NULL;

ALTER TABLE public.photos
  ADD CONSTRAINT photos_must_have_parent_v2 CHECK (
    (event_id IS NOT NULL)
    OR (project_id IS NOT NULL)
    OR (location_id IS NOT NULL)
    OR (plant_id IS NOT NULL)
    OR (inventory_item_id IS NOT NULL)
    OR (space_id IS NOT NULL)
    OR COALESCE((intake_status = 'pending_tag'::text), false)
  ) NOT VALID;
