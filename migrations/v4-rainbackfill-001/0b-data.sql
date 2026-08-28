-- 0b-data.sql
-- V4-RAINAUTOLOG-001 (BD-069) — restore the on-site gauge as the source of truth for July/August
-- rainfall, and create the rain EVENTS that were never logged.
--
-- DATA-ONLY. No DDL on any app table: no column, constraint, index or view is touched. The two
-- snap_* tables are rollback scaffolding (see 0r) and are the only objects created. In particular
-- NO new event_log.source value is introduced — 'import' is already in event_log_source_check's
-- ARRAY, so nothing here arms or widens a constraint against a still-deployed writer.
--
-- ═══ WHAT WAS ACTUALLY WRONG — two faults, one cause ═══
--
-- Dave: "the data looks like there was zero rain in August because I as human never logged it."
-- That was the visible half. Investigating it surfaced a second, larger fault underneath.
--
-- FAULT 1 — weather_daily holds MODEL data for a period where GAUGE data exists.
--   Every weather_daily row for 2026-07-19..2026-08-11 has created_at = 2026-08-13: one bulk
--   backfill, drawn from Open-Meteo archive. The AmbientWeather WS-2902 had been recording since
--   2026-07-05 and its history was still retrievable from the AWN device API the whole time. So
--   precip_in — which the care engine reads to decide what needs water — has been a model estimate
--   for five weeks, and the model materially under-reads this site:
--       2026-08-03  model 1.00"  gauge 2.22"   (less than half)
--       2026-07-28  model 0.20"  gauge 0.80"
--       2026-07-29  model 2.23"  gauge 2.84"
--       2026-07-31  model 0.37"  gauge 0.64"
--       2026-07-30  model 1.22"  gauge 0.54"   (over-reads too — the error is not one-directional)
--   11 of 38 days differ by more than 0.10". Net for the period: +0.97".
--
-- FAULT 2 — nothing has ever created a rain EVENT.
--   'rain' is READ in ten places (daily-plan handler last_water, doneEvents, dashboard, overwinter,
--   events undo cascade, engine) and WRITTEN by nothing automatic. RAIN-EVENT-001 created the type,
--   DRG-WXSTATION-001 provided the gauge, BUG-RAINACTUAL-001 pointed the precip FIELDS at the gauge
--   — and no one ever built the bridge from gauge reading to event row. Not a regression: a gap
--   that was assumed closed. Dave's last manual rain log is 2026-07-18.
--
-- ═══ WHERE THESE NUMBERS COME FROM, AND HOW THEY WERE CHECKED ═══
--
-- Source: AWN device API, GET /v1/devices/<mac>?endDate=<ET midnight - 5min>&limit=1, reading
-- `dailyrainin` from the last record before the ET day boundary. Two independent cross-checks, both
-- exact, neither assumed:
--   (1) OVERLAP. For 2026-08-12..2026-08-26 the app already holds gauge_merged rows written by the
--       live daily-plan path. This extraction reproduces all 15 of those values EXACTLY. A method
--       that agrees with the production reader on every overlapping day is not guessing.
--   (2) THE STATION'S OWN TOTAL. The station reported monthlyrainin = 7.06 at the end of July. The
--       daily values below for 2026-07-05..2026-07-31 sum to exactly 7.06. The counter starting on
--       07-05 is why there is no gauge value before then — that is the install date, not a gap.
-- Days the API returned no record (2026-07-01..07-04, 2026-08-01) are ABSENT from the VALUES list
-- below rather than present as 0. Writing 0 for "the station was not yet recording" would assert a
-- dry day on no evidence; the LEFT JOIN in step 2 leaves those rows untouched.
--
-- ═══ WHY THIS IS A MIGRATION AND NOT A CALL TO POST /api/events/batch ═══
--
-- The batch endpoint is the correct path for a HUMAN logging action, and per the standing rule that
-- agent data entry uses the app path it would normally be the right choice. It is the wrong choice
-- here, for a reason specific to what this migration is:
--
--   lambda/events/batchSideEffects.js fires user_stats, the logging STREAK, achievement evaluation,
--   flat XP and app_events telemetry; critterAward.js adds one critter roll per batch.
--
-- Backfilled rain is not a logging action Dave performed. Routing 8 historical rain days through
-- that path would mint 8 critter rolls, 8 XP awards and 8 days of streak credit for weather a
-- machine noticed — making the watering streak partly a measure of rainfall. reward-ux-guideline
-- V102 is binding here: a reward surface responds to USER activity, and the streaks rule permits
-- streaks only on cadence-UTILITY surfaces. So the split this file implements is deliberate:
--
--   CARE-CACHE side effects — REPRODUCED FAITHFULLY (step 3). They are factual state: the rain
--   really did fall on that plant on that day, and last_watered_at/next_water_at must say so or the
--   engine will ask Dave to water something the sky already watered.
--   REWARD side effects — DELIBERATELY NOT FIRED. No XP, no critter, no streak, no achievement,
--   no app_events row.
--
-- The same split binds the ongoing nightly job. Do not "fix" this by later routing auto-rain
-- through the batch endpoint.
--
-- ═══ WHICH PLANTINGS GET RAIN — the roof rule ═══
--
-- Dave's decision, 2026-08-27: every live planting EXCEPT those under a roof. That rule was already
-- in the data and did not need inventing: locations.covered is populated and correct (House t,
-- Stable t, Indoor Rack t, Shelf 1-5 t; Deck f, Drive f, Pasture f, Yard f). It is applied
-- RECURSIVELY — a shelf inherits the Stable's roof — giving 212 uncovered / 22 covered of 234 live
-- plantings, and 0 plantings have a NULL location, so the split is total and unambiguous.
--
-- This deliberately DIFFERS from the 2026-07-18 fan-out, which reached 188 plants and skipped a
-- trough on the Drive and a spot in the Yard. That was a hand-picked selection in Log Many, not an
-- encoded rule, and both of those places are open to the sky. Copying it would have propagated a
-- one-off tap as though it were policy.
--
-- ═══ THE 0.10" THRESHOLD ═══
--
-- Dave's, verbatim: "above 0.10 inches measured. Below that is not an event." Applied STRICTLY
-- GREATER THAN 0.10, so 2026-07-22 (exactly 0.10) and 2026-08-20 (0.09) create nothing.
--
-- ═══ DEPLOY BOUNDARY — the falsifiable test ═══
--
--   QUESTION: can the CURRENTLY DEPLOYED prod code produce a row that violates anything this file
--             establishes, or break because of what this file writes?
--   ANSWER:   No, in both directions. (a) Nothing deployed writes weather_daily.precip_source other
--             than the daily-plan path, which writes only for today/recent days and will not revisit
--             2026-07-05..2026-08-11. (b) event_log rows with source='import' are already legal
--             under the existing NOT VALID check and are read by every 'rain' consumer exactly like
--             any other rain row — that is the point of them. (c) entity_memory is written FORWARD
--             ONLY here (GREATEST), which is the same direction every deployed forward writer uses.
--   CONSEQUENCE: order-independent. Safe to apply before or after any promote. Idempotent — see the
--             re-run guards below; a second application matches nothing and writes nothing.

