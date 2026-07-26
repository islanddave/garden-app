-- 0r-rollback.sql — V4-PUTUPPROV-002 rollback.
--
-- Deletes ONLY the seeded rows that nothing references. The NOT EXISTS guards matter: once Dave logs
-- a put-up of Clarkdale apples, crop_types.apple is an FK target from preservation_log and deleting
-- it would either fail on the constraint or orphan real data. A seeded row that has been USED is no
-- longer a seed — it is his record, and this file leaves it alone by design.
--
-- Prefer soft-delete (SET deleted_at = now()) over hard delete if these ever need to disappear from
-- the picker while staying referenceable — every read filters deleted_at IS NULL.

BEGIN;

DELETE FROM public.crop_types ct
 WHERE ct.slug IN ('apple','pear','plum','cherry','sour_cherry','apricot','nectarine',
                   'cranberry','grape','raspberry','blackberry','elderberry','rhubarb')
   AND ct.created_by = 'system'
   AND NOT EXISTS (SELECT 1 FROM public.preservation_log p WHERE p.crop_type_slug = ct.slug)
   AND NOT EXISTS (SELECT 1 FROM public.plant_varieties v WHERE v.crop_type_slug = ct.slug);
-- NOTE: inventory_items has NO crop_type_slug column (checked against live Neon, 2026-07-26) — an
-- earlier draft of this file guarded on one and would have errored at rollback time. Seed packets
-- reach a crop type indirectly, through variety_id -> plant_varieties.crop_type_slug, which the
-- plant_varieties guard above already covers.

DELETE FROM public.schema_version WHERE version = '4.15.1-putupprov-002';

COMMIT;
