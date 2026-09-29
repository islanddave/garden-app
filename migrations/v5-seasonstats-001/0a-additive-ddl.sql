-- 0a-additive-ddl.sql
-- V5-SEASONSTATS-001 — the stat_* views behind GET /api/harvests/season-stats (Layer A of the
-- season stats engine; spec garden-stats-engine-spec-V1-20260712.md, build plan _stats2_20260929).
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHAT THIS IS: seventeen plain VIEWS, no tables, no data. Every number the Season stats page shows
-- is computed here, so a figure on the page traces back to one SQL expression in this file. The
-- handler (lambda/harvests/season-stats.js) only filters, merges household owners, rounds and
-- shapes; lambda/harvests/season-stats-sections.js holds the shapers.
--
-- PLAIN VIEWS, NOT MATVIEWS: the schema audit (scripts/dev-main-schema-audit.py) reads
-- information_schema.columns, which lists views; a matview would also need a refresh path. The
-- whole chain runs in ~1 s on prod data (274 plantings, ~1.8k picks, ~140 weather days).
--
-- EVERY VIEW EXPOSES owner + grow_year, and the handler ALWAYS filters
--   owner = ANY(<household ids>) AND grow_year = <year>.
-- grow_year = extract(year) + (month >= 11), mirroring src/lib/growYear.js (Nov 1 opens the next
-- season). Days are ET days (America/New_York), the zone the Harvests page buckets in.
-- Owners, per the existing invariants:
--   plantings  plants.created_by
--   picks      plant_projects.created_by via event_log.project_id (the lambda/harvests invariant;
--              never the nullable plant_id), falling back to event_log.created_by for a
--              project-less event
--   care days  the project owner, falling back to event_log.created_by for the 106 project-less
--              events (an inner join would silently drop them)
--   weather    spaces.created_by
--   seed lots  inventory_items.created_by
-- Views that combine weather with plantings or picks join them on the SAME owner. With one weather
-- space owned by the household's primary account that is exact today; a second household member
-- who owned plantings but no weather space would get no heat figures for them.
--
-- ARCHIVED PLANTINGS ARE INCLUDED. The Harvests page hides them (V4-ARCHIVEHIDE-001); a season
-- review counts what grew. The handler reports that as limit code `archived_included`.
--
-- HEAT: growing degree days, base 50 F, modified method (86 F cap on tmax, tmin floored at 50 and
-- capped at 86): greatest(0, (least(tmax,86) + greatest(least(tmin,86),50)) / 2 - 50).
-- HEAT BANDS: the CASE in stat_planting mirrors HEAT_BANDS in lambda/varieties/crop-derive.js
-- (ceiling = scoville_max). lambda/harvests/heat-bands-parity.test.js parses this file and fails if
-- the two drift.
--
-- SAFE: CREATE OR REPLACE VIEW over existing relations only. Nothing is written, nothing existing is
-- altered, nothing depends on these names yet. garden_ro receives SELECT through the existing
-- default privileges for neondb_owner (pg_default_acl, read on prod 2026-09-29), so no GRANT here.
-- HARD DEPENDENCY: v5-sourcecontact-001 (public.source.instagram_url / facebook_url, which
-- stat_saved_lot projects). gates.yml checks it before the apply.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-additive-ddl.sql

BEGIN;

-- One row per owner per weather day. DISTINCT ON keeps the owner's oldest space if they ever have
-- two, so a day is never double-counted into heat totals.
CREATE OR REPLACE VIEW public.stat_weather_day AS
SELECT DISTINCT ON (s.created_by, w.date)
       s.created_by AS owner,
       (extract(year FROM w.date)::int + (extract(month FROM w.date) >= 11)::int) AS grow_year,
       w.date AS day,
       w.space_id,
       w.tmax_f::float8 AS tmax_f,
       w.tmin_f::float8 AS tmin_f,
       w.precip_in::float8 AS precip_in,
       CASE WHEN w.tmax_f IS NULL OR w.tmin_f IS NULL THEN NULL
            ELSE greatest(0, (least(w.tmax_f, 86) + greatest(least(w.tmin_f, 86), 50)) / 2 - 50)::float8
       END AS gdd50,
       (w.date - 1) AS night_of
  FROM public.weather_daily w
  JOIN public.spaces s ON s.id = w.space_id
 ORDER BY s.created_by, w.date, s.created_at, s.id;