BEGIN;

SELECT set_config('app.actor_clerk_sub', 'user_3D2gM0hIl03gjW3JM2DjtPzm0jI', true);

-- ── The measured gauge series. Provenance and cross-checks in the header. ────────────────────────
CREATE TEMP TABLE _gauge (d date PRIMARY KEY, rain_in numeric NOT NULL) ON COMMIT DROP;
INSERT INTO _gauge (d, rain_in) VALUES
  ('2026-07-05',0.00),('2026-07-06',0.01),('2026-07-07',1.02),('2026-07-08',0.01),
  ('2026-07-09',0.00),('2026-07-10',0.00),('2026-07-11',0.00),('2026-07-12',0.00),
  ('2026-07-13',0.04),('2026-07-14',0.00),('2026-07-15',0.00),('2026-07-16',0.00),
  ('2026-07-17',0.00),('2026-07-18',0.41),('2026-07-19',0.00),('2026-07-20',0.00),
  ('2026-07-21',0.65),('2026-07-22',0.10),('2026-07-23',0.00),('2026-07-24',0.00),
  ('2026-07-25',0.00),('2026-07-26',0.00),('2026-07-27',0.00),('2026-07-28',0.80),
  ('2026-07-29',2.84),('2026-07-30',0.54),('2026-07-31',0.64),
  ('2026-08-02',0.00),('2026-08-03',2.22),('2026-08-04',0.00),('2026-08-05',0.00),
  ('2026-08-06',0.02),('2026-08-07',0.00),('2026-08-08',0.09),('2026-08-09',0.00),
  ('2026-08-10',0.00),('2026-08-11',0.00),
  -- 08-12 onward the app ALREADY holds these as gauge_merged, written same-day by the live
  -- daily-plan path. They are listed anyway because step 3 needs them: 08-17 and 08-23 are two of
  -- the eight rain days, and an earlier draft that stopped at 08-11 silently produced 6 days'
  -- events instead of 8 — caught by rehearsing on a prod fork and counting, not by reading.
  -- Step 2 is a no-op across this range: its IS DISTINCT FROM guard matches nothing when the stored
  -- value and label already equal these. That equality is itself the cross-check (see header).
  ('2026-08-12',0.00),('2026-08-13',0.01),('2026-08-14',0.00),('2026-08-15',0.00),
  ('2026-08-16',0.00),('2026-08-17',0.21),('2026-08-18',0.01),('2026-08-19',0.00),
  ('2026-08-20',0.09),('2026-08-21',0.00),('2026-08-22',0.04),('2026-08-23',0.34),
  ('2026-08-24',0.00),('2026-08-25',0.00),('2026-08-26',0.00),('2026-08-27',0.00);

