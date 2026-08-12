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
-- planting was added"). This file uses the household's OWN median instead when it has >= 5
-- dual-dated plantings, falling back to 7 — the same pattern as watch.js's nursery offset, and it
-- records which one it used in offset_source. On live prod today Dave's median is +9 over 112
-- samples. The reason the median is used rather than the stated 7 is that the offset should track
-- HIS data as it accumulates; pinning the number in a backfill file freezes a 2026 estimate into
-- every future run. Either way the spread swamps the point estimate — 47.3% within a week — so the
-- choice between 7 and 9 changes far less than the label on the result does.
--
-- WHAT IT WILL WRITE, measured read-only against prod 2026-08-12 (household = Dave; Jen has zero
-- live plantings): 64 rows, of which 0 sow_event, 0 transplant_event, 7 nursery_proxy_event and
-- 57 add_date_baseline, with 3 future baselines clamped to today. Run 0c check 4 after applying and
-- confirm those proportions before believing anything downstream.
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
  SELECT p.id            AS plant_id,
         pj.created_by   AS user_id,
         (p.created_at AT TIME ZONE prm.tz)::date AS add_date
    FROM public.plants p
    JOIN public.plant_projects pj ON pj.id = p.project_id
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
  SELECT t.user_id,
         CASE WHEN o.sample_n >= prm.offset_min_sample THEN o.median_days ELSE prm.stated_offset_days END AS days,
         CASE WHEN o.sample_n >= prm.offset_min_sample THEN 'household_median' ELSE 'stated_baseline' END AS src,
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
  SELECT t.plant_id, t.user_id, prm.model_version,
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
INSERT INTO public.plant_anchor_derivation
  (user_id, plant_id, anchor_date, anchor_field, source, confidence, model_version,
   evidence_date, offset_days, offset_source, offset_sample_n, clamped_to_today, derived_on)
SELECT c.user_id, c.plant_id, c.anchor_date, c.anchor_field, c.source, c.confidence, c.model_version,
       c.evidence_date, c.offset_days, c.offset_source, c.offset_sample_n, c.clamped_to_today, c.today
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