-- One row per live planting, archived included. grow_year is the grow-year of the planting's start
-- (sown, else transplanted, else planted, else entered). eff_source_id falls back to the seed
-- packet's source when the planting itself names none.
CREATE OR REPLACE VIEW public.stat_planting AS
SELECT p.id AS planting_id,
       p.created_by AS owner,
       (extract(year FROM x.start_day)::int + (extract(month FROM x.start_day) >= 11)::int) AS grow_year,
       x.start_day,
       p.name AS planting_name,
       p.variety_id,
       v.name AS cultivar,
       coalesce(v.name, p.name) AS display_name,
       v.crop_type_slug AS crop_slug,
       ct.display_name AS crop_name,
       ct.category AS crop_category,
       v.scoville_max,
       p.quantity::float8 AS quantity,
       p.qty_initial,
       (p.quantity = 1 AND (p.qty_initial IS NULL OR p.qty_initial = 1)) AS is_single,
       CASE WHEN v.scoville_max IS NULL OR v.scoville_max < 0 THEN NULL
            WHEN v.scoville_max <= 0      THEN 'sweet'
            WHEN v.scoville_max <= 999    THEN 'mild'
            WHEN v.scoville_max <= 9999   THEN 'medium'
            WHEN v.scoville_max <= 49999  THEN 'hot'
            WHEN v.scoville_max <= 249999 THEN 'very_hot'
            ELSE 'superhot'
       END AS heat_band,
       p.source_type,
       CASE p.source_type
            WHEN 'nursery_transplant' THEN 'nursery'
            WHEN 'seed_packet' THEN 'seed'
            WHEN 'rescued' THEN 'rescued'
            WHEN 'gift' THEN 'gift'
            ELSE CASE WHEN p.source_type IS NULL THEN 'none' ELSE 'other' END
       END AS source_group,
       coalesce(p.source_id, pk.source_id) AS eff_source_id,
       p.sown_at,
       p.transplanted_at,
       coalesce(p.transplanted_at_approx, false) AS tp_approx,
       x.created_et,
       p.status,
       p.container_size,
       p.archived_at
  FROM public.plants p
  LEFT JOIN public.plant_varieties v ON v.id = p.variety_id
  LEFT JOIN public.crop_types ct ON ct.slug = v.crop_type_slug
  LEFT JOIN public.inventory_items pk ON pk.id = p.source_inventory_item_id
 CROSS JOIN LATERAL (
       SELECT (p.created_at AT TIME ZONE 'America/New_York')::date AS created_et,
              coalesce(p.sown_at, p.transplanted_at,
                       (p.planted_at AT TIME ZONE 'America/New_York')::date,
                       (p.created_at AT TIME ZONE 'America/New_York')::date) AS start_day
       ) x
 WHERE p.deleted_at IS NULL;

-- One row per live harvest_log row (a pick), on its ET day. Owner is the project owner; a pick on a
-- project-less event (6 of 1,761 live rows on prod 2026-09-29, from the project-less plantings)
-- falls back to the event's own created_by rather than vanishing — an inner join to plant_projects
-- would drop them, and their weight with them.
CREATE OR REPLACE VIEW public.stat_pick AS
SELECT h.id AS harvest_id,
       e.id AS event_id,
       coalesce(pj.created_by, e.created_by) AS owner,
       (extract(year FROM d.day)::int + (extract(month FROM d.day) >= 11)::int) AS grow_year,
       d.day,
       e.plant_id AS planting_id,
       h.weight_grams::float8 AS grams,
       h.weight_basis,
       coalesce(h.weight_basis = 'measured', false) AS is_measured,
       h.unit,
       h.quantity::float8 AS qty
  FROM public.harvest_log h
  JOIN public.event_log e ON e.id = h.event_id AND e.deleted_at IS NULL
  LEFT JOIN public.plant_projects pj ON pj.id = e.project_id
 CROSS JOIN LATERAL (SELECT (e.event_date AT TIME ZONE 'America/New_York')::date AS day) d
 WHERE h.deleted_at IS NULL
   AND e.event_type IN ('harvest', 'first_harvest');

