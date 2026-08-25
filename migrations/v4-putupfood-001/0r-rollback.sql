-- 0r-rollback.sql — V4-PUTUPFOODCATEGORY-001 rollback.
--
-- Deletes ONLY the seeded rows that nothing references. The NOT EXISTS guards are load-bearing, not
-- decorative: preservation_log_crop_type_slug_fkey is a plain FOREIGN KEY with NO ON DELETE clause
-- (VERIFIED against live prod), i.e. NO ACTION — so once Dave logs a loaf of bread, deleting
-- crop_types.bread raises a foreign-key violation and takes the whole rollback with it. A seeded row
-- that has been USED is no longer a seed; it is his record, and this file leaves it alone by design.
--
-- Prefer soft-delete (SET deleted_at = now()) over hard delete if these ever need to disappear from
-- the pickers while staying referenceable — every read filters deleted_at IS NULL.
--
-- plant_varieties is guarded too even though a bread variety should never exist: the FK
-- plant_varieties.crop_type_slug -> crop_types(slug) is real, and a guard that is currently vacuous
-- costs nothing while an absent one fails at exactly the moment the assumption stops holding.
-- inventory_items has NO crop_type_slug column (re-confirmed this session, live prod) — it reaches a
-- crop type indirectly through variety_id -> plant_varieties.crop_type_slug, which the second guard
-- already covers.

BEGIN;

DELETE FROM public.crop_types ct
 WHERE ct.slug IN ('bread','cheese','milk','butter','yogurt','meat','fish')
   AND ct.category = 'non_plant_food'
   AND ct.created_by = 'system'
   AND NOT EXISTS (SELECT 1 FROM public.preservation_log p WHERE p.crop_type_slug = ct.slug)
   AND NOT EXISTS (SELECT 1 FROM public.plant_varieties v WHERE v.crop_type_slug = ct.slug);

DELETE FROM public.schema_version WHERE version = '4.39.0-putupfood-001';

COMMIT;
