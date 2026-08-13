-- 0b-backfill.sql
-- V4-ANCHORBASE-001 — populate public.plant_anchor_derivation.
--
-- ⛔ AUTHORED, NOT APPLIED. Not run on staging, not run on prod, not run anywhere. It is checked in
-- unapplied on purpose: the measurement below says 89% of what it would write is a baseline guess,
-- and that is Dave's call to make before any of it feeds a surface.
--
-- THIS FILE WRITES TO EXACTLY ONE RELATION: public.plant_anchor_derivation. It does not UPDATE
-- public.plants, does not touch sown_at / transplanted_at / planted_out_at, and does not fire the
-- four row-level UPDATE triggers on plants (see 0a's header). Verified by 0c check 5.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE PRECEDENCE, AS BD-001a SPECIFIES IT
--   1. sow event         (event_log 'sowing' | 'seed_soak')                     -> stands in for sown_at
--   2. transplant event  (event_log 'transplant')                               -> transplanted_at
--   2b. nursery proxy    ('potting_up' | 'hardening_off' | 'brought_outside')   -> transplanted_at
--   3. add-date baseline (plants.created_at + offset)                           -> transplanted_at
--
-- Tier 2b is an ADDITION to Dave's three, and it is not a transplant. It is an event proving the
-- planting physically existed and was being handled on that date, which is strictly better evidence
-- than the add-date and strictly worse than a transplant. It is stored under its own `source` and
-- `confidence='proxy'` so a consumer can drop it in one predicate.
--
-- THE OFFSET. Dave specified +7 (BD0806-27: "transplant happened within a week of the date the
-- planting was added"). ── OFFSET DECISION REVERSED 2026-08-12 (pre-apply expert consult): this
-- file originally preferred the household MEDIAN (>= 5 dual-dated samples, +9 on live prod today)
-- over the stated +7, on the "track HIS data" rationale, believing "the spread swamps the point
-- estimate" so the choice barely mattered. The data-analytics seat MEASURED that and it is false:
-- an offset sweep over the same 112 dual-dated plantings scores hit-rate-within-±7d as
--   +7 -> 77/112 (68.8%)   +5/+6 -> 73   +4 -> 68   ...   +9 (the median) -> 52/112 (46.4%)
-- i.e. the median is the measured WORST candidate in range, because the delta distribution is
-- right-skewed with a 0-1-day spike (26/112 = plantings entered at the moment of transplant), a
-- subpopulation DEFINITIONALLY ABSENT from the anchorless targets this file predicts for. The
-- median chases that spike's complement; the argmax does not. So: stated +7, always, and
-- offset_source records 'stated_baseline'. Revisit ONLY via a time-split validation (fit before
-- 2026-06-15, score after) once this table's own prospective labels accrue — which is exactly the
-- measurement this backfill exists to create. (Also note: the widely-quoted "47.3% within a week"
-- grades an offset-ZERO model — neither the +7 shipped here nor the +9 the median would have
-- written. Do not reuse that number as this model's accuracy.)
--
-- WHAT IT WILL WRITE, re-measured read-only against prod 2026-08-12 LATE (population drifted since
-- authoring; household = Dave, Jen has zero live plantings): 66 rows — 0 sow_event, 0
-- transplant_event, 7 nursery_proxy_event, 59 add_date_baseline, 5 clamped to today (at +9; expect
-- ~4 at +7). Re-measure at apply time rather than trusting either census; 0c check 4's printed
-- expectation is advisory, not an assertion.
--
-- IDEMPOTENT. Re-running supersedes nothing and inserts nothing for a planting that already has a
-- live derivation (the partial unique index is the backstop; the NOT EXISTS is the intent).

BEGIN;

-- Guard: refuse to run against an environment where the marking rule has already been violated —
-- i.e. where somebody wrote a derived date into an observed column. Cheap, and it fails the whole
-- transaction rather than compounding the problem.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.plant_anchor_derivation d
      JOIN public.plants p ON p.id = d.plant_id
     WHERE d.superseded_at IS NULL
       AND (p.sown_at IS NOT NULL OR p.transplanted_at IS NOT NULL OR p.planted_out_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'live derivations exist for plantings that now have an observed anchor — run the supersede step first';
  END IF;
END $$;

WITH params AS (
  SELECT 'America/New_York'::text AS tz,
         'anchor-derive-v1'::text AS model_version,
         7::int                   AS stated_offset_days,
         5::int                   AS offset_min_sample
),
-- Every live planting with no anchor of its own. Live = the definition lambda/harvests/watch-route.js
-- settled on: not deleted, not archived, project not deleted/archived, status not in the dead set.
target AS (
  -- user_id = plant_projects.created_by (the HOUSEHOLD owner), deliberately — 13 of the live
  -- targets carry plants.created_by = a data-import pseudo-user ('rescue-intake-…'); derivations
  -- serve per-household lookups (idx_plant_anchor_derivation_user_live), so project-owner
  -- attribution is the intended semantics. (Consult 2026-08-12, regression seat condition 3.)
  SELECT p.id            AS plant_id,
         pj.created_by   AS user_id,
         (p.created_at AT TIME ZONE prm.tz)::date AS add_date,
         p.name          AS plant_name,
         p.status        AS plant_status,
         v.days_to_maturity_min AS dtm_min
    FROM public.plants p
    JOIN public.plant_projects pj ON pj.id = p.project_id
    LEFT JOIN public.plant_varieties v ON v.id = p.variety_id
    CROSS JOIN params prm
   WHERE p.deleted_at IS NULL
     AND p.archived_at IS NULL
     AND pj.deleted_at IS NULL
     AND pj.archived_at IS NULL
     AND (p.status IS NULL OR p.status NOT IN ('failed', 'ended', 'dormant'))
     AND p.sown_at IS NULL
     AND p.transplanted_at IS NULL
     AND p.planted_out_at IS NULL
),
-- Per-household offset from that household's own dual-dated plantings. percentile_disc, not
-- percentile_cont: the result must be a whole number of days that a real planting actually
-- exhibited, not an interpolated half-day nobody experienced.
offsets AS (
  SELECT pj.created_by AS user_id,
         count(*)::int AS sample_n,
         percentile_disc(0.5) WITHIN GROUP (
           ORDER BY (p.transplanted_at - (p.created_at AT TIME ZONE prm.tz)::date)
         )::int AS median_days
    FROM public.plants p
    JOIN public.plant_projects pj ON pj.id = p.project_id
    CROSS JOIN params prm
   WHERE p.deleted_at IS NULL AND pj.deleted_at IS NULL
     AND p.transplanted_at IS NOT NULL
   GROUP BY pj.created_by
),
resolved_offset AS (
  -- ALWAYS the stated +7 (consult 2026-08-12: in-sample argmax 68.8% vs the household median's
  -- 46.4% — see header). sample_n still recorded so the provenance shows how much dual-dated data
  -- existed when the choice was made; the offsets CTE is retained for that count alone.
  SELECT t.user_id,
         prm.stated_offset_days AS days,
         'stated_baseline'::text AS src,
         coalesce(o.sample_n, 0) AS sample_n
    FROM (SELECT DISTINCT user_id FROM target) t
    CROSS JOIN params prm
    LEFT JOIN offsets o ON o.user_id = t.user_id
),
evidence AS (
  SELECT t.plant_id,
         min((e.event_date AT TIME ZONE prm.tz)::date) FILTER (WHERE e.event_type IN ('sowing', 'seed_soak'))     AS sow_date,
         min((e.event_date AT TIME ZONE prm.tz)::date) FILTER (WHERE e.event_type = 'transplant')                 AS transplant_date,
         min((e.event_date AT TIME ZONE prm.tz)::date) FILTER (
           WHERE e.event_type IN ('potting_up', 'hardening_off', 'brought_outside'))                              AS proxy_date
    FROM target t
    CROSS JOIN params prm
    LEFT JOIN public.event_log e ON e.plant_id = t.plant_id AND e.deleted_at IS NULL
   GROUP BY t.plant_id
),
-- First tier whose evidence is present wins. This CASE ladder IS the precedence; it mirrors
-- deriveAnchor() in lambda/harvests/anchorDerive.js and the two must not drift.
derived AS (
  SELECT t.plant_id, t.user_id, prm.model_version, t.plant_name, t.plant_status, t.dtm_min,
         CASE WHEN ev.sow_date        IS NOT NULL THEN 'sow_event'
              WHEN ev.transplant_date IS NOT NULL THEN 'transplant_event'
              WHEN ev.proxy_date      IS NOT NULL THEN 'nursery_proxy_event'
              ELSE 'add_date_baseline' END AS source,
         CASE WHEN ev.sow_date        IS NOT NULL THEN 'event'
              WHEN ev.transplant_date IS NOT NULL THEN 'event'
              WHEN ev.proxy_date      IS NOT NULL THEN 'proxy'
              ELSE 'baseline' END AS confidence,
         CASE WHEN ev.sow_date IS NOT NULL THEN 'sown_at' ELSE 'transplanted_at' END AS anchor_field,
         coalesce(ev.sow_date, ev.transplant_date, ev.proxy_date, t.add_date) AS evidence_date,
         CASE WHEN coalesce(ev.sow_date, ev.transplant_date, ev.proxy_date) IS NULL
              THEN ro.days ELSE 0 END AS offset_days,
         CASE WHEN coalesce(ev.sow_date, ev.transplant_date, ev.proxy_date) IS NULL
              THEN ro.src ELSE NULL END AS offset_source,
         CASE WHEN coalesce(ev.sow_date, ev.transplant_date, ev.proxy_date) IS NULL
              THEN ro.sample_n ELSE NULL END AS offset_sample_n,
         (now() AT TIME ZONE prm.tz)::date AS today
    FROM target t
    CROSS JOIN params prm
    JOIN evidence ev       ON ev.plant_id = t.plant_id
    JOIN resolved_offset ro ON ro.user_id = t.user_id
   WHERE t.add_date IS NOT NULL
      OR coalesce(ev.sow_date, ev.transplant_date, ev.proxy_date) IS NOT NULL
),
-- A derived anchor dated in the future is not an anchor; it says the planting has not started.
-- Clamped to today and MARKED, never silently dropped — the clamp is information.
clamped AS (
  SELECT d.*,
         least(d.evidence_date + d.offset_days, d.today) AS anchor_date,
         (d.evidence_date + d.offset_days) > d.today     AS clamped_to_today
    FROM derived d
)
-- plausibility (consult 2026-08-12, horticulture seat — see 0a2 for the column):
--   post_frost_impossible wins over rescue_suspect (the stronger objection): even the EARLIEST
--   catalogue maturity (dtm_min) from the derived anchor lands after the 2026-09-28 first-frost
--   anchor. rescue_suspect: the add-date is likely an acquisition date, not a planting date.
INSERT INTO public.plant_anchor_derivation
  (user_id, plant_id, anchor_date, anchor_field, source, confidence, model_version,
   evidence_date, offset_days, offset_source, offset_sample_n, clamped_to_today, derived_on,
   plausibility)
SELECT c.user_id, c.plant_id, c.anchor_date, c.anchor_field, c.source, c.confidence, c.model_version,
       c.evidence_date, c.offset_days, c.offset_source, c.offset_sample_n, c.clamped_to_today, c.today,
       CASE WHEN c.dtm_min IS NOT NULL
              AND c.anchor_date + c.dtm_min > DATE '2026-09-28' THEN 'post_frost_impossible'
            WHEN c.plant_name ILIKE '%rescue%'
              OR c.plant_status IN ('flowering', 'fruiting')    THEN 'rescue_suspect'
            ELSE NULL END
  FROM clamped c
 WHERE NOT EXISTS (
         SELECT 1 FROM public.plant_anchor_derivation x
          WHERE x.plant_id = c.plant_id AND x.superseded_at IS NULL);

COMMIT;

-- ── The supersede step, run on every subsequent execution ────────────────────────────────────────
-- When a real date arrives on a planting, its derivation is retired rather than deleted: the pair
-- (derived guess, later observed truth) is the ONLY ground truth tier 3 will ever get, and deleting
-- it throws away the measurement that says whether add-date+7d is worth keeping.
BEGIN;

UPDATE public.plant_anchor_derivation d
   SET superseded_at = now(),
       superseded_by = 'observed_anchor',
       updated_at    = now()
  FROM public.plants p
 WHERE p.id = d.plant_id
   AND d.superseded_at IS NULL
   AND (p.sown_at IS NOT NULL OR p.transplanted_at IS NOT NULL OR p.planted_out_at IS NOT NULL);

COMMIT;
