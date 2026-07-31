-- 0a-additive-ddl.sql
-- V4-CAL1-PERVARIETY-001 — per-VARIETY (cultivar) harvest-weight substrate (crucible-hardened V100).
--
-- SEQUEL to v4-cal1-harvweight-001 (per-crop-type grams). Dave's pivot: grams keyed per-VARIETY,
-- fed by an append-only measurement LOG that converges as samples accumulate; NEVER a guessed factor
-- (a wrong number silently corrupts multi-season yield comparison — NULL beats a guess). Canonical
-- design: Projects/Gardening/cal1-per-variety-weight-architecture-V100-20260730.md.
--
-- HARD DEPENDENCY: v4-cal1-harvweight-001/0a MUST already be applied here — the weight_basis CHECK
--   below references harvest_log.weight_estimated (created by that migration). gates.yml pre-checks
--   REQUIRE weight_estimated present. (Verified present on prod ep-lucky-bird 2026-07-30.)
--
-- WHAT THIS ADDS (all additive, idempotent, no existing column/constraint/view/data touched):
--   cultivar_weight_sample      — append-only RAW measurement log (total_grams + unit_count, NOT a
--                                 pre-divided ratio, so the derived value is auditable + count-weighted)
--   cultivar_weight_void        — correction ledger; a mis-typed sample is VOIDED by appending here
--                                 (the sample table itself is strictly immutable — trigger below)
--   crop_types.variety_grams_required (bool, DEFAULT true) — high-variance crops NULL-out the crop-type
--                                 fallback (no guess); low-variance crops set false in 0b
--   harvest_log.weight_basis    — provenance of a stored weight: 'measured' only under the on-read model
--                                 (estimates are computed on-read, never stored); tied to the existing
--                                 weight_grams/weight_estimated pair by CHECKs
--   cultivar_weight_derived (VIEW) — the SINGLE aggregation locus: per (cultivar,unit) count-weighted
--                                 pooled ratio SUM(total_grams)/SUM(unit_count) over NON-voided samples,
--                                 dispersion (CV), min-n(=2) gate, confidence tier. One row per
--                                 (cultivar_id,unit) (GROUP BY) so a LEFT JOIN cannot multiply rows.
--
-- ON-READ MODEL (why no weight_grams backfill): harvest_log.weight_grams stores MEASURED grams only
--   (unit g/kg/lb/oz); ESTIMATED grams are computed on-read by joining cultivar_weight_derived. So the
--   255 existing non-weight rows need NO backfill — their estimate is a live view read.
--
-- NULL SEMANTICS (load-bearing): a cultivar with < min-n samples AND variety_grams_required=true yields
--   NO estimate (NULL) — never a crop-type substitute. total_grams/unit_count take NO default and are
--   never guessed.
--
-- SAFETY: ADD COLUMN IF NOT EXISTS (nullable/defaulted-safe), CREATE TABLE IF NOT EXISTS, CHECKs added
--   NOT VALID (validated in 0c), CREATE OR REPLACE for fn/view, DROP TRIGGER IF EXISTS before CREATE,
--   schema_version ON CONFLICT DO NOTHING. Re-running is a clean no-op. NOT applied by the authoring
--   session — Dave-gated, STAGING first (so integration-test.yml, which branches off staging, sees the
--   objects), then PROD. Take a CTAS snapshot of crop_types + harvest_log before 0b (see 0r).