-- Per planting per grow-year of the picks. measured_share is by weight; fruit_count sums count-unit
-- quantities only.
CREATE OR REPLACE VIEW public.stat_planting_harvest AS
SELECT sp.planting_id,
       sp.owner,
       k.grow_year,
       coalesce(sum(k.grams), 0) / 453.592 AS lb,
       CASE WHEN coalesce(sum(k.grams), 0) > 0
            THEN coalesce(sum(k.grams) FILTER (WHERE k.is_measured), 0) / sum(k.grams)
            ELSE 0 END AS measured_share,
       coalesce(sum(k.qty) FILTER (WHERE k.unit = 'count'), 0) AS fruit_count,
       array_agg(DISTINCT k.day ORDER BY k.day) AS pick_days,
       min(k.day) AS first_pick,
       max(k.day) AS last_pick,
       count(DISTINCT k.day)::int AS pick_day_count,
       count(*)::int AS picks
  FROM public.stat_pick k
  JOIN public.stat_planting sp ON sp.planting_id = k.planting_id
 GROUP BY sp.planting_id, sp.owner, k.grow_year;

-- Care counted in DAYS: a batch "water all" is one water day, not 157 rows. Rain, status changes and
-- imported history are not care. Kinds mirror KIND_OF in _mainsync13_20260928/T-stats/gen/compute.py.
CREATE OR REPLACE VIEW public.stat_care_day AS
SELECT DISTINCT
       coalesce(pj.created_by, e.created_by) AS owner,
       (extract(year FROM d.day)::int + (extract(month FROM d.day) >= 11)::int) AS grow_year,
       d.day,
       k.care_kind
  FROM public.event_log e
  LEFT JOIN public.plant_projects pj ON pj.id = e.project_id
 CROSS JOIN LATERAL (SELECT (e.event_date AT TIME ZONE 'America/New_York')::date AS day) d
 CROSS JOIN LATERAL (
       SELECT CASE
                WHEN e.event_type = 'watering' THEN 'water'
                WHEN e.event_type = 'fertilizing' THEN 'feed'
                WHEN e.event_type IN ('pest_treatment', 'doctored') THEN 'pests'
                WHEN e.event_type IN ('transplant', 'potting_up', 'hardening_off', 'germination',
                                      'seed_soak', 'thinning') THEN 'starts'
                WHEN e.event_type IN ('pruning', 'staked', 'trellised', 'mulched', 'caged', 'pinched',
                                      'suckered', 'weeded', 'deadheaded', 'cover', 'uncover',
                                      'mesh_netting', 'soil_amended') THEN 'upkeep'
                WHEN e.event_type IN ('observation', 'moisture_check') THEN 'checkins'
                WHEN e.event_type IN ('harvest', 'first_harvest') THEN 'picking'
              END AS care_kind
       ) k
 WHERE e.deleted_at IS NULL
   AND e.event_type NOT IN ('rain', 'status_change')
   AND coalesce(e.source, '') <> 'import'
   AND k.care_kind IS NOT NULL;

