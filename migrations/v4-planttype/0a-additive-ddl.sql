-- 0a-additive-ddl.sql
-- V4 PLANTTYPE — crop_types vocabulary table + plant_varieties type/lifecycle/heat metadata
--
-- PURPOSE: introduce a controlled crop_types vocabulary (slug PK, lifecycle/category/sort) and
--   enrich plant_varieties with optional, nullable type metadata: crop_type_slug (FK), lifecycle,
--   scoville_min/max, growth_habit, produces_scape. All additive — no backfill, no NOT NULL on
--   existing rows, no column drops. Supports the PLANTTYPE feature (type-aware variety records).
--
-- SAFETY: fully additive + idempotent. CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
--   CREATE INDEX IF NOT EXISTS, constraints guarded by pg_constraint existence checks, and the
--   schema_version INSERT is ON CONFLICT DO NOTHING. Re-running the whole file is a clean no-op.
--   New CHECK constraints are added NOT VALID (no full-table scan / lock on apply); they are
--   VALIDATEd separately in 0c-validate.sql (L-058 sweep step).
--
-- DRY-RUN: dry-run-validated on COW branch dryrun-v4-tagsub-20260625-193243
--   (br-snowy-field-amxeo8j7, copy-on-write off production br-delicate-sea-amum92c2).
--   NOT yet applied to prod. NOT yet applied to staging.
--
-- ROLLBACK:
--   ALTER TABLE public.plant_varieties DROP CONSTRAINT IF EXISTS chk_plant_varieties_scoville;
--   ALTER TABLE public.plant_varieties DROP CONSTRAINT IF EXISTS chk_plant_varieties_lifecycle;
--   DROP INDEX IF EXISTS public.idx_plant_varieties_crop_type;
--   ALTER TABLE public.plant_varieties
--     DROP COLUMN IF EXISTS produces_scape,
--     DROP COLUMN IF EXISTS growth_habit,
--     DROP COLUMN IF EXISTS scoville_max,
--     DROP COLUMN IF EXISTS scoville_min,
--     DROP COLUMN IF EXISTS lifecycle,
--     DROP COLUMN IF EXISTS crop_type_slug;
--   DROP TABLE IF EXISTS public.crop_types;
--   DELETE FROM public.schema_version WHERE version='4.1.0-planttype-001';

CREATE TABLE IF NOT EXISTS public.crop_types (
  slug text PRIMARY KEY,
  display_name text NOT NULL,
  default_lifecycle text CHECK (default_lifecycle IS NULL OR default_lifecycle IN ('annual','tender_perennial','perennial','biennial')),
  category text,
  sort_order integer NOT NULL DEFAULT 0,
  created_by text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz NULL
);

ALTER TABLE public.plant_varieties
  ADD COLUMN IF NOT EXISTS crop_type_slug text REFERENCES public.crop_types(slug) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lifecycle text,
  ADD COLUMN IF NOT EXISTS scoville_min integer,
  ADD COLUMN IF NOT EXISTS scoville_max integer,
  ADD COLUMN IF NOT EXISTS growth_habit text,
  ADD COLUMN IF NOT EXISTS produces_scape boolean;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_plant_varieties_lifecycle') THEN
    ALTER TABLE public.plant_varieties ADD CONSTRAINT chk_plant_varieties_lifecycle
      CHECK (lifecycle IS NULL OR lifecycle IN ('annual','tender_perennial','perennial','biennial')) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_plant_varieties_scoville') THEN
    ALTER TABLE public.plant_varieties ADD CONSTRAINT chk_plant_varieties_scoville
      CHECK (scoville_min IS NULL OR scoville_max IS NULL OR scoville_min <= scoville_max) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_plant_varieties_crop_type ON public.plant_varieties(crop_type_slug) WHERE deleted_at IS NULL;

INSERT INTO public.schema_version (version, description)
VALUES ('4.1.0-planttype-001','PLANTTYPE: crop_types vocab + plant_varieties crop_type_slug/lifecycle/scoville_min/max/growth_habit/produces_scape (additive, nullable)')
ON CONFLICT (version) DO NOTHING;