-- ── append-only RAW sample log ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cultivar_weight_sample (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cultivar_id uuid NOT NULL REFERENCES public.cultivar(id) ON DELETE RESTRICT,
  unit        text NOT NULL,
  total_grams numeric NOT NULL,   -- RAW numerator: grams of unit_count items weighed together
  unit_count  numeric NOT NULL,   -- RAW denominator: how many units were on the scale
  sampled_at  timestamptz NOT NULL,
  seed_batch  text,               -- batch idempotency key (re-applying a batch does not double-insert)
  note        text,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_cws_unit_vocab') THEN
    ALTER TABLE public.cultivar_weight_sample ADD CONSTRAINT chk_cws_unit_vocab
      CHECK (unit IN ('lb','oz','kg','g','count','bunch','cup','head')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_cws_total_grams_pos') THEN
    ALTER TABLE public.cultivar_weight_sample ADD CONSTRAINT chk_cws_total_grams_pos
      CHECK (total_grams > 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_cws_unit_count_pos') THEN
    ALTER TABLE public.cultivar_weight_sample ADD CONSTRAINT chk_cws_unit_count_pos
      CHECK (unit_count > 0) NOT VALID;
  END IF;
END $$;

-- ── correction ledger (voids) ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cultivar_weight_void (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sample_id  uuid NOT NULL REFERENCES public.cultivar_weight_sample(id),
  reason     text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cws_void_sample_id ON public.cultivar_weight_void(sample_id);

-- ── strict immutability: the sample log is append-only; corrections go to the void ledger ───────────
CREATE OR REPLACE FUNCTION public.cal1_sample_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'cultivar_weight_sample is append-only (attempted %); correct a sample by appending to cultivar_weight_void, never UPDATE/DELETE', TG_OP;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_cws_immutable ON public.cultivar_weight_sample;
CREATE TRIGGER trg_cws_immutable
  BEFORE UPDATE OR DELETE ON public.cultivar_weight_sample
  FOR EACH ROW EXECUTE FUNCTION public.cal1_sample_immutable();

-- ── crop-type fallback gate (high-variance crops null-out; 0b sets low-variance to false) ───────────
ALTER TABLE public.crop_types
  ADD COLUMN IF NOT EXISTS variety_grams_required boolean NOT NULL DEFAULT true;

-- ── harvest_log provenance ──────────────────────────────────────────────────────────────────────────
ALTER TABLE public.harvest_log
  ADD COLUMN IF NOT EXISTS weight_basis text;

DO $$ BEGIN
  -- value domain (NULL-guarded, matching the house pattern — a bare IN() would reject the 255 NULL rows)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_harvest_log_weight_basis') THEN
    ALTER TABLE public.harvest_log ADD CONSTRAINT chk_harvest_log_weight_basis
      CHECK (weight_basis IS NULL OR weight_basis IN ('measured','cultivar','crop_type')) NOT VALID;
  END IF;
  -- basis present IFF a weight is present (extends the 0a both-or-neither pairing to a triple)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_harvest_log_weight_basis_pairing') THEN
    ALTER TABLE public.harvest_log ADD CONSTRAINT chk_harvest_log_weight_basis_pairing
      CHECK ((weight_grams IS NULL) = (weight_basis IS NULL)) NOT VALID;
  END IF;
  -- estimated flag consistent with basis: measured<=>false, cultivar/crop_type<=>true
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_harvest_log_weight_basis_estimated') THEN
    ALTER TABLE public.harvest_log ADD CONSTRAINT chk_harvest_log_weight_basis_estimated
      CHECK (weight_basis IS NULL OR weight_estimated = (weight_basis <> 'measured')) NOT VALID;
  END IF;
END $$;

-- ── the SINGLE aggregation locus (on-read; count-weighted; min-n=2; dispersion confidence) ──────────
CREATE OR REPLACE VIEW public.cultivar_weight_derived AS
WITH live AS (
  SELECT s.cultivar_id, s.unit, s.total_grams, s.unit_count,
         (s.total_grams / s.unit_count) AS per_unit    -- per-sample ratio, for dispersion only
    FROM public.cultivar_weight_sample s
   WHERE NOT EXISTS (SELECT 1 FROM public.cultivar_weight_void v WHERE v.sample_id = s.id)
)
SELECT
  cultivar_id,
  unit,
  SUM(total_grams) / SUM(unit_count)                          AS grams_per_unit,  -- count-weighted pooled ratio
  COUNT(*)                                                    AS sample_n,
  SUM(unit_count)                                             AS total_units,
  CASE WHEN COUNT(*) >= 2 AND AVG(per_unit) > 0
       THEN STDDEV_SAMP(per_unit) / AVG(per_unit) END         AS cv,              -- coefficient of variation
  (COUNT(*) >= 2)                                             AS usable_for_comparison,  -- min-n gate (min-n=2)
  CASE
    WHEN COUNT(*) < 2 THEN 'provisional'
    WHEN STDDEV_SAMP(per_unit) / NULLIF(AVG(per_unit), 0) <= 0.15 THEN 'high'
    WHEN STDDEV_SAMP(per_unit) / NULLIF(AVG(per_unit), 0) <= 0.35 THEN 'medium'
    ELSE 'low'
  END                                                         AS confidence
FROM live
GROUP BY cultivar_id, unit;

INSERT INTO public.schema_version (version, description)
VALUES ('4.18.0-cal1-pervariety-001','CAL-1 per-variety: cultivar_weight_sample (append-only RAW total_grams+unit_count, immutability trigger) + cultivar_weight_void (correction ledger) + crop_types.variety_grams_required(bool DEFAULT true) + harvest_log.weight_basis(text, 3 NULL-guarded CHECKs vs weight_grams/weight_estimated) + cultivar_weight_derived VIEW (per-(cultivar,unit) count-weighted pooled ratio, min-n=2, dispersion confidence). Estimates on-read; no weight_grams backfill. Depends on v4-cal1-harvweight-001/0a. Additive; nothing existing touched.')
ON CONFLICT (version) DO NOTHING;
