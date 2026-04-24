-- 20260424_plt_plants_schema_favorites.sql
-- PLT session migration — V1.1.0
-- Applied: 2026-04-24

-- Step 0: Create schema_version table
CREATE TABLE IF NOT EXISTS public.schema_version (
  version     TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 1. Add genus to plants (PROVISIONAL)
ALTER TABLE public.plants
  ADD COLUMN IF NOT EXISTS genus TEXT;

COMMENT ON COLUMN public.plants.genus IS
  'PROVISIONAL text field. Migrate to species_ref FK when trigger fires — see meta-adr.md.';
COMMENT ON COLUMN public.plants.species IS
  'PROVISIONAL text field. Migrate to species_ref FK when trigger fires — see meta-adr.md.';

-- 2. Add status CHECK constraint
ALTER TABLE public.plants
  DROP CONSTRAINT IF EXISTS chk_plants_status,
  ADD CONSTRAINT chk_plants_status CHECK (
    status IS NULL OR status IN (
      'seed', 'seedling', 'vegetative',
      'flowering', 'fruiting',
      'harvested', 'dormant', 'ended', 'failed'
    )
  );

-- 3. Favorites entity_type CHECK — add 'plant'
ALTER TABLE public.favorites DROP CONSTRAINT IF EXISTS favorites_entity_type_check;
ALTER TABLE public.favorites ADD CONSTRAINT favorites_entity_type_check
  CHECK (entity_type IN ('project', 'location', 'inventory_item', 'plant'));

-- 4. Schema version record
INSERT INTO public.schema_version (version, description)
VALUES ('1.1.0', 'PLT: genus, status constraint, favorites plant support')
ON CONFLICT (version) DO NOTHING;

