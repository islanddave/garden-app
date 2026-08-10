-- 0b-data.sql
-- V4-CROPTYPEALOE-001 — Aloe was untypeable in the app.
--
-- REPORTED (Dave, 2026-08-10): "added Aloe Vera plant via Snap (no type - cannot add Aloe as a type
-- in that form)". Confirmed: `crop_types` had ZERO aloe rows out of 135, even though the taxonomy
-- already carries a `succulent` category with 8 members. Nothing was broken in the form — the
-- reference data simply never existed.
--
-- TWO ROWS ARE REQUIRED, not one. src/pages/CaptureFlow.jsx:216 renders a picker fed by
-- /api/varieties, and lambda/varieties/index.js:220-231 selects from `public.cultivar` — an
-- UNFILTERED projection of `plant_varieties`. So the Snap picker lists CULTIVARS, not crop types.
-- A crop_types row alone would have left the form exactly as broken as Dave found it.
--
-- DATA-ONLY. No DDL. Idempotent: every statement is guarded, so a re-run is a no-op rather than a
-- duplicate. The snap_ table is rollback scaffolding (see 0r).
BEGIN;

CREATE TABLE IF NOT EXISTS public.snap_croptypealoe001_planting (
  plant_id uuid PRIMARY KEY,
  prev_variety_id uuid,
  at timestamptz NOT NULL DEFAULT now()
);

-- 1. The crop type. Modelled on `haworthia`, the closest existing sibling: both are tender succulents
--    that do not survive frost, hence tender_perennial rather than the plain perennial used by the
--    hardy members. default_unit stays NULL and variety_grams_required stays true, matching all 8
--    existing succulents — these are ornamentals, not harvested by count or weight, and a crop-level
--    gram fallback for them would be meaningless.
INSERT INTO public.crop_types (slug, display_name, category, default_lifecycle, variety_grams_required, sort_order, created_by)
SELECT 'aloe', 'Aloe', 'succulent', 'tender_perennial', true, 0, 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI'
WHERE NOT EXISTS (SELECT 1 FROM public.crop_types WHERE slug = 'aloe');

-- 2. The cultivar the picker actually lists. Fixed UUID so rollback and the gates can name it, and so
--    a re-run cannot mint a second one.
INSERT INTO public.plant_varieties (id, name, genus, species, crop_type_slug, lifecycle, model_version, created_by)
SELECT 'a10e0000-0000-4000-8000-00000000a10e'::uuid, 'Aloe Vera', 'Aloe', 'Aloe barbadensis miller',
       'aloe', 'tender_perennial', 1, 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI'
WHERE NOT EXISTS (SELECT 1 FROM public.plant_varieties WHERE id = 'a10e0000-0000-4000-8000-00000000a10e'::uuid);

-- 3. Adopt the planting Dave could not type. Narrow by construction: the exact row he created, only
--    while it is still untyped, and only if it is still named Aloe Vera. If he has since typed it
--    himself this is a no-op and his choice stands.
INSERT INTO public.snap_croptypealoe001_planting (plant_id, prev_variety_id)
SELECT id, variety_id FROM public.plants
WHERE id = 'ea1c5abb-6b98-4e6d-bb6a-cb656ad9119b'::uuid
  AND variety_id IS NULL AND deleted_at IS NULL AND name = 'Aloe Vera'
ON CONFLICT (plant_id) DO NOTHING;

UPDATE public.plants
SET variety_id = 'a10e0000-0000-4000-8000-00000000a10e'::uuid, updated_at = now()
WHERE id = 'ea1c5abb-6b98-4e6d-bb6a-cb656ad9119b'::uuid
  AND variety_id IS NULL AND deleted_at IS NULL AND name = 'Aloe Vera';

INSERT INTO public.schema_version (version, description)
VALUES ('4.23.6-croptypealoe-001',
  'CROPTYPEALOE reference data (data-only): add the aloe crop_type and the Aloe Vera cultivar, and '
  'adopt the one untyped planting Dave created via Snap. Two rows are required because the Snap '
  'picker reads public.cultivar (over plant_varieties), not crop_types -- a crop_types row alone '
  'would leave the form exactly as broken. Modelled on haworthia, the closest tender-succulent '
  'sibling. Reversible via 0r (guarded: refuses if another writer has adopted either row).')
ON CONFLICT DO NOTHING;

COMMIT;
