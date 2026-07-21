-- 0a-additive-ddl.sql
-- V4-HARVATTR-001 — crop_types harvest-readiness attribute columns.
--
-- PURPOSE: land the DATA SUBSTRATE that every harvest-readiness predicate depends on. Two prior
--   readiness designs died because these attributes did not exist anywhere: `harvest_habit`,
--   `loss_horizon_hours`, `repeat_interval`, `set_to_first_pick_days` returned ZERO hits across
--   plant_varieties (40 cols), crop_types (9 cols), all of src/, lambda/, and migrations/.
--   Six additive nullable columns on crop_types (114 live rows) close that gap:
--     * harvest_habit             — single | repeat | cut_and_come_again (CHECK-enforced vocab)
--     * repeat_interval_days      — peak-season days between picks; NULL when not repeat-harvested
--     * loss_horizon_hours        — hours of on-plant hold before quality is materially lost
--     * set_to_first_pick_days    — fruit set -> first pickable. THIS is what makes status='fruiting'
--                                   a usable signal: a bell pepper is 50-55d set->green, so a plant
--                                   that is 'fruiting' today is NOT ready today.
--     * harvest_season_start_doy  — hard-window start (day of year)
--     * harvest_season_end_doy    — hard-window end. Asparagus is the motivating case: cutting after
--                                   ~Jun 15 damages the crown, so a readiness signal outside the
--                                   window is ACTIVELY HARMFUL, not merely useless.
--
--   CHOICE OF TABLE: crop_types, not plant_varieties. These attributes are properties of the CROP
--   (a cucumber is picked every 2-3 days regardless of cultivar), and crop_types has 114 rows vs
--   plant_varieties' hundreds. Variety-level overrides, if ever needed, are a later additive step.
--
-- NULL SEMANTICS (load-bearing — this is the design's central contract): NULL means UNKNOWN and a
--   readiness predicate MUST NOT FIRE on it. There is no defaulting, no "assume 7 days", no
--   coalesce-to-a-guess anywhere downstream. A wrong number is worse than no number: it either
--   nags about a crop that is not ready or, in the asparagus/garlic case, tells the user to do
--   something that harms the plant. Consequently NO column takes a DEFAULT and NONE is NOT NULL.
--
-- SAFETY: fully additive + idempotent. ADD COLUMN IF NOT EXISTS (all nullable, no DEFAULT -> no
--   table rewrite, metadata-only on PG11+). Every CHECK is guarded by a pg_constraint existence
--   test and added NOT VALID (no full-table scan / heavy lock on apply); they are VALIDATEd
--   separately in 0c-validate.sql (L-058 sweep step). schema_version INSERT is ON CONFLICT DO
--   NOTHING. Re-running the whole file is a clean no-op. NO destructive DDL, NO existing column,
--   constraint, view, or index touched. Every existing read is unaffected: adding nullable columns
--   cannot break `SELECT *` consumers (they receive extra NULL keys) and no consumer selects
--   crop_types columns positionally.
--
--   NOTE on crop_types.category: it has NO DB CHECK — application code is the only guard. This
--   migration does NOT change that (out of scope, and adding one now risks failing on an existing
--   out-of-vocab value). Flagged, not fixed.
--
-- APPLY ORDER: 0a (this file) -> 0b-data.sql (seed values) -> 0c-validate.sql (VALIDATE the CHECKs).
--   Gates in gates.yml (pre/post). NOT applied to any environment by the authoring session — apply
--   is Dave-gated. Staging-first per gates.yml sequencing; prod is Dave-gated.
--
-- ROLLBACK: 0r-rollback.sql (drops the constraints, then the columns, then the schema_version rows).

ALTER TABLE public.crop_types
  ADD COLUMN IF NOT EXISTS harvest_habit            text,
  ADD COLUMN IF NOT EXISTS repeat_interval_days     smallint,
  ADD COLUMN IF NOT EXISTS loss_horizon_hours       smallint,
  ADD COLUMN IF NOT EXISTS set_to_first_pick_days   smallint,
  ADD COLUMN IF NOT EXISTS harvest_season_start_doy smallint,
  ADD COLUMN IF NOT EXISTS harvest_season_end_doy   smallint;

-- Enum vocab for harvest_habit. text + CHECK rather than a native Postgres ENUM, matching the
-- house convention set by v4-putup-001 (ALTER TYPE cannot run in a txn alongside other DDL and
-- enum values cannot be cleanly removed).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_crop_types_harvest_habit') THEN
    ALTER TABLE public.crop_types ADD CONSTRAINT chk_crop_types_harvest_habit
      CHECK (harvest_habit IS NULL OR harvest_habit IN ('single','repeat','cut_and_come_again')) NOT VALID;
  END IF;
END $$;

-- repeat_interval_days is only meaningful for a repeat-picked crop. A 'single' crop carrying an
-- interval is a data error (it would make a one-shot harvest nag forever), so the pair is
-- constrained rather than merely documented. NULL habit imposes nothing.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_crop_types_repeat_interval') THEN
    ALTER TABLE public.crop_types ADD CONSTRAINT chk_crop_types_repeat_interval
      CHECK (
        (repeat_interval_days IS NULL OR repeat_interval_days BETWEEN 1 AND 365)
        AND NOT (harvest_habit = 'single' AND repeat_interval_days IS NOT NULL)
      ) NOT VALID;
  END IF;
END $$;

-- Positive-hours sanity. Upper bound 8760 (one year) — anything longer is not a "loss horizon",
-- it is a storage figure, and belongs to the put-up surface (preservation_log.use_by_target).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_crop_types_loss_horizon') THEN
    ALTER TABLE public.crop_types ADD CONSTRAINT chk_crop_types_loss_horizon
      CHECK (loss_horizon_hours IS NULL OR loss_horizon_hours BETWEEN 1 AND 8760) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_crop_types_set_to_first_pick') THEN
    ALTER TABLE public.crop_types ADD CONSTRAINT chk_crop_types_set_to_first_pick
      CHECK (set_to_first_pick_days IS NULL OR set_to_first_pick_days BETWEEN 1 AND 365) NOT VALID;
  END IF;
END $$;

-- DOY window: both bounds present or both absent (a half-window is uninterpretable — is it an
-- open start or an open end?), each in 1..366 (366 admits leap-year Dec 31). start > end is
-- PERMITTED and means a wrap-around window (e.g. a Nov->Feb overwintered crop); readers must
-- handle the wrap rather than assume start <= end.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_crop_types_harvest_season_doy') THEN
    ALTER TABLE public.crop_types ADD CONSTRAINT chk_crop_types_harvest_season_doy
      CHECK (
        (harvest_season_start_doy IS NULL) = (harvest_season_end_doy IS NULL)
        AND (harvest_season_start_doy IS NULL OR harvest_season_start_doy BETWEEN 1 AND 366)
        AND (harvest_season_end_doy   IS NULL OR harvest_season_end_doy   BETWEEN 1 AND 366)
      ) NOT VALID;
  END IF;
END $$;

-- Partial index over the live, seeded rows. The readiness reads all start "which crop types have a
-- habit at all?" — a 114-row table does not need this for speed, but it makes the seeded/unseeded
-- split explicit and cheap to count for the coverage report.
CREATE INDEX IF NOT EXISTS idx_crop_types_harvest_habit
  ON public.crop_types (harvest_habit)
  WHERE deleted_at IS NULL AND harvest_habit IS NOT NULL;

INSERT INTO public.schema_version (version, description)
VALUES ('4.15.0-harvattr-001','HARVATTR: crop_types +harvest_habit(text,CHECK single/repeat/cut_and_come_again)/+repeat_interval_days/+loss_horizon_hours/+set_to_first_pick_days/+harvest_season_start_doy/+harvest_season_end_doy (all smallint, all nullable, no defaults). CHECKs added NOT VALID: habit vocab, repeat-interval 1..365 + not-on-single, loss-horizon 1..8760, set-to-first-pick 1..365, DOY both-or-neither 1..366 (wrap-around allowed). Partial index on seeded live rows. NULL = UNKNOWN = predicate must not fire. Additive; no existing column/constraint/view touched.')
ON CONFLICT (version) DO NOTHING;