-- ═══ STEP 1 — snapshot, for 0r ═══════════════════════════════════════════════════════════════════
-- IF NOT EXISTS is deliberate but is ALSO why gates.yml has a pre_snapshot_absent gate: on a fresh
-- run an adopted older snapshot would silently become the rollback target for a different state.

-- This table is ALSO the record of which rows step 2 re-sourced, since step 2 writes the existing
-- 'gauge_merged' label rather than a distinguishing one (see step 2's header for why). It is the
-- better record: it carries the prior value, not just the fact of a change.
CREATE TABLE IF NOT EXISTS public.snap_rainbackfill001_weather_daily AS
  SELECT wd.space_id, wd.date, wd.precip_in, wd.precip_source, now() AS snapped_at
    FROM public.weather_daily wd
    JOIN _gauge g ON g.d = wd.date
   WHERE wd.precip_in IS DISTINCT FROM g.rain_in
      OR wd.precip_source IS DISTINCT FROM 'gauge_merged';

-- entity_memory rows step 3 may move forward. Snapshotted BEFORE the write so 0r can put the cache
-- back exactly, including rows whose values were NULL.
CREATE TABLE IF NOT EXISTS public.snap_rainbackfill001_entity_memory AS
  SELECT em.id, em.last_event_at, em.last_watered_at, em.next_water_at, now() AS snapped_at
    FROM public.entity_memory em
   WHERE em.plant_id IS NOT NULL OR em.project_id IS NOT NULL;

-- ═══ STEP 2 — re-source weather_daily from the gauge ═════════════════════════════════════════════
-- precip_source becomes 'gauge_merged' — the EXISTING value, deliberately, after a first draft of
-- this file used a new 'gauge_backfill' label and a rehearsal on a prod fork proved that wrong twice
-- over. Both reasons are worth keeping written down:
--
--   1. It is not a free label. weather_daily_precip_source_chk is a VALIDATED check allowing exactly
--      {gauge_merged, openmeteo_live, openmeteo_archive}, so a new value needs DDL.
--   2. FAR MORE IMPORTANT — 'gauge_merged' is not just a description, it is a KEY that buys
--      protection. lambda/daily-plan/handler.js:192-199 and scripts/backfill-weather-daily.mjs:200-206
--      both carry the same guard: on upsert, if the stored row is 'gauge_merged' and the incoming row
--      is not, KEEP THE STORED VALUE. That guard is what stops a model estimate from overwriting a
--      real measurement. A row labelled 'gauge_backfill' would not match it, so the next Open-Meteo
--      pass would silently overwrite these restored readings — re-creating the exact defect this
--      migration exists to repair. Writing a novel label would have opted these rows out of the one
--      protection they most need.
--
-- The separate-observability concern that motivated the new label is real and is served instead by
-- snap_rainbackfill001_weather_daily, which records every row this file touched together with its
-- prior value. That is a better record anyway: it carries the BEFORE, which a label cannot.
UPDATE public.weather_daily wd
   SET precip_in     = g.rain_in,
       precip_source = 'gauge_merged',
       updated_at    = now()
  FROM _gauge g
 WHERE g.d = wd.date
   AND (wd.precip_in IS DISTINCT FROM g.rain_in OR wd.precip_source IS DISTINCT FROM 'gauge_merged');

-- ═══ STEP 3 — the missing rain events ════════════════════════════════════════════════════════════
-- Column list, join shape and NULL semantics mirror lambda/events/index.js's batch INSERT:
--   * project_id from the planting's container, location_id from that container — NOT from the
--     planting. That is the deployed writer's choice and its comment explains why; diverging would
--     make these rows unlike every other event row.
--   * LEFT JOIN container, never INNER (BUG-LOGMANYPROJECTLESS-001): a project-less planting must
--     still get its row. event_log_has_anchor is satisfied by plant_id alone.
--   * is_public = true, matching all 698 existing rain rows.
-- Two DELIBERATE improvements on the batch writer, neither of which changes any contract:
--   * quantity_numeric carries the INCHES. All 698 existing rain events have it NULL, so the app has
--     never recorded how much rain fell — which is why Dave's own recollection of a 6" week could
--     not be checked against the app at all. RAIN-EVENT-001 specified inches in this column; this is
--     the first writer to honour it.
--   * source = 'import', not 'app_batch'. These rows were ingested from an external instrument, not
--     produced by an app action, and source is the provenance column of record.
INSERT INTO public.event_log
  (project_id, location_id, plant_id, event_type, event_date, is_public,
   logged_by, created_by, quantity_numeric, metadata, source, notes)
SELECT pp.id,
       pp.location_id,
       p.id,
       'rain',
       (g.d + TIME '12:00')::timestamptz,   -- noon anchor, per the events writer's date convention
       true,
       'user_3D2gM0hIl03gjW3JM2DjtPzm0jI',
       'user_3D2gM0hIl03gjW3JM2DjtPzm0jI',
       g.rain_in,
       jsonb_build_object(
         'rain_backfill',  'v4-rainbackfill-001',   -- the group-undo key; 0r deletes on this alone
         'gauge_in',       g.rain_in,
         'precip_source',  'awn_gauge',
         'station_series', 'awn_dailyrainin'
       ),
       'import',
       'Rain recorded by the on-site weather station.'
  FROM _gauge g
 CROSS JOIN public.garden_node p
  LEFT JOIN public.container pp ON pp.id = p.container_id
 WHERE g.rain_in > 0.10
   AND g.d > DATE '2026-07-18'          -- Dave's last manual rain log; earlier days are his, not ours
   AND p.deleted_at IS NULL
   AND p.archived_at IS NULL
   -- the roof rule, applied recursively over the location tree
   AND NOT COALESCE((
         WITH RECURSIVE up AS (
           SELECT l.id, l.parent_id, l.covered
             FROM public.locations l
            WHERE l.id = p.location_id AND l.deleted_at IS NULL
           UNION ALL
           SELECT l.id, l.parent_id, l.covered
             FROM up JOIN public.locations l ON l.id = up.parent_id AND l.deleted_at IS NULL
         )
         SELECT bool_or(up.covered) FROM up
       ), false)
   -- re-run guard: never write a second rain row for a plant/day this file already covered
   AND NOT EXISTS (
         SELECT 1 FROM public.event_log e
          WHERE e.plant_id = p.id
            AND e.event_type = 'rain'
            AND e.event_date::date = g.d
            AND e.deleted_at IS NULL
       );

-- ═══ STEP 4 — care cache, FORWARD ONLY ═══════════════════════════════════════════════════════════
-- GREATEST, exactly like every deployed forward writer, so this can never walk the cache backwards
-- and can never annex V4-CARECACHEUNDO-001's rows. next_water_at = +4 days matches the batch path.
-- Recomputed FROM event_log rather than from the _gauge list, so it is correct even if step 3's
-- re-run guard skipped some rows: the cache follows the log, never this file's intent.
UPDATE public.entity_memory em
   SET last_watered_at = GREATEST(COALESCE(em.last_watered_at, t.mx), t.mx),
       last_event_at   = GREATEST(COALESCE(em.last_event_at,   t.mx), t.mx),
       next_water_at   = GREATEST(COALESCE(em.next_water_at,   t.mx + INTERVAL '4 days'),
                                  t.mx + INTERVAL '4 days'),
       updated_at      = now()
  FROM (
        SELECT e.plant_id, MAX(e.event_date) AS mx
          FROM public.event_log e
         WHERE e.event_type IN ('watering','rain')
           AND e.deleted_at IS NULL
           AND e.plant_id IS NOT NULL
         GROUP BY e.plant_id
       ) t
 WHERE em.plant_id = t.plant_id
   AND (em.last_watered_at IS NULL OR em.last_watered_at < t.mx);

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('4.62.0-rainbackfill-001',
        'V4-RAINAUTOLOG-001: re-source weather_daily precip from the AWN gauge for 2026-07-05..08-11 '
        'and create the 8 missing rain events (>0.10in) since the last manual log on 2026-07-18.',
        now())
ON CONFLICT DO NOTHING;

COMMIT;