-- Ribbon pins: first sowing, first set-out, hottest and wettest day (earliest on a tie), and the
-- weather span that bounds every heat figure.
CREATE OR REPLACE VIEW public.stat_season_pins AS
WITH pl AS (
  SELECT owner, grow_year, min(sown_at) AS first_sow, min(transplanted_at) AS first_setout
    FROM public.stat_planting
   GROUP BY owner, grow_year
), span AS (
  SELECT owner, grow_year, min(day) AS weather_from, max(day) AS weather_to, count(*)::int AS weather_days
    FROM public.stat_weather_day
   GROUP BY owner, grow_year
), hot AS (
  SELECT DISTINCT ON (owner, grow_year) owner, grow_year, day AS hottest_day, tmax_f AS hottest_tmax_f
    FROM public.stat_weather_day
   WHERE tmax_f IS NOT NULL
   ORDER BY owner, grow_year, tmax_f DESC, day
), wet AS (
  SELECT DISTINCT ON (owner, grow_year) owner, grow_year, day AS wettest_day, precip_in AS wettest_precip_in
    FROM public.stat_weather_day
   WHERE precip_in IS NOT NULL
   ORDER BY owner, grow_year, precip_in DESC, day
)
SELECT coalesce(pl.owner, span.owner) AS owner,
       coalesce(pl.grow_year, span.grow_year) AS grow_year,
       pl.first_sow,
       pl.first_setout,
       hot.hottest_day,
       hot.hottest_tmax_f,
       wet.wettest_day,
       wet.wettest_precip_in,
       span.weather_from,
       span.weather_to,
       span.weather_days
  FROM pl
  FULL JOIN span ON span.owner = pl.owner AND span.grow_year = pl.grow_year
  LEFT JOIN hot ON hot.owner = span.owner AND hot.grow_year = span.grow_year
  LEFT JOIN wet ON wet.owner = span.owner AND wet.grow_year = span.grow_year;

-- Monday weeks: heat in (degree days, nights under 55 F, rain) against fruit out (count-unit
-- tomato fruit and pepper pods picked that week). Only weeks with weather; picks before the first
-- weather day are left out so both layers cover the same span.
CREATE OR REPLACE VIEW public.stat_weekly_heat_fruit AS
WITH wk AS (
  SELECT owner, grow_year, (day - (extract(isodow FROM day)::int - 1)) AS week_start,
         sum(coalesce(gdd50, 0)) AS heat_units,
         count(*) FILTER (WHERE tmin_f < 55)::int AS cool_nights,
         sum(coalesce(precip_in, 0)) AS rain_in
    FROM public.stat_weather_day
   GROUP BY owner, grow_year, 3
), origin AS (
  SELECT owner, grow_year, min(day) AS origin_date
    FROM public.stat_weather_day
   GROUP BY owner, grow_year
), fr AS (
  SELECT k.owner, k.grow_year, (k.day - (extract(isodow FROM k.day)::int - 1)) AS week_start,
         coalesce(sum(k.qty) FILTER (WHERE sp.crop_slug = 'tomato'), 0) AS tomato_fruit,
         coalesce(sum(k.qty) FILTER (WHERE sp.crop_slug = 'pepper'), 0) AS pepper_pods
    FROM public.stat_pick k
    JOIN public.stat_planting sp ON sp.planting_id = k.planting_id
    JOIN origin o ON o.owner = k.owner AND o.grow_year = k.grow_year
   WHERE k.unit = 'count' AND k.day >= o.origin_date
   GROUP BY k.owner, k.grow_year, 3
)
SELECT wk.owner,
       wk.grow_year,
       wk.week_start,
       wk.heat_units,
       wk.cool_nights,
       wk.rain_in,
       coalesce(fr.tomato_fruit, 0) AS tomato_fruit,
       coalesce(fr.pepper_pods, 0) AS pepper_pods
  FROM wk
  LEFT JOIN fr ON fr.owner = wk.owner AND fr.grow_year = wk.grow_year AND fr.week_start = wk.week_start;

-- Where plantings came from, by source_type group.
CREATE OR REPLACE VIEW public.stat_source_mix AS
SELECT owner, grow_year, source_group,
       count(*)::int AS plantings,
       sum(quantity) AS plants
  FROM public.stat_planting
 GROUP BY owner, grow_year, source_group;

