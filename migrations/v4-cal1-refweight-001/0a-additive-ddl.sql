-- 0a-additive-ddl.sql
-- V4-CAL1-REFWEIGHT-001 — REFERENCE (estimate) tier for harvest weight conversion.
--
-- PURPOSE: v4-cal1-harvweight-001 landed the substrate (crop_types.default_unit/grams_per_unit,
--   harvest_log.weight_grams/weight_estimated) but deliberately left grams_per_unit ALL NULL, on the
--   rule "never guess — NULL beats a wrong factor". Dave directive 2026-08-03 REVISES that rule for
--   the estimate tier specifically: populate researched/best-guess per-unit weights NOW so harvest
--   totals compute in grams today, explicitly flagged as estimates, and let real kitchen-scale
--   measurements supersede them as they arrive. The anti-guess rule still holds where it matters —
--   nothing here is ever presented as measured, and the MEASURED tier still wins unconditionally.
--
-- WHAT THIS ADDS (6 additive nullable columns, no defaults):
--   crop_types.unit_weights        jsonb — {unit: grams} for EVERY unit this crop is logged in
--   crop_types.weight_source       text  — usda | catalog | estimate | measured
--   crop_types.weight_confidence   text  — high | medium | low
--   plant_varieties.unit_weights      jsonb — same shape, per-variety override (wins over crop)
--   plant_varieties.weight_source     text
--   plant_varieties.weight_confidence text
--
-- WHY jsonb AND NOT a second scalar: Dave logs one crop in several units (raspberries in BOTH cup and
--   count; dill in count, cup AND bunch; parsley in cup and count). The existing scalar pair carries
--   exactly one basis unit, so an off-modal row can never resolve. A {unit: grams} map resolves every
--   logged unit without a row-per-unit table. 10 of 332 live harvest rows are off-modal today — small,
--   but they are silently unconvertible under the scalar-only model, and the mix grows.
--
-- RELATIONSHIP TO v4-cal1-pervariety-001 (authored, NOT applied): that migration owns the MEASURED
--   tier (cultivar_weight_sample/void, cultivar_weight_derived, harvest_log.weight_basis,
--   crop_types.variety_grams_required). This migration touches NONE of those object names — the two
--   are disjoint and compose: measured (pervariety) > variety reference (here) > crop reference (here)
--   > NULL. Apply order between them does not matter.
--
-- NULL SEMANTICS: NULL unit_weights, or a unit absent from the map, = UNKNOWN = NO estimate. There is
--   still no coalesce-to-a-default anywhere. What changed is that far fewer cells are UNKNOWN.
--
-- SAFETY: fully additive + idempotent. ADD COLUMN IF NOT EXISTS (nullable, no DEFAULT -> metadata-only,
--   no table rewrite). Every CHECK is pg_constraint-guarded and added NOT VALID (no full scan / heavy
--   lock on apply); VALIDATEd separately in 0c per the L-058 sweep. schema_version INSERT is
--   ON CONFLICT DO NOTHING. Re-running the file is a clean no-op. No existing column, constraint,
--   view or index is touched; `SELECT *` consumers receive extra NULL keys only.
--
-- APPLY ORDER: 0a (this) -> 0b-seed.sql (generated) -> 0c-validate.sql -> 0d-backfill.sql.
--   CTAS snapshots before 0b:
--     CREATE TABLE ctas_20260803_crop_types_refw      AS SELECT * FROM public.crop_types;
--     CREATE TABLE ctas_20260803_plant_varieties_refw AS SELECT * FROM public.plant_varieties;
--     CREATE TABLE ctas_20260803_harvest_log_refw     AS SELECT * FROM public.harvest_log;
--   Neon PITR is ~6h, so CTAS is the real rollback. 0r-rollback.sql is the DDL revert.

ALTER TABLE public.crop_types
  ADD COLUMN IF NOT EXISTS unit_weights      jsonb,
  ADD COLUMN IF NOT EXISTS weight_source     text,
  ADD COLUMN IF NOT EXISTS weight_confidence text;

ALTER TABLE public.plant_varieties
  ADD COLUMN IF NOT EXISTS unit_weights      jsonb,
  ADD COLUMN IF NOT EXISTS weight_source     text,
  ADD COLUMN IF NOT EXISTS weight_confidence text;

-- unit_weights must be a flat OBJECT whose keys are all in the harvest_log.unit vocabulary and whose
-- values are all strictly-positive numbers. A key outside the vocab could never match a logged unit
-- (silently dead data); a zero/negative/non-numeric value would zero out or corrupt a yield total.
-- Enforced structurally rather than by convention so a bad seed fails loudly at write time.
CREATE OR REPLACE FUNCTION public.chk_unit_weights_shape(w jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT w IS NULL OR (
    jsonb_typeof(w) = 'object'
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_each(w) AS e(k, v)
      WHERE k NOT IN ('lb','oz','kg','g','count','bunch','cup','head')
         OR jsonb_typeof(v) <> 'number'
         OR (v#>>'{}')::numeric <= 0
    )
  );
$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_crop_types_unit_weights') THEN
    ALTER TABLE public.crop_types ADD CONSTRAINT chk_crop_types_unit_weights
      CHECK (public.chk_unit_weights_shape(unit_weights)) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_plant_varieties_unit_weights') THEN
    ALTER TABLE public.plant_varieties ADD CONSTRAINT chk_plant_varieties_unit_weights
      CHECK (public.chk_unit_weights_shape(unit_weights)) NOT VALID;
  END IF;
END $$;

-- Provenance vocab. 'measured' is reserved for values derived from real weighings — the seed in 0b
-- never writes it, and 0b refuses to overwrite any row already marked 'measured'.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_crop_types_weight_source') THEN
    ALTER TABLE public.crop_types ADD CONSTRAINT chk_crop_types_weight_source
      CHECK (weight_source IS NULL OR weight_source IN ('usda','catalog','estimate','measured')) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_plant_varieties_weight_source') THEN
    ALTER TABLE public.plant_varieties ADD CONSTRAINT chk_plant_varieties_weight_source
      CHECK (weight_source IS NULL OR weight_source IN ('usda','catalog','estimate','measured')) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_crop_types_weight_confidence') THEN
    ALTER TABLE public.crop_types ADD CONSTRAINT chk_crop_types_weight_confidence
      CHECK (weight_confidence IS NULL OR weight_confidence IN ('high','medium','low')) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_plant_varieties_weight_confidence') THEN
    ALTER TABLE public.plant_varieties ADD CONSTRAINT chk_plant_varieties_weight_confidence
      CHECK (weight_confidence IS NULL OR weight_confidence IN ('high','medium','low')) NOT VALID;
  END IF;
END $$;

INSERT INTO public.schema_version (version, description)
VALUES ('4.18.0-cal1-refweight-001','CAL-1 reference tier: crop_types + plant_varieties each get unit_weights(jsonb {unit:grams}, shape-CHECKed to the harvest unit vocab + positive numbers), weight_source(usda|catalog|estimate|measured) and weight_confidence(high|medium|low). All nullable, no defaults, CHECKs NOT VALID (validated in 0c). Adds the ESTIMATE tier that harvweight-001 left NULL; disjoint from pervariety-001 (measured tier). NULL/absent unit = UNKNOWN = no estimate.')
ON CONFLICT (version) DO NOTHING;
