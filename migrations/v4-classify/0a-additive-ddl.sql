-- 0a-additive-ddl.sql
-- V4 CLASSIFY (V4-CLASSIFY-001) — filterable cultivar classification facets
--
-- PURPOSE: make already-present cultivar attributes filterable, and promote two prose-trapped
--   attributes to typed columns, so the derive engine (crop-derive.js) can emit clean facets:
--     * tag_facet_check widened: + heat, determinacy, day_length, allium_type, basil_use
--       (all DERIVED, system-owned facets — same class as type/lifecycle; NOT hand-assignable,
--        so lambda/tags/validate.js VALID_USER_FACETS is intentionally NOT widened).
--     * plant_varieties.determinacy         — tomato determinacy promoted from growth_habit prose
--     * plant_varieties.day_length_response — onion long/short/neutral (not derivable; populated data)
--     * plant_varieties.grown_as            — care-engine practical-lifecycle signal, default 'annual'
--   heat is derived from the existing scoville_max column (no new column). allium_type/basil_use are
--   derived from crop_type_slug/species (no new column). grown_as is a care-engine column, not a facet.
--
-- SAFETY: fully additive + idempotent. ADD COLUMN IF NOT EXISTS; new CHECK constraints added
--   NOT VALID (no full-table scan/lock on apply) then VALIDATEd in 0c-validate.sql (L-058).
--   The tag_facet_check widen is a superset (every currently-valid facet stays valid). schema_version
--   INSERT is ON CONFLICT DO NOTHING. Re-running the whole file is a clean no-op.
--
-- DRY-RUN: dry-run-validated 2026-07-06 on COW branch dryrun-v4-classify-1783351825
--   (br-summer-silence-amzzzw01, copy-on-write off production br-delicate-sea-amum92c2): 0a applied
--   clean; grown_as default backfilled 205/205; determinacy column populated 35/37 tomatoes (2 null =
--   no prose); day_length_response set for 2 long-day onions; Santa Fe Grande scoville backfilled
--   (5000/8000 -> Medium, per locked design); applyDerive materialized all 5 facets over 205 cultivars
--   with 0 failures; 0c VALIDATE passed post-materialization; 0 out-of-vocab facet rows. Branch deleted.
--   NOT yet applied to prod. NOT yet applied to staging.
--
-- ROLLBACK:
--   ALTER TABLE public.tag DROP CONSTRAINT IF EXISTS tag_facet_check;
--   ALTER TABLE public.tag ADD CONSTRAINT tag_facet_check
--     CHECK (facet = ANY (ARRAY['type','group','lifecycle','location','freeform']));
--   ALTER TABLE public.plant_varieties DROP CONSTRAINT IF EXISTS chk_plant_varieties_determinacy;
--   ALTER TABLE public.plant_varieties DROP CONSTRAINT IF EXISTS chk_plant_varieties_day_length;
--   ALTER TABLE public.plant_varieties DROP CONSTRAINT IF EXISTS chk_plant_varieties_grown_as;
--   ALTER TABLE public.plant_varieties
--     DROP COLUMN IF EXISTS grown_as,
--     DROP COLUMN IF EXISTS day_length_response,
--     DROP COLUMN IF EXISTS determinacy;
--   DELETE FROM public.schema_version WHERE version='4.11.0-classify-001';

-- 1. Widen the tag facet vocabulary (superset — additive).
DO $$ BEGIN
  ALTER TABLE public.tag DROP CONSTRAINT IF EXISTS tag_facet_check;
  ALTER TABLE public.tag ADD CONSTRAINT tag_facet_check
    CHECK (facet = ANY (ARRAY['type','group','lifecycle','location','freeform',
                              'heat','determinacy','day_length','allium_type','basil_use'])) NOT VALID;
END $$;

-- 2. New nullable plant_varieties columns.
ALTER TABLE public.plant_varieties
  ADD COLUMN IF NOT EXISTS determinacy text,
  ADD COLUMN IF NOT EXISTS day_length_response text,
  ADD COLUMN IF NOT EXISTS grown_as text DEFAULT 'annual';

-- 3. Value CHECKs on the new columns (NOT VALID; validated in 0c).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_plant_varieties_determinacy') THEN
    ALTER TABLE public.plant_varieties ADD CONSTRAINT chk_plant_varieties_determinacy
      CHECK (determinacy IS NULL OR determinacy IN ('determinate','semi_determinate','indeterminate','dwarf')) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_plant_varieties_day_length') THEN
    ALTER TABLE public.plant_varieties ADD CONSTRAINT chk_plant_varieties_day_length
      CHECK (day_length_response IS NULL OR day_length_response IN ('long_day','short_day','day_neutral','intermediate')) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_plant_varieties_grown_as') THEN
    ALTER TABLE public.plant_varieties ADD CONSTRAINT chk_plant_varieties_grown_as
      CHECK (grown_as IS NULL OR grown_as IN ('annual','tender_perennial','perennial','biennial')) NOT VALID;
  END IF;
END $$;

INSERT INTO public.schema_version (version, description)
VALUES ('4.11.0-classify-001','CLASSIFY: tag_facet_check +heat/determinacy/day_length/allium_type/basil_use (derived facets); plant_varieties +determinacy/+day_length_response/+grown_as(default annual). Additive, nullable.')
ON CONFLICT (version) DO NOTHING;
