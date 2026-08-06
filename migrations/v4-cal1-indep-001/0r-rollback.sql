-- 0r-rollback.sql
-- V4-CAL1INDEP-001 — restore resolve_harvest_weight v4 and cultivar_weight_derived v2.
--
-- ORDER IS FORCED AND IS THE INVERSE OF THE APPLY. The v5 function references d.independent_n; the
-- v2 view does not have that column. Dropping the column first would leave a function whose body no
-- longer resolves (42703 at execute time, i.e. every harvest save failing). So: function back to v4
-- FIRST, view back to v2 SECOND. This file does both, in that order, in ONE transaction — a partial
-- rollback is the only genuinely dangerous state here, so it is made unreachable.
--
-- WHAT COMES BACK. v2 confidence is COUNT(*)/STDDEV_SAMP only, so duplicate rows again read 'high'
-- and again override the curated reference. That is the defect, restored deliberately — this file
-- exists to unblock, not to be correct. Re-apply 0a+0b as soon as the blocking issue is understood.
--
-- WHAT DOES NOT COME BACK, AND DOES NOT NEED TO. Nothing was migrated: no row, column, constraint
-- or gram value was written by 0a/0b. cultivar_weight_sample and cultivar_weight_void are untouched
-- by the whole migration, so no measurement can be lost by rolling back. Stored harvest_log weights
-- are likewise untouched — this migration never re-derives them; that is the ratchet's job
-- (scripts/harvest-weight-ratchet.sh), which is separately gated and snapshots before it applies.
-- If the ratchet HAS been run against v3/v5 factors, roll THAT back from its own snapshot table
-- first; this file will not do it and cannot infer it.
--
-- The schema_version markers are removed so a re-apply is detectable, and so the gates in
-- gates.yml (which key on those versions) do not report an applied state that is no longer true.

BEGIN;

-- ── step 1: resolve_harvest_weight back to v4 (promotes on raw sample_n) ─────────────────────────
CREATE OR REPLACE FUNCTION public.resolve_harvest_weight(
  p_plant_id   uuid,
  p_unit       text,
  p_qty        numeric,
  p_user_grams numeric DEFAULT NULL::numeric
)
RETURNS TABLE(weight_grams numeric, weight_estimated boolean, weight_basis text)
LANGUAGE sql
STABLE
AS $function$
  SELECT
    CASE
      WHEN p_user_grams IS NOT NULL THEN p_user_grams
      WHEN p_unit IN ('g','kg','lb','oz') THEN p_qty * CASE p_unit
             WHEN 'g'  THEN 1
             WHEN 'kg' THEN 1000
             WHEN 'lb' THEN 453.592
             WHEN 'oz' THEN 28.3495
           END
      ELSE p_qty * f.factor
    END AS weight_grams,
    CASE
      WHEN p_user_grams IS NOT NULL       THEN false
      WHEN p_unit IN ('g','kg','lb','oz') THEN false
      WHEN f.factor IS NOT NULL           THEN true
      ELSE NULL
    END AS weight_estimated,
    CASE
      WHEN p_user_grams IS NOT NULL       THEN 'measured'
      WHEN p_unit IN ('g','kg','lb','oz') THEN 'measured'
      ELSE f.basis
    END AS weight_basis
  FROM (SELECT 1) AS anchor
  LEFT JOIN public.plants pl              ON pl.id   = p_plant_id       AND pl.deleted_at IS NULL
  LEFT JOIN public.plant_varieties v      ON v.id    = pl.variety_id    AND v.deleted_at IS NULL
  LEFT JOIN public.crop_types ct          ON ct.slug = v.crop_type_slug AND ct.deleted_at IS NULL
  LEFT JOIN public.cultivar_weight_derived d ON d.cultivar_id = v.id AND d.unit = p_unit
  CROSS JOIN LATERAL (
    SELECT COALESCE(d.confidence IN ('high','medium') OR d.sample_n >= 5, false) AS corroborated
  ) c
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN c.corroborated AND d.grams_per_unit IS NOT NULL          THEN 3
      WHEN (v.unit_weights ->> p_unit) IS NOT NULL                  THEN 4
      WHEN d.grams_per_unit IS NOT NULL                             THEN 5
      WHEN NOT COALESCE(ct.variety_grams_required, true)
           AND (ct.unit_weights ->> p_unit) IS NOT NULL             THEN 6
    END AS tier
  ) t
  CROSS JOIN LATERAL (
    SELECT
      CASE t.tier
        WHEN 3 THEN d.grams_per_unit
        WHEN 4 THEN (v.unit_weights ->> p_unit)::numeric
        WHEN 5 THEN d.grams_per_unit
        WHEN 6 THEN (ct.unit_weights ->> p_unit)::numeric
      END AS factor,
      CASE t.tier
        WHEN 3 THEN 'cultivar_sample'
        WHEN 4 THEN 'cultivar'
        WHEN 5 THEN 'cultivar_sample'
        WHEN 6 THEN 'crop_type'
      END AS basis
  ) f
$function$;

COMMENT ON FUNCTION public.resolve_harvest_weight(uuid, text, numeric, numeric) IS
  'CAL-1 single weight-derivation locus (v4). Order: user grams > weight-unit quantity > '
  'cultivar_weight_derived WHEN corroborated (confidence high/medium, i.e. sample_n>=2, OR '
  'sample_n>=5) > plant_varieties.unit_weights (curated reference) > cultivar_weight_derived '
  'provisional (n=1, only where no curated reference exists) > crop_types.unit_weights (gated on '
  'variety_grams_required) > NULL. Ranking is IDENTICAL to v3 and no gram value changed. v4 splits '
  'the basis vocabulary only: the two SAMPLE-backed tiers (3 and 5) now report ''cultivar_sample'' '
  'while the CURATED catalogue tier (4) keeps ''cultivar'', so provenance is legible downstream. '
  'Tier is resolved once and both factor and basis are projections of it, so basis can no longer '
  'disagree with the number it labels. Returns (weight_grams, weight_estimated, weight_basis) '
  'together so the harvest_log weight CHECKs hold by construction.';

-- ── step 2: the review queue goes away with the guard that populated its rationale ───────────────
DROP VIEW IF EXISTS public.cultivar_weight_crossunit_suspect;

-- ── step 3: cultivar_weight_derived back to v2 (v4-cal1-slicec-001/0f) ───────────────────────────
-- DROP+CREATE, not CREATE OR REPLACE: removing the two appended columns is a narrowing, which
-- CREATE OR REPLACE VIEW refuses. Safe here because the view has no dependents (verified against
-- live pg_depend) — if that ever changes, this step needs CASCADE and a re-create of the dependents.
DROP VIEW IF EXISTS public.cultivar_weight_derived;

CREATE VIEW public.cultivar_weight_derived AS
WITH live AS (
  SELECT s.cultivar_id, s.unit, s.total_grams, s.unit_count,
         (s.total_grams / s.unit_count) AS per_unit
    FROM public.cultivar_weight_sample s
   WHERE NOT EXISTS (SELECT 1 FROM public.cultivar_weight_void v WHERE v.sample_id = s.id)
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

DELETE FROM public.schema_version
 WHERE version IN ('4.23.0-cal1-indep-001','4.23.1-cal1-indep-001-resolver-v5');

COMMIT;
