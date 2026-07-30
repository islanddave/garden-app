-- 0a-additive-ddl.sql
-- V4-CAL1-HARVWEIGHT-001 — harvest weight capture + unit->gram conversion substrate.
--
-- PURPOSE: make an ESTIMATED harvest weight in grams derivable for every harvest_log row (past +
--   future) so 2026-vs-2027 yield can be compared in a single unit, WITHOUT disturbing the existing
--   quantity+unit capture. Live today: 255 harvest_log rows, ALL in non-weight units (count 177,
--   cup 75, head 2, bunch 1); zero rows use g/kg/lb/oz. Four additive nullable columns close the gap:
--     crop_types.default_unit    — the unit grams_per_unit converts FROM (per-crop modal unit)
--     crop_types.grams_per_unit  — grams for ONE default_unit of this crop (Dave-curated; NULL=unknown)
--     harvest_log.weight_grams   — grams for this row: MEASURED (unit in g/kg/lb/oz) or ESTIMATED
--                                  (quantity * crop grams_per_unit); NULL when neither is possible
--     harvest_log.weight_estimated — provenance: false=measured, true=estimated, NULL=no weight
--
-- NULL SEMANTICS (load-bearing, same contract as v4-harvattr-001): NULL grams_per_unit = UNKNOWN and
--   NO estimate is produced — there is no defaulting, no coalesce-to-a-guess anywhere downstream. A
--   fabricated conversion factor would silently corrupt every yield comparison (a wrong number is
--   worse than no number), so grams_per_unit takes NO DEFAULT and is never guessed — it is measured
--   on a kitchen scale and seeded (Dave; src/data/harvest-weights-v1.json is the authoring source).
--
-- SAFETY: fully additive + idempotent. ADD COLUMN IF NOT EXISTS (all nullable, no DEFAULT -> no table
--   rewrite, metadata-only on PG11+). Every CHECK is pg_constraint-guarded and added NOT VALID (no
--   full-table scan / heavy lock on apply); VALIDATEd separately in 0c (L-058 sweep). schema_version
--   INSERT is ON CONFLICT DO NOTHING. Re-running the whole file is a clean no-op. NO destructive DDL,
--   NO existing column/constraint/view/index touched. Adding nullable columns cannot break `SELECT *`
--   consumers (they receive extra NULL keys) and no consumer selects these columns positionally.
--
-- APPLY ORDER: 0a (this) -> 0b-data.sql (default_unit derive) -> 0c-validate.sql (VALIDATE the CHECKs).
--   Gates in gates.yml (pre/post). NOT applied by the authoring session — apply is Dave-gated. STAGING
--   first (Neon branch br-damp-frog-amdfxwrr) so integration-test.yml (which branches off staging)
--   inherits the columns; PROD is Dave-gated and REQUIRED before promoting any Lambda code that reads
--   weight_grams (schema-audit.yml L-081 gate). Neon PITR window is ~6h -> CTAS is the real rollback.
--
-- ROLLBACK: 0r-rollback.sql (drops the constraints, then the columns, then the schema_version rows).
--   Prefer the data-only revert once any code reads the columns (dropping destroys Dave's curated
--   grams_per_unit). CTAS snapshots (taken after 0a, before 0b) are the primary rollback:
--     CREATE TABLE ctas_20260730_harvest_log_cal1 AS SELECT * FROM public.harvest_log;
--     CREATE TABLE ctas_20260730_crop_types_cal1  AS SELECT * FROM public.crop_types;

ALTER TABLE public.crop_types
  ADD COLUMN IF NOT EXISTS default_unit   text,
  ADD COLUMN IF NOT EXISTS grams_per_unit numeric;

ALTER TABLE public.harvest_log
  ADD COLUMN IF NOT EXISTS weight_grams     numeric,
  ADD COLUMN IF NOT EXISTS weight_estimated boolean;

-- default_unit vocab pinned to the harvest_log.unit CHECK vocabulary (a default_unit outside it could
-- never match a logged unit). text + CHECK, matching the house convention (v4-putup-001): ALTER TYPE
-- cannot run in a txn alongside other DDL and enum values cannot be cleanly removed.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_crop_types_default_unit') THEN
    ALTER TABLE public.crop_types ADD CONSTRAINT chk_crop_types_default_unit
      CHECK (default_unit IS NULL OR default_unit IN
             ('lb','oz','kg','g','count','bunch','cup','head')) NOT VALID;
  END IF;
END $$;

-- A conversion factor must be strictly positive: 0 or negative grams-per-unit is a data error that
-- would zero out or negate a yield. NULL = unknown imposes nothing.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_crop_types_grams_per_unit') THEN
    ALTER TABLE public.crop_types ADD CONSTRAINT chk_crop_types_grams_per_unit
      CHECK (grams_per_unit IS NULL OR grams_per_unit > 0) NOT VALID;
  END IF;
END $$;

-- weight_grams is non-negative (0 is admissible — a recorded failed/empty pick). NULL = no weight.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_harvest_log_weight_grams') THEN
    ALTER TABLE public.harvest_log ADD CONSTRAINT chk_harvest_log_weight_grams
      CHECK (weight_grams IS NULL OR weight_grams >= 0) NOT VALID;
  END IF;
END $$;

-- Provenance pairing: a weight and its estimated/measured flag are set together or not at all.
-- (weight_grams IS NULL) = (weight_estimated IS NULL) rejects a weight with no provenance AND a
-- provenance flag with no weight — either would make the measured-vs-estimated split unreadable.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_harvest_log_weight_pairing') THEN
    ALTER TABLE public.harvest_log ADD CONSTRAINT chk_harvest_log_weight_pairing
      CHECK ((weight_grams IS NULL) = (weight_estimated IS NULL)) NOT VALID;
  END IF;
END $$;

INSERT INTO public.schema_version (version, description)
VALUES ('4.17.0-cal1-harvweight-001','CAL-1: crop_types +default_unit(text,CHECK unit-vocab)/+grams_per_unit(numeric,>0); harvest_log +weight_grams(numeric,>=0)/+weight_estimated(bool) with pairing CHECK (both-or-neither). All nullable, no defaults. CHECKs added NOT VALID (validated in 0c). NULL grams_per_unit = UNKNOWN = no estimate. Additive; no existing column/constraint/view touched.')
ON CONFLICT (version) DO NOTHING;
