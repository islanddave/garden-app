-- 0f-autocapture.sql
-- V4-HARVDUAL-001 Slice C — turn every dual count+weight harvest into a calibration sample.
--
-- This is the payoff of the whole feature: "5 San Marzano, 337 g" IS 67.4 g/fruit for that variety.
-- Capturing it automatically is what retires the reference-estimate tier one variety at a time, with
-- no effort from Dave beyond putting the bowl on the scale.
--
-- WHY A FUNCTION AND NOT A CTE IN THE LAMBDA. Auto-capture is not a plain INSERT — an EDIT to a
-- harvest has to *correct* the sample it previously produced, and cultivar_weight_sample is strictly
-- append-only (immutability trigger). The correction protocol is therefore void-then-append, and it
-- must behave identically from the create path and the edit path. Expressing that twice in
-- hand-written CTEs is the exact drift that BUG-HARVESTEDIT-001 and harvweight-002 both exist to
-- prevent, so it lives here once.
--
-- REPEAT-SAVE SAFETY (the subtle one). Editing a harvest's quality star re-sends the same weight. A
-- naive insert would append an identical sample every save. The pooled ratio would not move —
-- 337/5 and 674/10 are the same number — but sample_n would inflate and CV would collapse to 0,
-- so cultivar_weight_derived would report 'high' confidence for what is really ONE weighing. The
-- no-op guard below (identical live sample => return early) is what keeps the confidence tier
-- honest; it is a data-integrity guard, not an optimisation.
--
-- SOFT-DELETE: a sample whose source harvest is later undone must stop counting. Rather than hook
-- the delete path, cultivar_weight_derived now anti-joins soft-deleted source events — one place,
-- and it cannot be forgotten by a future caller.
--
-- SAFETY: additive column + index, CREATE OR REPLACE on the view and the two functions. No existing
-- row rewritten. Re-runnable.

-- ── link a sample back to the harvest that produced it ──────────────────────────────────────────
ALTER TABLE public.cultivar_weight_sample
  ADD COLUMN IF NOT EXISTS source_event_id uuid REFERENCES public.event_log(id);

CREATE INDEX IF NOT EXISTS idx_cws_source_event
  ON public.cultivar_weight_sample(source_event_id) WHERE source_event_id IS NOT NULL;

-- ── void every live sample produced by one harvest event ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.void_event_weight_samples(
  p_event_id uuid, p_user text, p_reason text
) RETURNS integer LANGUAGE sql AS $$
  WITH voided AS (
    INSERT INTO public.cultivar_weight_void (sample_id, reason, created_by)
    SELECT s.id, p_reason, p_user
      FROM public.cultivar_weight_sample s
     WHERE s.source_event_id = p_event_id
       AND NOT EXISTS (SELECT 1 FROM public.cultivar_weight_void v WHERE v.sample_id = s.id)
    RETURNING 1
  )
  SELECT count(*)::integer FROM voided;
$$;

-- ── record (or correct) the calibration sample for one harvest ──────────────────────────────────
-- Returns the new sample id, or NULL when this harvest cannot calibrate anything.
CREATE OR REPLACE FUNCTION public.record_harvest_weight_sample(
  p_event_id uuid, p_plant_id uuid, p_unit text, p_qty numeric, p_grams numeric, p_user text
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_cultivar uuid;
  v_id       uuid;
BEGIN
  -- A weight-UNIT harvest ("3 lb") carries no count, so there is no grams-per-item ratio to learn.
  -- No weight, or no count, likewise. In all three cases any sample this event produced earlier is
  -- now wrong and must be retired.
  IF p_grams IS NULL OR p_grams <= 0
     OR p_qty IS NULL OR p_qty <= 0
     OR p_unit IN ('g','kg','lb','oz') THEN
    PERFORM public.void_event_weight_samples(
      p_event_id, p_user, 'source harvest no longer carries both a count and a weight');
    RETURN NULL;
  END IF;

  -- An unattributed harvest (no planting, or a planting with no variety) has nothing to calibrate.
  SELECT v.id INTO v_cultivar
    FROM public.plants pl
    JOIN public.plant_varieties v ON v.id = pl.variety_id AND v.deleted_at IS NULL
   WHERE pl.id = p_plant_id AND pl.deleted_at IS NULL;
  IF v_cultivar IS NULL THEN
    RETURN NULL;
  END IF;

  -- Unchanged re-save: leave the existing sample alone. See the header — appending a duplicate
  -- would inflate sample_n and fake up the confidence tier.
  IF EXISTS (
    SELECT 1 FROM public.cultivar_weight_sample s
     WHERE s.source_event_id = p_event_id
       AND s.unit = p_unit AND s.total_grams = p_grams AND s.unit_count = p_qty
       AND NOT EXISTS (SELECT 1 FROM public.cultivar_weight_void v WHERE v.sample_id = s.id)
  ) THEN
    RETURN NULL;
  END IF;

  PERFORM public.void_event_weight_samples(
    p_event_id, p_user, 'superseded by an edit to the source harvest');

  INSERT INTO public.cultivar_weight_sample
    (cultivar_id, unit, total_grams, unit_count, sampled_at, note, created_by, source_event_id)
  SELECT v_cultivar, p_unit, p_grams, p_qty, e.event_date,
         'auto-captured: harvest logged with both a count and a weight', p_user, p_event_id
    FROM public.event_log e WHERE e.id = p_event_id
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

-- ── derived view: also drop samples whose source harvest was undone ─────────────────────────────
CREATE OR REPLACE VIEW public.cultivar_weight_derived AS
WITH live AS (
  SELECT s.cultivar_id, s.unit, s.total_grams, s.unit_count,
         (s.total_grams / s.unit_count) AS per_unit
    FROM public.cultivar_weight_sample s
   WHERE NOT EXISTS (SELECT 1 FROM public.cultivar_weight_void v WHERE v.sample_id = s.id)
     -- a sample from a soft-deleted harvest must stop counting; handled here so no caller can forget
     AND NOT EXISTS (
       SELECT 1 FROM public.event_log e
        WHERE e.id = s.source_event_id AND e.deleted_at IS NOT NULL)
)
SELECT
  cultivar_id,
  unit,
  SUM(total_grams) / SUM(unit_count)                          AS grams_per_unit,
  COUNT(*)                                                    AS sample_n,
  SUM(unit_count)                                             AS total_units,
  CASE WHEN COUNT(*) >= 2 AND AVG(per_unit) > 0
       THEN STDDEV_SAMP(per_unit) / AVG(per_unit) END         AS cv,
  (COUNT(*) >= 2)                                             AS usable_for_comparison,
  CASE
    WHEN COUNT(*) < 2 THEN 'provisional'
    WHEN STDDEV_SAMP(per_unit) / NULLIF(AVG(per_unit), 0) <= 0.15 THEN 'high'
    WHEN STDDEV_SAMP(per_unit) / NULLIF(AVG(per_unit), 0) <= 0.35 THEN 'medium'
    ELSE 'low'
  END                                                         AS confidence
FROM live
GROUP BY cultivar_id, unit;

INSERT INTO public.schema_version (version, description)
VALUES ('4.20.3-cal1-slicec-autocapture-001','V4-HARVDUAL-001 Slice C: cultivar_weight_sample.source_event_id + record_harvest_weight_sample()/void_event_weight_samples() — a harvest logged with BOTH a count and a weight auto-appends a calibration sample; an edit voids-and-replaces it (append-only correction protocol); an unchanged re-save is a no-op so sample_n and the confidence tier stay honest. cultivar_weight_derived now also excludes samples from soft-deleted harvests.')
ON CONFLICT (version) DO NOTHING;