-- Report card per effective source (seller, nursery, person), plus one row with source_id NULL for
-- plantings that name no source. lb counts picks in the planting's own grow-year. saved_lots counts
-- plantings that are the parent of at least one live saved-seed lot.
CREATE OR REPLACE VIEW public.stat_source_card AS
WITH lot_parent AS (
  SELECT DISTINCT source_plant_id AS planting_id
    FROM public.inventory_items
   WHERE deleted_at IS NULL AND source_plant_id IS NOT NULL
)
SELECT sp.owner,
       sp.grow_year,
       sp.eff_source_id AS source_id,
       s.name,
       s.kind,
       count(*)::int AS plantings,
       sum(sp.quantity) AS plants,
       count(ph.planting_id)::int AS picked,
       (count(*) FILTER (WHERE sp.status = 'failed'))::int AS lost,
       coalesce(sum(ph.lb), 0) AS lb,
       count(lp.planting_id)::int AS saved_lots,
       count(DISTINCT sp.crop_slug)::int AS crops
  FROM public.stat_planting sp
  LEFT JOIN public.stat_planting_harvest ph ON ph.planting_id = sp.planting_id AND ph.grow_year = sp.grow_year
  LEFT JOIN public.source s ON s.id = sp.eff_source_id
  LEFT JOIN lot_parent lp ON lp.planting_id = sp.planting_id
 GROUP BY sp.owner, sp.grow_year, sp.eff_source_id, s.name, s.kind;

-- Heat from the first weather day to each crop's first pick of the season.
CREATE OR REPLACE VIEW public.stat_heat_clock_crop AS
WITH origin AS (
  SELECT owner, grow_year, min(day) AS origin_date
    FROM public.stat_weather_day
   GROUP BY owner, grow_year
), firsts AS (
  SELECT sp.owner, ph.grow_year, sp.crop_slug, min(sp.crop_name) AS crop_name, min(ph.first_pick) AS first_pick
    FROM public.stat_planting_harvest ph
    JOIN public.stat_planting sp ON sp.planting_id = ph.planting_id
   WHERE sp.crop_slug IS NOT NULL
   GROUP BY sp.owner, ph.grow_year, sp.crop_slug
)
SELECT f.owner,
       f.grow_year,
       f.crop_slug,
       f.crop_name,
       f.first_pick,
       o.origin_date,
       (SELECT coalesce(sum(w.gdd50), 0)
          FROM public.stat_weather_day w
         WHERE w.owner = f.owner AND w.day >= o.origin_date AND w.day < f.first_pick) AS heat_units
  FROM firsts f
  JOIN origin o ON o.owner = f.owner AND o.grow_year = f.grow_year
 WHERE f.first_pick >= o.origin_date;

