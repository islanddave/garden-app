-- measure-anchor-coverage.sql
-- V4-ANCHORBASE-001. READ-ONLY. Emits one JSON array of candidate rows in exactly the shape
-- lambda/harvests/watch-route.js queryWatchRows() returns, plus the derivation evidence
-- (add_date + the sow/transplant/nursery event dates) that lambda/harvests/anchorDerive.js needs.
--
-- Pipe it into scripts/measure-anchor-coverage.mjs, which runs the REAL classifier over these rows.
-- The point of the split is that no number in the lane report is re-derived by hand in SQL: the
-- measurement executes the same module the Lambda executes, so a code change moves the measurement.
--
--   cd ~/AI/Claude/Projects/Gardening \
--     && bash scripts/psql-ro.sh -At -f <repo>/scripts/measure-anchor-coverage.sql \
--     | node <repo>/scripts/measure-anchor-coverage.mjs
--
-- SELECT only. No writes, no DDL, no temp tables. Safe against prod.
--
-- Scope note: this reads EVERY household. Live prod has two users and Jen has zero live plantings,
-- so every figure it prints today is Dave's — do not report them as household averages.

WITH bounds AS (
  SELECT (now() AT TIME ZONE 'America/New_York')::date AS et_today,
         (make_date(
            EXTRACT(YEAR FROM (now() AT TIME ZONE 'America/New_York')::date)::int
              - CASE WHEN EXTRACT(MONTH FROM (now() AT TIME ZONE 'America/New_York')::date)::int >= 11
                     THEN 0 ELSE 1 END,
            11, 1))::date AS season_start
),
picks AS (
  SELECT e.plant_id,
         count(*)::int AS harvest_count,
         MIN((e.event_date AT TIME ZONE 'America/New_York')::date) AS first_pick_date
    FROM event_log e
    LEFT JOIN harvest_log h ON h.event_id = e.id AND h.deleted_at IS NULL
    CROSS JOIN bounds b
   WHERE e.event_type IN ('harvest', 'first_harvest')
     AND e.deleted_at IS NULL AND e.plant_id IS NOT NULL
     AND (h.id IS NOT NULL OR e.event_type = 'first_harvest')
     AND (e.event_date AT TIME ZONE 'America/New_York')::date >= b.season_start
   GROUP BY e.plant_id
),
fruit_set AS (
  SELECT e.plant_id, MAX((e.event_date AT TIME ZONE 'America/New_York')::date) AS fruit_set_date
    FROM event_log e CROSS JOIN bounds b
   WHERE e.event_type = 'fruit_set' AND e.deleted_at IS NULL AND e.plant_id IS NOT NULL
     AND (e.event_date AT TIME ZONE 'America/New_York')::date >= b.season_start
   GROUP BY e.plant_id
),
-- The derivation evidence. Note these are NOT season-scoped: a sow or a potting-up that predates
-- the grow-year boundary is still the date that planting started, and scoping it away would push a
-- genuinely-anchored planting onto the add-date baseline.
derive_ev AS (
  SELECT e.plant_id,
         min((e.event_date AT TIME ZONE 'America/New_York')::date)
           FILTER (WHERE e.event_type IN ('sowing', 'seed_soak')) AS sow_event_date,
         min((e.event_date AT TIME ZONE 'America/New_York')::date)
           FILTER (WHERE e.event_type = 'transplant') AS transplant_event_date,
         min((e.event_date AT TIME ZONE 'America/New_York')::date)
           FILTER (WHERE e.event_type IN ('potting_up', 'hardening_off', 'brought_outside')) AS proxy_event_date
    FROM event_log e
   WHERE e.deleted_at IS NULL AND e.plant_id IS NOT NULL
   GROUP BY e.plant_id
),
live AS (
  SELECT gn.id AS plant_id, gn.project_id, gn.name AS planting_name, gn.status, gn.location_id,
         gn.sown_at, gn.transplanted_at, gn.planted_out_at,
         (gn.created_at AT TIME ZONE 'America/New_York')::date AS add_date,
         cv.id AS variety_id, cv.crop_type_slug,
         cv.days_to_maturity_min, cv.days_to_maturity_max,
         ct.display_name AS crop_display_name,
         ct.harvest_habit, ct.dtm_basis, ct.set_to_first_pick_days
    FROM plants gn
    JOIN plant_projects pj ON pj.id = gn.project_id
    JOIN plant_varieties cv ON cv.id = gn.variety_id AND cv.deleted_at IS NULL
    JOIN crop_types ct ON ct.slug = cv.crop_type_slug AND ct.deleted_at IS NULL
   WHERE pj.deleted_at IS NULL AND pj.archived_at IS NULL
     AND gn.deleted_at IS NULL AND gn.archived_at IS NULL
     AND (gn.status IS NULL OR gn.status NOT IN ('failed', 'ended', 'dormant'))
),
sibling AS (
  SELECT l.plant_id, s.plant_id AS sibling_plant_id, s.planting_name AS sibling_planting_name,
         s.first_pick_date AS sibling_first_pick_date
    FROM live l
    JOIN LATERAL (
      SELECT sl.plant_id, sl.planting_name, pk.first_pick_date
        FROM live sl JOIN picks pk ON pk.plant_id = sl.plant_id
       WHERE sl.project_id = l.project_id AND sl.plant_id <> l.plant_id
         AND sl.crop_type_slug IS NOT DISTINCT FROM l.crop_type_slug
         AND pk.first_pick_date IS NOT NULL
       ORDER BY pk.first_pick_date ASC, sl.plant_id ASC LIMIT 1
    ) s ON true
),
nursery AS (
  SELECT count(*)::int AS n,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY (gn.transplanted_at - gn.sown_at))::int AS median_gap
    FROM plants gn
   WHERE gn.deleted_at IS NULL AND gn.sown_at IS NOT NULL AND gn.transplanted_at IS NOT NULL
     AND gn.transplanted_at >= gn.sown_at
),
-- The add-date offset samples, for resolveAddDateOffset() on the JS side.
offset_samples AS (
  SELECT array_agg(gn.transplanted_at - (gn.created_at AT TIME ZONE 'America/New_York')::date) AS days
    FROM plants gn
   WHERE gn.deleted_at IS NULL AND gn.transplanted_at IS NOT NULL
)
SELECT json_build_object(
  'et_today', to_char(b.et_today, 'YYYY-MM-DD'),
  'season_start', to_char(b.season_start, 'YYYY-MM-DD'),
  'nursery_sample_n', nu.n,
  'nursery_median_gap', nu.median_gap,
  'offset_samples', os.days,
  'rows', coalesce(json_agg(json_build_object(
    'plant_id', l.plant_id, 'project_id', l.project_id, 'planting_name', l.planting_name,
    'status', l.status, 'crop_type_slug', l.crop_type_slug, 'crop_display_name', l.crop_display_name,
    'harvest_habit', l.harvest_habit, 'dtm_basis', l.dtm_basis,
    'days_to_maturity_min', l.days_to_maturity_min, 'days_to_maturity_max', l.days_to_maturity_max,
    'set_to_first_pick_days', l.set_to_first_pick_days,
    'sown_at', l.sown_at, 'transplanted_at', l.transplanted_at, 'planted_out_at', l.planted_out_at,
    'add_date', l.add_date,
    'prior_harvest_count', coalesce(pk.harvest_count, 0),
    'fruit_set_date', fs.fruit_set_date,
    'sibling_plant_id', sb.sibling_plant_id,
    'sibling_planting_name', sb.sibling_planting_name,
    'sibling_first_pick_date', sb.sibling_first_pick_date,
    'dismissed_active', false,
    'sow_event_date', de.sow_event_date,
    'transplant_event_date', de.transplant_event_date,
    'proxy_event_date', de.proxy_event_date
  )), '[]'::json)
)
  FROM live l
  CROSS JOIN bounds b
  CROSS JOIN nursery nu
  CROSS JOIN offset_samples os
  LEFT JOIN picks pk ON pk.plant_id = l.plant_id
  LEFT JOIN fruit_set fs ON fs.plant_id = l.plant_id
  LEFT JOIN sibling sb ON sb.plant_id = l.plant_id
  LEFT JOIN derive_ev de ON de.plant_id = l.plant_id
 GROUP BY b.et_today, b.season_start, nu.n, nu.median_gap, os.days;
