-- 0a-data.sql
-- V4-CROPTYPEDOGWOOD-001 — Dogwood was untypeable, and the one planting that needed it is untyped.
--
-- REPORTED (Dave, 2026-08-17): added a Kousa dogwood, "cannot add a type". Confirmed against prod:
-- `crop_types` carries ZERO dogwood rows out of 141, and the cultivar `Kousa`
-- (0189f4cd-aa30-47b7-81cc-f467ab767f6b, created 13:47:06Z) sits with crop_type_slug NULL, 32
-- seconds before the planting `Kousa Dogwood` that references it. Nothing was broken in the write
-- path — the reference data never existed, and the mint affordance that would have created it was
-- the 143rd row of an unfiltered chooser (V4-CROPTYPEREACH-001 fixes the reachability; this fixes
-- the data).
--
-- ONE crop_types row plus a retype of the EXISTING cultivar. Deliberately NOT the two-row shape of
-- V4-CROPTYPEALOE-001: that migration had to mint a cultivar because Dave's Aloe planting had
-- variety_id NULL. Here the cultivar already exists and the planting already points at it, so
-- minting a second one would duplicate what the picker lists.
--
-- Modelled on `japanese_maple`, the only existing `tree` row and the closest sibling: both are
-- woody ornamental trees, hardy at this site, grown for form and flower rather than harvested.
-- harvest_habit stays NULL to match it — Cornus kousa does bear edible fruit, but Dave planted a
-- landscape tree, and asserting a harvest habit he has not claimed would put it in harvest-facing
-- surfaces he did not ask for. He can set one from the variety editor if he ever wants it.
--
-- Values mirror EXACTLY what the app's own POST /api/varieties/crop-types would have written, so
-- this row is indistinguishable from one minted in-app:
--   slug           slugifyCropType('Dogwood') -> 'dogwood'   (lambda/varieties/validate.js:181)
--                  resolveCropTypeName verdict: ok — no exact/plural/coupled-synonym collision.
--   display_name   'Dogwood' — the PARENT type. 'Kousa' is the cultivar, and naming the type after
--                  the cultivar is the one-variety-per-type fragmentation the mint form guards
--                  against (VarietyPicker.jsx beginNewCropType deliberately does not prefill).
--   lifecycle      the cultivar gets 'perennial' because the app's create path sends
--                  lifecycle = cropType.default_lifecycle alongside crop_type_slug.
--
-- DATA-ONLY. No DDL. Idempotent: every statement is guarded, so a re-run is a no-op.
-- NOTE: the derived-tag reconciliation the API performs after a cultivar write (applyDerive,
-- lambda/varieties/index.js:395) is NOT expressible in SQL and is run separately at apply time —
-- see README. Skipping it would leave the `type`/`lifecycle` facets stale for this cultivar.
BEGIN;

CREATE TABLE IF NOT EXISTS public.snap_croptypedogwood001_cultivar (
  cultivar_id uuid PRIMARY KEY,
  prev_crop_type_slug text,
  prev_lifecycle text,
  at timestamptz NOT NULL DEFAULT now()
);

-- 1. The crop type.
INSERT INTO public.crop_types (slug, display_name, category, default_lifecycle, sort_order, created_by)
SELECT 'dogwood', 'Dogwood', 'tree', 'perennial', 0, 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI'
WHERE NOT EXISTS (SELECT 1 FROM public.crop_types WHERE slug = 'dogwood');

-- 2. Adopt the cultivar Dave could not type. Narrow by construction: the exact row he created, only
--    while it is still untyped. If he has since typed it himself this is a no-op and his choice
--    stands. The snap_ row is rollback scaffolding (see 0r) and records the pre-state.
INSERT INTO public.snap_croptypedogwood001_cultivar (cultivar_id, prev_crop_type_slug, prev_lifecycle)
SELECT id, crop_type_slug, lifecycle FROM public.plant_varieties
WHERE id = '0189f4cd-aa30-47b7-81cc-f467ab767f6b'::uuid
  AND crop_type_slug IS NULL AND deleted_at IS NULL AND name = 'Kousa'
ON CONFLICT (cultivar_id) DO NOTHING;

UPDATE public.plant_varieties
SET crop_type_slug = 'dogwood', lifecycle = 'perennial', updated_at = now()
WHERE id = '0189f4cd-aa30-47b7-81cc-f467ab767f6b'::uuid
  AND crop_type_slug IS NULL AND deleted_at IS NULL AND name = 'Kousa';

INSERT INTO public.schema_version (version, description)
VALUES ('4.33.0-croptypedogwood-001',
  'CROPTYPEDOGWOOD reference data (data-only): add the dogwood crop_type and type the existing '
  'Kousa cultivar that Dave created untyped on 2026-08-17. One row plus a retype, not the two-row '
  'aloe shape -- the cultivar already exists and the planting already references it. Modelled on '
  'japanese_maple, the only other tree row. Values mirror what POST /api/varieties/crop-types would '
  'have written. applyDerive is run out-of-band at apply time (not expressible in SQL). Reversible '
  'via 0r (guarded: refuses if another writer has since changed the cultivar).')
ON CONFLICT DO NOTHING;

COMMIT;