-- Heat from set-out to first pick, per tomato/pepper planting. Clean subset only: an exact
-- transplant date inside the weather span, not rescued/gifted/swapped (their clock started
-- elsewhere), and at least 21 days to first pick (shorter means it came in already fruiting).
-- crop_median_heat is the median over the same rows, per crop.
CREATE OR REPLACE VIEW public.stat_heat_clock_cultivar AS
WITH origin AS (
  SELECT owner, grow_year, min(day) AS origin_date
    FROM public.stat_weather_day
   GROUP BY owner, grow_year
), base AS (
  SELECT sp.planting_id,
         sp.owner,
         ph.grow_year,
         sp.crop_slug,
         sp.display_name AS cultivar,
         sp.transplanted_at,
         ph.first_pick,
         (ph.first_pick - sp.transplanted_at) AS days,
         (SELECT coalesce(sum(w.gdd50), 0)
            FROM public.stat_weather_day w
           WHERE w.owner = sp.owner AND w.day >= sp.transplanted_at AND w.day < ph.first_pick) AS heat_units,
         sp.heat_band,
         sp.source_type
    FROM public.stat_planting sp
    JOIN public.stat_planting_harvest ph ON ph.planting_id = sp.planting_id
    JOIN origin o ON o.owner = sp.owner AND o.grow_year = ph.grow_year
   WHERE sp.crop_slug IN ('tomato', 'pepper')
     AND sp.transplanted_at IS NOT NULL
     AND NOT sp.tp_approx
     AND sp.transplanted_at >= o.origin_date
     AND coalesce(sp.source_type, '') NOT IN ('rescued', 'plant_swap', 'gift')
     AND ph.first_pick - sp.transplanted_at >= 21
), med AS (
  SELECT owner, grow_year, crop_slug, percentile_cont(0.5) WITHIN GROUP (ORDER BY heat_units) AS crop_median_heat
    FROM base
   GROUP BY owner, grow_year, crop_slug
)
SELECT b.planting_id,
       b.owner,
       b.grow_year,
       b.crop_slug,
       b.cultivar,
       b.transplanted_at,
       b.first_pick,
       b.days,
       b.heat_units,
       b.heat_band,
       b.source_type,
       m.crop_median_heat
  FROM base b
  JOIN med m ON m.owner = b.owner AND m.grow_year = b.grow_year AND m.crop_slug = b.crop_slug;

-- Peppers by heat band, every pepper planting with a known ceiling.
CREATE OR REPLACE VIEW public.stat_heat_ladder AS
SELECT sp.owner,
       sp.grow_year,
       sp.heat_band AS band,
       count(*)::int AS plantings,
       sum(sp.quantity) AS plants,
       coalesce(sum(ph.fruit_count), 0) AS pods,
       coalesce(sum(ph.lb), 0) AS lb
  FROM public.stat_planting sp
  LEFT JOIN public.stat_planting_harvest ph ON ph.planting_id = sp.planting_id AND ph.grow_year = sp.grow_year
 WHERE sp.crop_slug = 'pepper' AND sp.heat_band IS NOT NULL
 GROUP BY sp.owner, sp.grow_year, sp.heat_band;

-- Single-plant peppers ranked by pods within their band.
CREATE OR REPLACE VIEW public.stat_pepper_best AS
SELECT sp.planting_id,
       sp.owner,
       sp.grow_year,
       sp.heat_band AS band,
       sp.display_name AS cultivar,
       coalesce(ph.fruit_count, 0) AS pods,
       coalesce(ph.lb, 0) AS lb,
       sp.status,
       row_number() OVER (PARTITION BY sp.owner, sp.grow_year, sp.heat_band
                          ORDER BY coalesce(ph.fruit_count, 0) DESC, coalesce(ph.lb, 0) DESC,
                                   sp.display_name, sp.planting_id)::int AS rank_in_band
  FROM public.stat_planting sp
  LEFT JOIN public.stat_planting_harvest ph ON ph.planting_id = sp.planting_id AND ph.grow_year = sp.grow_year
 WHERE sp.crop_slug = 'pepper' AND sp.is_single AND sp.heat_band IS NOT NULL;

-- Single-plant tomatoes whose weight is at least 70% measured, against the median of the same set.
-- late_aug: rescued, or entered on/after Aug 1 — it had half a season.
CREATE OR REPLACE VIEW public.stat_tomato_keep AS
WITH k AS (
  SELECT sp.planting_id,
         sp.owner,
         sp.grow_year,
         sp.display_name AS cultivar,
         ph.lb,
         ph.fruit_count AS fruit,
         CASE WHEN ph.fruit_count > 0 THEN ph.lb * 453.592 / ph.fruit_count END AS g_per_fruit,
         sp.container_size,
         ph.measured_share,
         (coalesce(sp.source_type = 'rescued', false)
          OR sp.created_et >= make_date(sp.grow_year, 8, 1)) AS late_aug
    FROM public.stat_planting sp
    JOIN public.stat_planting_harvest ph ON ph.planting_id = sp.planting_id AND ph.grow_year = sp.grow_year
   WHERE sp.crop_slug = 'tomato' AND sp.is_single AND ph.lb > 0 AND ph.measured_share >= 0.7
), m AS (
  SELECT owner, grow_year, percentile_cont(0.5) WITHIN GROUP (ORDER BY lb) AS median_lb
    FROM k
   GROUP BY owner, grow_year
)
SELECT k.planting_id,
       k.owner,
       k.grow_year,
       k.cultivar,
       k.lb,
       k.fruit,
       k.g_per_fruit,
       k.container_size,
       k.measured_share,
       k.late_aug,
       m.median_lb,
       k.lb / m.median_lb AS x_median,
       CASE WHEN k.lb >= 2 * m.median_lb THEN 'grow_again'
            WHEN k.lb <= m.median_lb / 2 THEN 'rethink'
            ELSE 'fine' END AS verdict
  FROM k
  JOIN m ON m.owner = k.owner AND m.grow_year = k.grow_year;

