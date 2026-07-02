-- V4-PHOTOPARENT-001 — widen photos_must_have_parent (fixes Snap "Update a photo" 500).
-- The old CHECK only accepted event_id/project_id/location_id as a valid parent, so a photo
-- attached ONLY to a planting (plant_id) or an inventory item (inventory_item_id) violated it
-- and the POST /api/photos INSERT 500'd. CaptureFlow replace/new-planting/inventory modes all
-- hit this. Widening is SAFE (loosening): every existing row already satisfies the looser
-- predicate (verified 0 orphans across prod). Not destructive; apply to prod AND staging branch.
ALTER TABLE photos DROP CONSTRAINT photos_must_have_parent;
ALTER TABLE photos ADD CONSTRAINT photos_must_have_parent CHECK (
  event_id IS NOT NULL
  OR project_id IS NOT NULL
  OR location_id IS NOT NULL
  OR plant_id IS NOT NULL
  OR inventory_item_id IS NOT NULL
);