-- Plantings of at most six plants picked on at least five days, by picking window. still_picking:
-- last pick within six days of the season's latest pick. Pace only once the window reaches 21 days.
CREATE OR REPLACE VIEW public.stat_longest_giving AS
WITH lastpick AS (
  SELECT owner, grow_year, max(last_pick) AS season_last_pick
    FROM public.stat_planting_harvest
   GROUP BY owner, grow_year
), g AS (
  SELECT sp.planting_id,
         sp.owner,
         ph.grow_year,
         sp.display_name AS cultivar,
         sp.crop_name,
         sp.crop_category,
         sp.quantity AS plants,
         ph.first_pick,
         ph.last_pick,
         (ph.last_pick - ph.first_pick + 1) AS window_days,
         ph.pick_days,
         ph.pick_day_count,
         ph.lb,
         l.season_last_pick
    FROM public.stat_planting sp
    JOIN public.stat_planting_harvest ph ON ph.planting_id = sp.planting_id
    JOIN lastpick l ON l.owner = ph.owner AND l.grow_year = ph.grow_year
   WHERE sp.quantity > 0 AND sp.quantity <= 6 AND ph.pick_day_count >= 5
)
SELECT g.planting_id,
       g.owner,
       g.grow_year,
       g.cultivar,
       g.crop_name,
       g.crop_category,
       g.plants,
       g.first_pick,
       g.last_pick,
       g.window_days,
       g.pick_days,
       g.pick_day_count,
       (g.season_last_pick - g.last_pick) <= 6 AS still_picking,
       g.lb,
       CASE WHEN g.window_days >= 21 THEN (g.lb / g.plants) / (g.window_days / 7.0) END AS lb_per_plant_week,
       g.season_last_pick,
       row_number() OVER (PARTITION BY g.owner, g.grow_year
                          ORDER BY g.window_days DESC, g.lb DESC, g.planting_id)::int AS rank_by_window
  FROM g;

-- August against September fruit size per tomato cultivar, measured count picks only, cultivars
-- with at least five fruit in each month. fruit_weighted_ratio pools the same rows.
CREATE OR REPLACE VIEW public.stat_tomato_month_size AS
WITH mo AS (
  SELECT sp.owner,
         k.grow_year,
         sp.display_name AS cultivar,
         sum(k.grams) FILTER (WHERE extract(month FROM k.day) = 8) AS aug_grams,
         sum(k.qty)   FILTER (WHERE extract(month FROM k.day) = 8) AS aug_fruit,
         sum(k.grams) FILTER (WHERE extract(month FROM k.day) = 9) AS sep_grams,
         sum(k.qty)   FILTER (WHERE extract(month FROM k.day) = 9) AS sep_fruit
    FROM public.stat_pick k
    JOIN public.stat_planting sp ON sp.planting_id = k.planting_id
   WHERE sp.crop_slug = 'tomato' AND k.unit = 'count' AND k.is_measured
     AND k.grams > 0 AND k.qty > 0 AND extract(month FROM k.day) IN (8, 9)
   GROUP BY sp.owner, k.grow_year, sp.display_name
), q AS (
  SELECT * FROM mo WHERE aug_fruit >= 5 AND sep_fruit >= 5
)
SELECT q.owner,
       q.grow_year,
       q.cultivar,
       q.aug_grams,
       q.aug_fruit,
       q.sep_grams,
       q.sep_fruit,
       q.aug_grams / q.aug_fruit AS aug_g,
       q.sep_grams / q.sep_fruit AS sep_g,
       (q.sep_grams / q.sep_fruit) / (q.aug_grams / q.aug_fruit) AS ratio,
       (sum(q.sep_grams) OVER w / sum(q.sep_fruit) OVER w)
         / (sum(q.aug_grams) OVER w / sum(q.aug_fruit) OVER w) AS fruit_weighted_ratio
  FROM q
WINDOW w AS (PARTITION BY q.owner, q.grow_year);

-- Saved-seed lots with their lineage: the parent planting (and its season's pounds) and one source
-- row — the lot's own source (or acquired-from), else the parent planting's source. via = where the
-- parent planting was acquired from. The chain stops there on purpose (limit chain_stops_at_nursery).
CREATE OR REPLACE VIEW public.stat_saved_lot AS
SELECT i.id AS lot_id,
       i.created_by AS owner,
       (extract(year FROM x.saved_on)::int + (extract(month FROM x.saved_on) >= 11)::int) AS grow_year,
       coalesce(v.name, i.name) AS cultivar,
       v.crop_type_slug AS crop_slug,
       i.seed_count,
       coalesce(i.seed_count_estimated, false) AS count_estimated,
       coalesce(i.seed_stage, '') AS stage,
       x.saved_on,
       i.created_at AS saved_at,
       pp.id AS parent_planting_id,
       coalesce(pv.name, pp.name) AS parent_name,
       (SELECT sum(ph.lb) FROM public.stat_planting_harvest ph WHERE ph.planting_id = pp.id) AS parent_lb,
       src.id AS source_id,
       src.name AS source_name,
       coalesce(src.kind, nullif(i.source_kind, '')) AS source_kind,
       src.locality AS source_locality,
       src.address AS source_address,
       src.website_url AS source_website_url,
       src.instagram_url AS source_instagram_url,
       src.facebook_url AS source_facebook_url,
       pa.name AS via_name
  FROM public.inventory_items i
  LEFT JOIN public.plant_varieties v ON v.id = i.variety_id
  LEFT JOIN public.plants pp ON pp.id = i.source_plant_id
  LEFT JOIN public.plant_varieties pv ON pv.id = pp.variety_id
  LEFT JOIN public.source s ON s.id = coalesce(i.source_id, i.acquired_from_source_id)
  LEFT JOIN public.source ps ON ps.id = pp.source_id
  LEFT JOIN public.source src ON src.id = coalesce(s.id, ps.id)
  LEFT JOIN public.source pa ON pa.id = pp.acquired_from_source_id
 CROSS JOIN LATERAL (SELECT (i.created_at AT TIME ZONE 'America/New_York')::date AS saved_on) x
 WHERE i.deleted_at IS NULL
   AND (i.source_plant_id IS NOT NULL OR i.seed_stage IS NOT NULL);

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-seasonstats-001',
        'SEASONSTATS: V5-SEASONSTATS-001. Seventeen read-only stat_* VIEWS (weather_day, planting, pick, '
        'planting_harvest, care_day, season_pins, weekly_heat_fruit, source_mix, source_card, '
        'heat_clock_crop, heat_clock_cultivar, heat_ladder, pepper_best, tomato_keep, longest_giving, '
        'tomato_month_size, saved_lot) behind GET /api/harvests/season-stats. Every view exposes owner + '
        'grow_year; the handler filters both. No tables, no writes, nothing existing altered. Needs '
        'v5-sourcecontact-001 first (stat_saved_lot projects source.instagram_url / facebook_url).',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;
