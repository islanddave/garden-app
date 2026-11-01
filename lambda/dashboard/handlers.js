// Pure handlers for /api/dashboard. Split out of index.js so unit tests import only this module
// (index.js wires neon + Clerk + SecretsManager; those deps are not installed at the app level).
// Each builder takes `sql` (a neon tagged template; under test, a mock that records the template
// strings and bound values) plus pure inputs.

// Applied before any SQL fires, so Postgres never sees a malformed UUID.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

import { householdScope } from './household.js';
import { computeStreak, STREAK_GRACE_DAYS } from './streak.js';
import { NON_REWARD_EVENT_TYPES } from './eventTypes.rewards.js';

// Pinned to lambda/daily-plan/engine.js PLAN_SCHEMA_VERSION (anti-drift source test). The alert bar
// trusts a daily_plan ONLY when its stored items.schema_version matches; a mismatch is REJECTED
// (legacy fallback + loud error log, water_due_source='schema_mismatch'), never a silent empty verdict.
export const PLAN_SCHEMA_VERSION = 1;

// POLICY SWITCH for events whose PLANTING is soft-deleted but whose CONTAINER is still live.
//   false (SHIPPED): the event SURVIVES. The watering/harvest happened; the user deleted a planting
//     record, not the history. The feed keeps rendering the deleted planting's name.
//   true: the event is HIDDEN, symmetric with the container rule.
// Flipping this one literal switches every event read surface at once (this feed + the 5 events-Lambda
// queries carrying the same predicate; softdel-feed.test.js asserts the two files' copies stay equal).
// The CONTAINER rule is NOT a switch: a soft-deleted container always hides its events.
export const HIDE_EVENTS_UNDER_DELETED_PLANTING = false;

export function isValidUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

// Pure routing on method + rawPath. kind is one of options, dashboard, search, inactive-list,
// inactive-dismiss (with projectId), method-not-allowed, not-found, uuid-not-found (bad dismiss UUID).
export function classifyRoute(method, rawPath) {
  if (method === 'OPTIONS') return { kind: 'options' };

  const path = rawPath ?? '/api/dashboard';

  if (path === '/api/projects/inactive') {
    if (method !== 'GET') return { kind: 'method-not-allowed' };
    return { kind: 'inactive-list' };
  }

  const dismissMatch = path.match(/^\/api\/projects\/inactive\/([^/]+)\/dismiss$/);
  if (dismissMatch) {
    if (method !== 'POST') return { kind: 'method-not-allowed' };
    const projectId = dismissMatch[1];
    if (!isValidUuid(projectId)) return { kind: 'uuid-not-found' };
    return { kind: 'inactive-dismiss', projectId };
  }

  if (path === '/api/search') {
    if (method !== 'GET') return { kind: 'method-not-allowed' };
    return { kind: 'search' };
  }

  if (path !== '/api/dashboard' && path !== '/' && path !== '') {
    return { kind: 'not-found' };
  }
  if (method !== 'GET') return { kind: 'method-not-allowed' };
  return { kind: 'dashboard' };
}

const CORS = {}; // Lambda URL config is sole CORS source — handler must not duplicate

export function resp(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(body),
  };
}

export function optionsResp() {
  return { statusCode: 204, headers: CORS, body: '' };
}

// recent_events returns at most FEED_CAP entries AFTER collapseBatches() folds each Log Many batch into one.
export const FEED_CAP = 20;

export function queryRecentEvents(sql, userId) {
  // HOUSEHOLD-MODE: widened at V3-ROLES teardown
  // Raw window (LIMIT 200, pre-collapse) + batch linkage: batch_id is event_log.metadata->>'batch_id';
  // event_batches.item_count gives the exact batch size even when the window truncates a batch.
  // 200 must comfortably exceed FEED_CAP + the largest realistic batch (hard cap 500).
  const householdIds = householdScope(userId);
  return sql`
      SELECT
        e.id, e.event_type, e.event_date, e.created_at,
        e.project_id, e.plant_id,
        e.metadata->>'batch_id' AS batch_id,
        eb.item_count,
        pp.display_name AS project_name,
        gn.display_name AS plant_name,
        pr.display_name
      FROM event_log e
      JOIN public.container pp ON pp.id = e.project_id
      LEFT JOIN public.garden_node gn ON gn.id = e.plant_id
      LEFT JOIN profiles pr ON pr.id = e.logged_by
      LEFT JOIN event_batches eb ON eb.id::text = e.metadata->>'batch_id'
      WHERE pp.created_by = ANY(${householdIds})
        AND e.deleted_at IS NULL
        AND pp.archived_at IS NULL
        -- V4-SOFTDEL-001 F3: a soft-deleted container must take its events off the feed with it.
        -- Every other container join in this file already carries it (queryWaterDue,
        -- queryWaterDueFromPlan, queryHeadsUp, searchEvents); the feed was the outlier, so
        -- undoing a container left its events on the Log with the container's name still
        -- resolving through this same JOIN.
        AND pp.deleted_at IS NULL
        -- BUG-ARCHIVEHIDE-002 (audit I30): the PLANTING archive axis, which lambda/events' own feed
        -- has filtered since V4-ARCHIVEHIDE-001 L1 (932 prod events off 19 archived plantings then).
        -- pp.archived_at above is the container axis only. NOT EXISTS, alias ga, the events feed's
        -- exact shape: an event with no planting stays, and alias gn stays free for the policy switch.
        AND NOT EXISTS (SELECT 1 FROM public.garden_node ga
                         WHERE ga.id = e.plant_id AND ga.archived_at IS NOT NULL)
        -- Deleted-PLANTING policy — see HIDE_EVENTS_UNDER_DELETED_PLANTING. Disabled today, so
        -- this OR is TRUE on its first operand and the gn test never runs.
        AND (${HIDE_EVENTS_UNDER_DELETED_PLANTING}::boolean IS NOT TRUE
             OR e.plant_id IS NULL OR gn.deleted_at IS NULL)
      ORDER BY e.created_at DESC
      LIMIT 200
    `;
}

// Pure collapse: one Log Many batch -> ONE feed entry. Rows arrive created_at DESC; a batch anchors at
// its newest row. batch_count prefers event_batches.item_count (exact, window-truncation-proof), else
// occurrences seen in the raw window. Undone batches are soft-deleted upstream. Cap applies AFTER collapsing.
export function collapseBatches(rows, cap = FEED_CAP) {
  const out = [];
  const byBatch = new Map();
  for (const r of rows ?? []) {
    if (!r) continue;
    const bid = r.batch_id ?? null;
    if (!bid) { out.push({ ...r, batch_count: 1 }); continue; }
    const prev = byBatch.get(bid);
    if (prev) { if (!prev.exact) prev.entry.batch_count += 1; continue; }
    const n = Number(r.item_count);
    const exact = Number.isFinite(n) && n > 0;
    const entry = { ...r, batch_count: exact ? n : 1 };
    byBatch.set(bid, { entry, exact });
    out.push(entry);
  }
  return out.slice(0, cap);
}

export function queryCounts(sql, userId) {
  // HOUSEHOLD-MODE: widened at V3-ROLES teardown
  const householdIds = householdScope(userId);
  return sql`
      SELECT
        (
          SELECT COUNT(*)::int
          FROM public.container
          WHERE created_by = ANY(${householdIds}) AND deleted_at IS NULL AND archived_at IS NULL
        ) AS project_count,
        (
          SELECT COUNT(*)::int
          FROM public.garden_node p
          JOIN public.container pp ON pp.id = p.container_id
          WHERE pp.created_by = ANY(${householdIds}) AND p.deleted_at IS NULL AND p.archived_at IS NULL AND pp.deleted_at IS NULL AND pp.archived_at IS NULL
        ) AS plant_count,
        (
          SELECT COUNT(*)::int
          FROM locations
          WHERE deleted_at IS NULL AND created_by = ANY(${householdIds})
        ) AS location_count
    `;
}

export function queryFavoriteCount(sql, userId) {
  return sql`
      SELECT COUNT(*)::int AS count
      FROM favorites
      WHERE user_id = ${userId}
    `;
}

// Care re-key: the container care rollup.
//
// entity_memory is keyed on the PLANTING (plant_id), so every project-level display here reads the rollup:
// the container's care recency = the newest of { its plantings' rows } UNION { its own row }.
// Both arms are load-bearing. The plant arm is the real per-planting history. The project arm covers
// project-LEVEL events that carry no plant_id, and containers with a project row but no plant rows;
// dropping either silently blanks containers on the dashboard. GREATEST/MAX ignore NULLs, so a container
// with one arm populated still reports it. The OR in the rollup predicate may skip an index; at 344 rows
// that is deliberate.
//
// The rollup is written out at each call site because a `sql` fragment cannot be interpolated into
// another neon template without becoming a bound parameter. care-rekey-reads.test.js pins the shape.
//
// Lifecycle filter (BUG-ROLLUPLIFECYCLE-001), NOT uniform on purpose: a rollup that crosses a threshold,
// decides eligibility or ranks a list must range over the SAME population as the eligibility guard next
// to it; a rollup only displayed as history may range wider.
//   - ACTIONABLE queries carry the full predicate (deleted_at IS NULL AND archived_at IS NULL AND status
//     NOT IN (...)): queryWaterDue (legacy MIN), queryWaterDueFromPlan (plan_rows display join and
//     legacy_rows MIN), queryHarvestReady, queryHeadsUp stale. `archived_at IS NULL` alone would not close
//     it: a `failed` planting is dead tissue with a frozen date, and `dormant` is suppressed by the
//     daily-plan engine. Without it the bar says "water due" with an empty due list, and the error only
//     grows, because an archived planting's dates never advance.
//   - HISTORY queries keep archived plantings (archiving does not un-happen events): queryActiveProjects
//     (recent activity), queryInactiveList. lambda/projects/index.js's four last_activity_at copies too.
// Harm differs by aggregate: the water-due MIN going DOWN gives a false POSITIVE; the observation MAXes
// going UP suppress a genuine stale/harvest alert. Soft-deleted plantings are excluded everywhere.
//
// BUG-WATERBARARCHIVED-001: the lifecycle predicate repeats up to FOUR times per actionable query: the
// rollup arm, the EXISTS guard, the displayed `plantings` json_agg and, in queryHeadsUp, a per-event
// `gn.id = el.plant_id` filter. rollup-lifecycle.test.js compares rollup against guard;
// waterbar-archived.test.js pins ALL sites to one population by mutual agreement. Edit them together
// or that file goes red naming the outlier.
export function queryActiveProjects(sql, userId) {
  // HOUSEHOLD-MODE: widened at V3-ROLES teardown
  const householdIds = householdScope(userId);
  // This tile feeds project COUNT, the harvest-status gate and zero-state ONLY; it renders no
  // water/care verdict. Never wire raw entity_memory next_water_at here (the rain-blind "false
  // Overdue" class); source any per-project water cue from queryWaterDueFromPlan. Guarded by
  // index.test.js "queryActiveProjects carries no naive water verdict".
  return sql`
      SELECT
        pp.id, pp.display_name AS name, pp.status, pp.variety, pp.start_date,
        em.last_watered_at, em.last_observed_at, em.last_fertilized_at,
        em.last_pruned_at, em.last_harvested_at, em.last_event_at
      FROM public.container pp
      LEFT JOIN LATERAL (
        SELECT MAX(m.last_watered_at)    AS last_watered_at,
               MAX(m.last_observed_at)   AS last_observed_at,
               MAX(m.last_fertilized_at) AS last_fertilized_at,
               MAX(m.last_pruned_at)     AS last_pruned_at,
               MAX(m.last_harvested_at)  AS last_harvested_at,
               MAX(m.last_event_at)      AS last_event_at
          FROM entity_memory m
         WHERE m.project_id = pp.id
            OR m.plant_id IN (SELECT gp.id FROM public.garden_node gp
                               WHERE gp.container_id = pp.id AND gp.deleted_at IS NULL)
      ) em ON TRUE
      WHERE pp.created_by = ANY(${householdIds})
        AND pp.deleted_at IS NULL
        AND pp.archived_at IS NULL
      ORDER BY pp.created_at DESC
    `;
}

// `level`, `xp_into_level` and `xp_to_next_level` come from public.xp_level_floor() rather than JS: one
// definition of the curve, server-side, shared with the trigger that maintains user_stats.level
// (migrations/v4-xpprogression-001/0a). Both derived fields are relative to the CURRENT band, so a
// progress bar is xp_into_level / (xp_into_level + xp_to_next_level) with no client-side threshold table.
export function queryUserStats(sql, userId) {
  return sql`
      SELECT current_streak, longest_streak, last_active_date, total_events, xp,
             level,
             -- Read from the STORED level, not recomputed from xp, so the bar the user sees is the
             -- same level the achievement evaluator judges "Reach level 5" against. GREATEST(0, …)
             -- is the only concession: if the stored level ever drifted below xp the bar would
             -- otherwise render negative. It cannot drift (trg_user_stats_level + the
             -- post_every_user_stats_row_satisfies_level_equals_xp_level gate), and the clamp is
             -- here so a drift degrades to a full bar rather than to a broken one.
             GREATEST(0, xp - public.xp_level_floor(level))::int     AS xp_into_level,
             GREATEST(0, public.xp_level_floor(level + 1) - xp)::int AS xp_to_next_level,
             public.xp_level_floor(level + 1)::int                   AS next_level_at
      FROM user_stats
      WHERE user_id = ${userId}
    `;
}

// DISTINCT activity days (by event_date in the user's TZ) + today, for the live streak recompute via
// the pure helper. Per-USER (created_by): a streak is the user's own activity, not household-scoped.
//
// This recompute is AUTHORITATIVE for what the user sees: handleDashboard overwrites
// storedStats.current_streak with computeStreak(activityDays, ...). So it must filter
// NON_REWARD_EVENT_TYPES, or tapping "I checked the soil" daily would sustain a streak (a farmable
// loop). The filter is on the activity-DAY subquery only; `today` is a clock reading, not an event aggregate.
export function queryActivityDays(sql, userId) {
  return sql`
      WITH z AS (
        SELECT COALESCE((SELECT user_timezone FROM profiles WHERE id = ${userId}), 'America/New_York') AS tz
      )
      SELECT
        to_char((NOW() AT TIME ZONE (SELECT tz FROM z))::date, 'YYYY-MM-DD') AS today,
        COALESCE((
          SELECT json_agg(d ORDER BY d DESC) FROM (
            SELECT DISTINCT (e.event_date AT TIME ZONE (SELECT tz FROM z))::date AS d
            FROM event_log e
            WHERE e.created_by = ${userId}
              AND e.deleted_at IS NULL
              AND NOT (e.event_type = ANY(${NON_REWARD_EVENT_TYPES}::text[]))
              AND (e.event_date AT TIME ZONE (SELECT tz FROM z))::date
                  <= (NOW() AT TIME ZONE (SELECT tz FROM z))::date
          ) days
        ), '[]'::json) AS days
    `;
}

export function queryWaterDue(sql, userId) {
  // Caretaker scope: surface a project if assigned to this user, OR unassigned and created by this
  // user; a planting assigned to another household member must NOT show on this user's bar.
  // Suppress projects with no actionable planting: alert only when the container holds at least one
  // planting NOT in dormant/ended/failed/rooting (NULL status counts as actionable, fail-open toward alerting).
  // next_water_at is NULL on every plant-keyed row (design §8.1), so the rollup reconstitutes it at READ
  // time with the old interval ladder and takes the MIN: the most-overdue planting decides, and ORDER BY
  // sorts the worst first.
  return sql`
      SELECT
        pp.id AS project_id, pp.display_name AS project_name,
        em.last_watered_at, em.next_water_at,
        em.location_type, em.watering_interval_days,
        -- V3-ATTN-001: actionable plantings in this container, so the band can alert the PLANTING not the project.
        COALESCE((
          SELECT json_agg(json_build_object('id', gn.id, 'name', gn.display_name) ORDER BY gn.display_name, gn.id)
          FROM public.garden_node gn
          WHERE gn.container_id = pp.id AND gn.deleted_at IS NULL AND gn.archived_at IS NULL
            AND (gn.status IS NULL OR gn.status NOT IN ('dormant','ended','failed','rooting'))
        ), '[]'::json) AS plantings
      FROM public.container pp
      LEFT JOIN LATERAL (
        SELECT MAX(m.last_watered_at)        AS last_watered_at,
               MAX(m.location_type)          AS location_type,
               MAX(m.watering_interval_days) AS watering_interval_days,
               MIN(COALESCE(m.next_water_at,
                            m.last_watered_at
                              + (COALESCE(m.watering_interval_days, 4)::int * INTERVAL '1 day'))) AS next_water_at
          FROM entity_memory m
         WHERE m.project_id = pp.id
            OR m.plant_id IN (SELECT gp.id FROM public.garden_node gp
                               WHERE gp.container_id = pp.id AND gp.deleted_at IS NULL
                                     AND gp.archived_at IS NULL
                                     AND (gp.status IS NULL OR gp.status NOT IN ('dormant','ended','failed','rooting')))
      ) em ON TRUE
      WHERE (pp.assignee_user_id = ${userId} OR (pp.assignee_user_id IS NULL AND pp.created_by = ${userId}))
        AND pp.deleted_at IS NULL
        AND pp.archived_at IS NULL
        AND em.next_water_at IS NOT NULL
        AND em.next_water_at < NOW()
        AND EXISTS (
          SELECT 1 FROM public.garden_node gn
          WHERE gn.container_id = pp.id
            AND gn.deleted_at IS NULL
            AND gn.archived_at IS NULL
            AND (gn.status IS NULL OR gn.status NOT IN ('dormant','ended','failed','rooting'))
        )
      ORDER BY em.next_water_at ASC
    `;
}

// The alert bar's "needs water" derives from the SAME nightly DrG/care engine verdict the Today page
// reads (daily_plan), not the naive entity_memory cadence (DRG-WATERRECON-001: the two disagreed on
// ~100% of containers). This query (a) reads today's per-user daily_plan water_due, (b) drops plantings
// already satisfied today by a watering/rain/moisture_check event_log row in ET, (c) groups by container
// into the band's row shape, (d) LEFT JOINs entity_memory + container for display fields. With no plan
// row for today it FALLS BACK to the legacy entity_memory query so the bar never blanks, flagged via
// water_due_source. ONE sql call (drop-in for queryWaterDue in handleDashboard's Promise.all; preserves
// the FIFO contract its tests assert).
//
// TRAP: (b) is NOT daily-plan-read.annotateDone. The `fresh` CTE below is an independent ET-day rule
// without annotateDone's feed-cadence widening (doneEvents.fedWithinInterval, BUG-BACKDATEDFEED-001).
// Harmless for watering, where the ET day IS the whole rule; extend this query to feed tiles without
// porting the cadence arm and the bar nags with Today checked off.
export function queryWaterDueFromPlan(sql, userId) {
  return sql`
      WITH params AS (SELECT (now() AT TIME ZONE 'America/New_York')::date AS et_today),
      plan AS (
        SELECT items, (items->>'schema_version')::int AS sv FROM daily_plan, params
        WHERE user_id = ${userId} AND plan_date = et_today
      ),
      -- DRG-WATERRECON-002 schema_version guard: a plan is TRUSTED when its stamped schema_version matches
      -- (compat) OR is NULL (a pre-stamp legacy row, whose shape == current v1 — served, no false alarm on
      -- the ship-day transition). Only a PRESENT-but-DIFFERENT version (a real shape drift) falls through to
      -- legacy + is flagged 'schema_mismatch' so handleDashboard logs it LOUD.
      plan_present AS (SELECT EXISTS(SELECT 1 FROM plan) AS present),
      compat AS (SELECT EXISTS(SELECT 1 FROM plan WHERE sv IS NULL OR sv = ${PLAN_SCHEMA_VERSION}) AS ok),
      wd AS (
        -- defensive: jsonb_array_elements THROWS on a JSON scalar/null (would 500 the whole dashboard);
        -- coalesce a malformed/absent water_due to an empty array. Drop elements missing id/project_id.
        SELECT (e->>'id') AS plant_id, (e->>'project_id') AS project_id, (e->>'name') AS name,
               -- DEFENSIVE (V4-WATERMATH-001). This was COALESCE((e->>'overdue_by')::int, 0), and
               -- ::int THROWS 22P02 on ANY non-integer text — '2.3', and even '2.0' — which 500s the
               -- ENTIRE dashboard, not just this tile. COALESCE does not help: the cast fails before
               -- it, and the jsonb_typeof guard above only protects the array, not the element. That
               -- is a live tripwire the F2 ledger walks straight into: the ledger's D is fractional
               -- by design, so the first fractional overdue_by the engine writes takes the dashboard
               -- down for every user until the plan row rolls over. Verified against live Neon: the
               -- old expression errors on 2.3; this one is total over 17 shapes (json number,
               -- numeric string, 'abc', '', null, absent, bool, array, object, 1e30, '2e3', ' 2 ').
               -- Regex-gated so only a plain decimal is cast at all; floor() because the field is
               -- "days overdue" and a partial day is not a whole one; LEAST/GREATEST because numeric
               -- accepts values that overflow int4 and would throw 22003 on the way out. Anything
               -- unparseable degrades to 0 (the row still renders, just unsorted) rather than 500ing.
               COALESCE(
                 -- The '\\.' is DELIBERATE: this is a JS template literal, where '\.' cooks to a bare
                 -- '.', and a bare '.' in a POSIX regex matches ANY character — so '2x3' would pass
                 -- the guard and then throw 22P02 inside ::numeric, reinstating the exact crash this
                 -- expression exists to prevent. Postgres must receive a literal backslash-dot.
                 CASE WHEN (e->>'overdue_by') ~ '^-?[0-9]+(\\.[0-9]+)?$'
                      THEN LEAST(GREATEST(floor((e->>'overdue_by')::numeric), -3650), 3650)::int
                 END, 0) AS overdue_by
        FROM plan,
             jsonb_array_elements(
               CASE WHEN jsonb_typeof(plan.items->'water_due') = 'array'
                    THEN plan.items->'water_due' ELSE '[]'::jsonb END) e
        -- CARE RE-KEY B5 — KNOWN GAP, DELIBERATELY LEFT OPEN AT STEP D. This predicate drops every
        -- plan item whose project_id is NULL, so a PROJECTLESS planting — the exact state the re-key
        -- exists to make loggable, and the state V4-PROJHIDE-001 makes ordinary — is silently
        -- dropped by the bar even when the engine says it needs water. Inert today (live prod: 0
        -- projectless plantings) but it arms the moment the feature ships.
        -- Not closed here because the fix is not server-only: the row is keyed and navigated by
        -- project_id in the client (Dashboard.jsx keys each row on w.project_id and navigates with
        -- goToLog(w.project_id)), so retaining a NULL-project row collides React keys and navigates
        -- to a non-route. The server half is ready — plant_name below gives the row its own subject
        -- — and the client half belongs to whoever lands PROJHIDE. See the V4-CAREKEY-001 report.
        WHERE (e->>'id') IS NOT NULL AND (e->>'project_id') IS NOT NULL
      ),
      -- V4-WATERMATH-001 F0. 'moisture_check' ("Not thirsty") joins the bar's satisfied-set in the
      -- SAME deploy as daily-plan-read's DONE_EVENTS.water_due — the :714 lockstep test enforces
      -- that pairing. Ship one without the other and the flagship tap visibly does nothing on
      -- whichever surface lagged, for up to ~11h.
      -- The rolling 24h arm is the interim pre-F2 snooze rule (canon V100 §"Pre-F2 interim snooze
      -- semantics"): an ET-day-only snooze tapped in the morning expires at midnight and re-nags at
      -- the next run, which extinguishes the affordance. watering/rain are untouched and keep the
      -- ET-calendar-day rule. Superseded by the engine fold at F2.
      fresh AS (
        SELECT DISTINCT ev.plant_id::text AS plant_id
        FROM event_log ev, params
        WHERE ev.deleted_at IS NULL AND ev.event_type IN ('watering','rain','moisture_check')
          AND ev.plant_id::text IN (SELECT plant_id FROM wd)
          AND (
                (ev.event_date AT TIME ZONE 'America/New_York')::date = et_today
                OR (ev.event_type = 'moisture_check' AND ev.event_date > now() - INTERVAL '24 hours')
              )
      ),
      due AS (SELECT wd.* FROM wd WHERE NOT EXISTS (SELECT 1 FROM fresh f WHERE f.plant_id = wd.plant_id)),
      grouped AS (
        SELECT d.project_id, MAX(d.overdue_by) AS overdue_by,
               json_agg(json_build_object('id', d.plant_id, 'name', d.name) ORDER BY d.name, d.plant_id) AS plantings,
               -- V4-PROJHIDE-001 unblock (care re-key Step D): the planting-level subject the client
               -- already reaches for (Dashboard.jsx renders w.plant_name, falling back to the string
               -- "Water due", under the PROJECTS_HIDDEN branch) and that the server has never
               -- emitted. NULL when the group holds more than one planting, because then there IS no
               -- single subject and that fallback is the correct render. Purely additive: no
               -- existing key changes shape, and the flag-OFF branch never reads it.
               CASE WHEN count(*) = 1 THEN MIN(d.name) END AS plant_name
        FROM due d GROUP BY d.project_id
      ),
      plan_rows AS (
        SELECT g.project_id, pp.display_name AS project_name,
               em.last_watered_at, em.location_type, em.watering_interval_days,
               (now() - make_interval(days => GREATEST(g.overdue_by, 0)))::timestamptz AS next_water_at,
               g.plantings, g.plant_name, 'plan'::text AS water_due_source
        FROM grouped g
        JOIN public.container pp ON pp.id = g.project_id::uuid
        LEFT JOIN LATERAL (
          SELECT MAX(m.last_watered_at)        AS last_watered_at,
                 MAX(m.location_type)          AS location_type,
                 MAX(m.watering_interval_days) AS watering_interval_days
            FROM entity_memory m
           WHERE m.project_id = pp.id
              OR m.plant_id IN (SELECT gp.id FROM public.garden_node gp
                                 WHERE gp.container_id = pp.id AND gp.deleted_at IS NULL
                                       AND gp.archived_at IS NULL
                                       AND (gp.status IS NULL OR gp.status NOT IN ('dormant','ended','failed','rooting')))
        ) em ON TRUE
        WHERE pp.deleted_at IS NULL AND pp.archived_at IS NULL
      ),
      legacy_rows AS (
        SELECT pp.id::text AS project_id, pp.display_name AS project_name,
               em.last_watered_at, em.location_type, em.watering_interval_days,
               em.next_water_at,
               COALESCE((
                 SELECT json_agg(json_build_object('id', gn.id, 'name', gn.display_name) ORDER BY gn.display_name, gn.id)
                 FROM public.garden_node gn
                 WHERE gn.container_id = pp.id AND gn.deleted_at IS NULL AND gn.archived_at IS NULL
                   AND (gn.status IS NULL OR gn.status NOT IN ('dormant','ended','failed','rooting'))
               ), '[]'::json) AS plantings,
               NULL::text AS plant_name,
               CASE WHEN (SELECT present FROM plan_present) THEN 'schema_mismatch' ELSE 'legacy' END AS water_due_source
        FROM public.container pp
        LEFT JOIN LATERAL (
          SELECT MAX(m.last_watered_at)        AS last_watered_at,
                 MAX(m.location_type)          AS location_type,
                 MAX(m.watering_interval_days) AS watering_interval_days,
                 MIN(COALESCE(m.next_water_at,
                              m.last_watered_at
                                + (COALESCE(m.watering_interval_days, 4)::int * INTERVAL '1 day'))) AS next_water_at
            FROM entity_memory m
           WHERE m.project_id = pp.id
              OR m.plant_id IN (SELECT gp.id FROM public.garden_node gp
                                 WHERE gp.container_id = pp.id AND gp.deleted_at IS NULL
                                       AND gp.archived_at IS NULL
                                       AND (gp.status IS NULL OR gp.status NOT IN ('dormant','ended','failed','rooting')))
        ) em ON TRUE
        WHERE (pp.assignee_user_id = ${userId} OR (pp.assignee_user_id IS NULL AND pp.created_by = ${userId}))
          AND pp.deleted_at IS NULL AND pp.archived_at IS NULL
          AND em.next_water_at IS NOT NULL AND em.next_water_at < now()
          AND EXISTS (
            SELECT 1 FROM public.garden_node gn
            WHERE gn.container_id = pp.id AND gn.deleted_at IS NULL AND gn.archived_at IS NULL
              AND (gn.status IS NULL OR gn.status NOT IN ('dormant','ended','failed','rooting'))
          )
      )
      SELECT * FROM plan_rows  WHERE     (SELECT ok FROM compat)
      UNION ALL
      SELECT * FROM legacy_rows WHERE NOT (SELECT ok FROM compat)
      ORDER BY next_water_at ASC
    `;
}

// harvest_ready tile: status='harvesting', oldest last_observed_at first. days_since_obs may be NULL.
export function queryHarvestReady(sql, userId) {
  // HOUSEHOLD-MODE: widened at V3-ROLES teardown
  const householdIds = householdScope(userId);
  return sql`
      SELECT pp.id AS project_id, pp.display_name AS name, pp.status,
             em.last_observed_at,
             (NOW()::date - em.last_observed_at::date)::int AS days_since_obs
      FROM public.container pp
      LEFT JOIN LATERAL (
        SELECT MAX(m.last_observed_at) AS last_observed_at
          FROM entity_memory m
         WHERE m.project_id = pp.id
            OR m.plant_id IN (SELECT gp.id FROM public.garden_node gp
                               WHERE gp.container_id = pp.id AND gp.deleted_at IS NULL
                                     AND gp.archived_at IS NULL
                                     AND (gp.status IS NULL OR gp.status NOT IN ('dormant','ended','failed','rooting')))
      ) em ON TRUE
      WHERE pp.status = 'harvesting'
        AND pp.created_by = ANY(${householdIds})
        AND pp.deleted_at IS NULL
        AND pp.archived_at IS NULL
      ORDER BY em.last_observed_at ASC NULLS LAST
      LIMIT 5
    `;
}

// heads_up tile: flagged-unresolved union active-growth stale. The NOT EXISTS dedup surfaces a project
// ONCE (as 'flagged' if it has both). Stale falls back to last_event_at/created_at when
// last_observed_at is NULL. Severity sorts DESC NULLS LAST, so stale (NULL severity) is last.
export function queryHeadsUp(sql, userId) {
  return sql`
      WITH flagged AS (
        SELECT DISTINCT ON (el.project_id)
          el.project_id,
          pp.display_name AS name,
          'flagged'::text AS reason,
          el.severity,
          el.created_at AS event_at,
          (NOW()::date - el.created_at::date)::int AS days_stale,
          '[]'::json AS plantings
        FROM event_log el
        JOIN public.container pp ON pp.id = el.project_id
          AND (pp.assignee_user_id = ${userId} OR (pp.assignee_user_id IS NULL AND pp.created_by = ${userId})) AND pp.deleted_at IS NULL AND pp.archived_at IS NULL
        WHERE el.flagged_as_issue = true
          AND el.resolved_at IS NULL
          AND el.deleted_at IS NULL
          -- BUG-FLAGGEDDORMANT-001: this arm joins the CONTAINER only and never touched garden_node,
          -- so a flagged issue on a non-actionable planting still lit the container as needing
          -- attention. Its stale sibling 20 lines below carries the full predicate three times —
          -- this was the narrower-exclusion odd one out, not a deliberate difference.
          -- Gated on the flagged event's OWN planting rather than the sibling "container holds any
          -- actionable planting" EXISTS, because that is the precise claim: this alert is about THIS
          -- issue. A project-level issue (plant_id NULL) is unaffected.
          -- Measured on prod 2026-08-10 before changing: ZERO unresolved flagged rows exist, so this
          -- closes a latent leak at zero live blast radius rather than moving anything Dave sees today.
          AND (el.plant_id IS NULL OR EXISTS (
                SELECT 1 FROM public.garden_node gn
                WHERE gn.id = el.plant_id AND gn.deleted_at IS NULL AND gn.archived_at IS NULL
                  AND (gn.status IS NULL OR gn.status NOT IN ('dormant','ended','failed','rooting'))
              ))
        ORDER BY el.project_id, el.severity DESC NULLS LAST, el.created_at DESC
      ),
      stale AS (
        SELECT pp.id AS project_id,
               pp.display_name AS name,
               'stale'::text AS reason,
               NULL::smallint AS severity,
               em.last_observed_at AS event_at,
               (NOW()::date - em.last_observed_at::date)::int AS days_stale,
               -- V3-ATTN-001: actionable plantings so the stale alert names the PLANTING not the project.
               COALESCE((
                 SELECT json_agg(json_build_object('id', gn.id, 'name', gn.display_name) ORDER BY gn.display_name, gn.id)
                 FROM public.garden_node gn
                 WHERE gn.container_id = pp.id AND gn.deleted_at IS NULL AND gn.archived_at IS NULL
                   AND (gn.status IS NULL OR gn.status NOT IN ('dormant','ended','failed','rooting'))
               ), '[]'::json) AS plantings
        FROM public.container pp
        LEFT JOIN LATERAL (
          SELECT MAX(m.last_observed_at) AS last_observed_at,
                 MAX(m.last_event_at)    AS last_event_at
            FROM entity_memory m
           WHERE m.project_id = pp.id
              OR m.plant_id IN (SELECT gp.id FROM public.garden_node gp
                                 WHERE gp.container_id = pp.id AND gp.deleted_at IS NULL
                                       AND gp.archived_at IS NULL
                                       AND (gp.status IS NULL OR gp.status NOT IN ('dormant','ended','failed','rooting')))
        ) em ON TRUE
        WHERE pp.status IN ('sprouting','growing','flowering','fruiting')
          AND (pp.assignee_user_id = ${userId} OR (pp.assignee_user_id IS NULL AND pp.created_by = ${userId}))
          AND pp.deleted_at IS NULL
          AND pp.archived_at IS NULL
          AND EXISTS (
          SELECT 1 FROM public.garden_node gn
          WHERE gn.container_id = pp.id
            AND gn.deleted_at IS NULL
            AND gn.archived_at IS NULL
            AND (gn.status IS NULL OR gn.status NOT IN ('dormant','ended','failed','rooting'))
        )
          AND (
            (em.last_observed_at IS NULL
              AND COALESCE(em.last_event_at, pp.created_at) < NOW() - INTERVAL '21 days')
            OR (em.last_observed_at < NOW() - INTERVAL '21 days')
          )
          AND NOT EXISTS (
            SELECT 1 FROM event_log el2
            WHERE el2.project_id = pp.id
              AND el2.flagged_as_issue = true
              AND el2.resolved_at IS NULL
              AND el2.deleted_at IS NULL
          )
      )
      SELECT * FROM flagged
      UNION ALL
      SELECT * FROM stale
      ORDER BY severity DESC NULLS LAST, event_at ASC
      LIMIT 10
    `;
}

// inactive_projects_count: harvested/ended status, NOT dismissed by this user. 'harvested' is a
// LOGGABLE project status (harvesting is repeatable, LOGGABLE_PROJECT_STATUSES in src/lib/constants.js),
// so grouping it with 'ended' as "inactive" is semantically loose. Deprioritized: the dashboard
// projects-list UI is hidden, so the count is not user-visible. Revisit only if that list returns.
export function queryInactiveCount(sql, userId) {
  // HOUSEHOLD-MODE: widened at V3-ROLES teardown
  const householdIds = householdScope(userId);
  return sql`
      SELECT COUNT(*)::int AS count
      FROM public.container pp
      WHERE pp.status IN ('harvested','ended')
        AND pp.created_by = ANY(${householdIds})
        AND pp.deleted_at IS NULL
        AND pp.archived_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM inactive_project_dismissals d
          WHERE d.user_id = ${userId} AND d.project_id = pp.id
        )
    `;
}

// GET /api/projects/inactive. Undismissed first, then last_event_at DESC. No pagination
// (fine at <100 inactive projects per user).
export function queryInactiveList(sql, userId) {
  // HOUSEHOLD-MODE: widened at V3-ROLES teardown
  const householdIds = householdScope(userId);
  return sql`
    SELECT pp.id, pp.display_name AS name, pp.variety, pp.status,
           pp.start_date,
           em.last_event_at,
           em.last_harvested_at,
           CASE WHEN d.dismissed_at IS NULL THEN false ELSE true END AS dismissed,
           d.dismissed_at
    FROM public.container pp
    LEFT JOIN LATERAL (
      SELECT MAX(m.last_event_at)     AS last_event_at,
             MAX(m.last_harvested_at) AS last_harvested_at
        FROM entity_memory m
       WHERE m.project_id = pp.id
          OR m.plant_id IN (SELECT gp.id FROM public.garden_node gp
                             WHERE gp.container_id = pp.id AND gp.deleted_at IS NULL)
    ) em ON TRUE
    LEFT JOIN inactive_project_dismissals d
      ON d.project_id = pp.id AND d.user_id = ${userId}
    WHERE pp.status IN ('harvested','ended')
      AND pp.created_by = ANY(${householdIds})
      AND pp.deleted_at IS NULL
      AND pp.archived_at IS NULL
    ORDER BY d.dismissed_at IS NULL DESC, em.last_event_at DESC NULLS LAST
  `;
}

// POST /api/projects/inactive/:projectId/dismiss. Single-CTE ownership check + idempotent dismiss;
// UUID validated upstream. COALESCE covers the case where ON CONFLICT DO NOTHING returns empty but
// the row exists. status='not_found' (no owned row) -> 404, the existence-oblivious cross-tenant
// pattern; status='dismissed' -> 200 with { dismissed: true, dismissed_at }.
export function queryDismissInactive(sql, userId, projectId) {
  // HOUSEHOLD-MODE: widened at V3-ROLES teardown
  const householdIds = householdScope(userId);
  return sql`
    WITH owned AS (
      SELECT id FROM public.container
      WHERE id = ${projectId}::uuid
        AND created_by = ANY(${householdIds})
        AND status IN ('harvested','ended')
        AND deleted_at IS NULL
        AND archived_at IS NULL
      LIMIT 1
    ),
    upsert AS (
      INSERT INTO inactive_project_dismissals (user_id, project_id)
      SELECT ${userId}, id FROM owned
      ON CONFLICT (user_id, project_id) DO NOTHING
      RETURNING dismissed_at
    )
    SELECT
      CASE WHEN EXISTS (SELECT 1 FROM owned) THEN 'dismissed' ELSE 'not_found' END AS status,
      COALESCE(
        (SELECT dismissed_at FROM upsert),
        (SELECT dismissed_at FROM inactive_project_dismissals
          WHERE user_id = ${userId}
            AND project_id IN (SELECT id FROM owned))
      ) AS dismissed_at
  `;
}

export function queryGiveAttention(sql, userId) {
  // "Give attention to" is a PLANTING-level surface: rank plantings by last activity (a planting-specific
  // event OR a project-wide event with no plant_id) and surface the single oldest one inside the 24h-30d
  // "engaged-but-going-stale" window. Caretaker-scoped like water_due/heads_up; excludes
  // planning/harvested/ended projects and dormant/ended/failed/rooting plantings. >30d defers to the inactive surface.
  return sql`
      WITH planting_activity AS (
        SELECT gn.id AS plant_id, gn.display_name AS plant_name,
               gn.container_id AS project_id, pp.display_name AS project_name,
               MAX(e.event_date) AS last_event_at
        FROM public.garden_node gn
        JOIN public.container pp ON pp.id = gn.container_id
        LEFT JOIN event_log e
          ON (e.plant_id = gn.id OR (e.project_id = gn.container_id AND e.plant_id IS NULL))
         AND e.deleted_at IS NULL
        WHERE (pp.assignee_user_id = ${userId} OR (pp.assignee_user_id IS NULL AND pp.created_by = ${userId}))
          AND gn.deleted_at IS NULL AND gn.archived_at IS NULL
          AND pp.deleted_at IS NULL AND pp.archived_at IS NULL
          AND pp.status NOT IN ('planning','harvested','ended')
          AND (gn.status IS NULL OR gn.status NOT IN ('dormant','ended','failed','rooting'))
        GROUP BY gn.id, gn.display_name, gn.container_id, pp.display_name
      )
      SELECT plant_id, plant_name, project_id, project_name, last_event_at,
             (NOW()::date - last_event_at::date)::int AS days_stale
      FROM planting_activity
      WHERE last_event_at IS NOT NULL
        AND last_event_at < NOW() - INTERVAL '24 hours'
        AND last_event_at >= NOW() - INTERVAL '30 days'
      ORDER BY last_event_at ASC
      LIMIT 1
    `;
}

export async function handleDashboard(sql, userId) {
  // All aggregation queries fire concurrently; queryActivityDays is LAST and feeds the live streak recompute.
  // Per-tile isolation: allSettled so ONE failing tile degrades to a safe fallback + a LOUD error log instead
  // of 500ing the whole dashboard (DRG-WATERRECON-002). Order is the FIFO the tile tests assert; fallbacks
  // preserve the row shapes the assembly below indexes into (counts[0], favCount[0], inactiveCountRows[0]).
  const TILE_NAMES = ['recent_events','counts','favorites','active_projects','user_stats','water_due',
    'harvest_ready','heads_up','inactive_count','activity_days','give_attention'];
  const TILE_FALLBACKS = [
    [],                                                              // recentEvents
    [{ project_count: 0, plant_count: 0, location_count: 0 }],       // counts (indexed [0])
    [{ count: 0 }],                                                  // favCount (indexed [0])
    [],                                                              // activeProjects
    [],                                                              // userStatsRows
    [],                                                              // waterDue
    [],                                                              // harvestReady
    [],                                                              // headsUp
    [{ count: 0 }],                                                  // inactiveCountRows (indexed [0])
    [],                                                              // activityDaysRows
    [],                                                              // giveAttnRows
  ];
  const settled = await Promise.allSettled([
    queryRecentEvents(sql, userId),
    queryCounts(sql, userId),
    queryFavoriteCount(sql, userId),
    queryActiveProjects(sql, userId),
    queryUserStats(sql, userId),
    queryWaterDueFromPlan(sql, userId),
    queryHarvestReady(sql, userId),
    queryHeadsUp(sql, userId),
    queryInactiveCount(sql, userId),
    queryActivityDays(sql, userId),
    queryGiveAttention(sql, userId),
  ]);
  // I33 (BUG-LAMBDAERRPATHS-001): `degraded` names fallback tiles (top level, only when non-empty) so a failed
  // tile is not a silent real zero; every tile failing is an outage, so it 503s with a sentence the client
  // shows (api.js reads .error).
  const degraded = [];
  const [
    recentEvents,
    counts,
    favCount,
    activeProjects,
    userStatsRows,
    waterDue,
    harvestReady,
    headsUp,
    inactiveCountRows,
    activityDaysRows,
    giveAttnRows,
  ] = settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    console.error('[dashboard] tile query failed — served fallback (per-tile isolation, DRG-WATERRECON-002)',
      { userId, tile: TILE_NAMES[i], error: r.reason?.message ?? String(r.reason) });
    degraded.push(TILE_NAMES[i]);
    return TILE_FALLBACKS[i];
  });
  if (degraded.length === TILE_NAMES.length) {
    return resp(503, { error: 'The dashboard could not load. Try again in a minute.', degraded });
  }

  const storedStats = userStatsRows[0] ?? {
    current_streak: 0,
    longest_streak: 0,
    last_active_date: null,
    total_events: 0,
    xp: 0,
  };
  // Recompute the streak live from activity days so a stale streak never lingers. longest never regresses
  // below the stored value; xp / total_events come from the stored row. See streak.js.
  const act = activityDaysRows?.[0] ?? { today: null, days: [] };
  const activityDays = (act.days ?? []).map((d) => String(d).slice(0, 10));
  const computedStreak = computeStreak(activityDays, act.today, STREAK_GRACE_DAYS);
  // I33: a failed activity_days tile must not compute a streak of 0 from no days; null = unknown
  // (the client's `?? 0` renders it as today did, and nothing is announced).
  const userStats = {
    ...storedStats,
    current_streak: degraded.includes('activity_days') ? null : computedStreak.current,
    longest_streak: Math.max(computedStreak.longest, storedStats.longest_streak ?? 0),
    last_active_date: activityDays.length ? activityDays[0] : storedStats.last_active_date,
  };

  // Observability: both fallbacks are logged so the bar/Today divergence is never silent.
  if (Array.isArray(waterDue) && waterDue.some((r) => r && r.water_due_source === 'schema_mismatch')) {
    // A daily_plan row exists today but its items.schema_version != PLAN_SCHEMA_VERSION (shape drift):
    // reject-and-fall-back is LOUD so it never silently empties the bar.
    console.error('[water_due] daily_plan schema_version MISMATCH — rejected plan, served legacy fallback '
      + '(bump the bar + Today readers in lockstep with the engine)', { userId, expected: PLAN_SCHEMA_VERSION });
  } else if (Array.isArray(waterDue) && waterDue.some((r) => r && r.water_due_source === 'legacy')) {
    console.warn('[water_due] legacy fallback served — no daily_plan for today', { userId });
  }
  return resp(200, {
    recent_events: collapseBatches(recentEvents),
    active_projects: activeProjects,
    counts: {
      projects:  counts[0].project_count,
      plants:    counts[0].plant_count,
      locations: counts[0].location_count,
      favorites: favCount[0].count,
    },
    user_stats: userStats,
    water_due: waterDue,
    harvest_ready: harvestReady,
    heads_up: headsUp,
    inactive_projects_count: inactiveCountRows[0]?.count ?? 0,
    give_attention: giveAttnRows[0] ?? null,
    ...(degraded.length ? { degraded } : {}),
  });
}

export async function handleGetInactive(sql, userId) {
  const rows = await queryInactiveList(sql, userId);
  return resp(200, rows);
}

export async function handleDismissInactive(sql, userId, projectId) {
  const rows = await queryDismissInactive(sql, userId, projectId);
  const row = rows[0];
  if (!row || row.status === 'not_found') {
    return resp(404, { error: 'Not found' });
  }
  return resp(200, { dismissed: true, dismissed_at: row.dismissed_at });
}

// GET /api/search?q=...: seven per-entity parameterized ILIKE queries via Promise.allSettled (one failing
// section degrades to [] instead of 500ing the endpoint). Scoping predicates are copied VERBATIM from each
// entity's canonical read handler, never re-derived: plantings/events via parent container.created_by;
// projects/locations/inventory/photos via own created_by; varieties (cultivar) are globally readable. All
// filter deleted_at IS NULL (+ archived_at where the source handler does). private_notes (container,
// event_log) is excluded from BOTH predicate and projection. LIKE metacharacters are escaped and every
// pattern binds with explicit ESCAPE '\'. No S3/presign: photo rows return caption + parent ids only (the
// dashboard Lambda has no S3 env, L-072 class).

export const SEARCH_LIMIT = 20;
export const SEARCH_MIN_LEN = 2;
export const SEARCH_MAX_LEN = 64;

export function normalizeSearchQuery(raw) {
  const q = (raw ?? '').toString().replace(/\s+/g, ' ').trim();
  if (q.length < SEARCH_MIN_LEN || q.length > SEARCH_MAX_LEN) return null;
  return q;
}

// Escape LIKE metacharacters so q='%' cannot match every row.
export function likeEscape(q) {
  return q.replace(/[\\%_]/g, (m) => '\\' + m);
}

// A planting is findable by WHAT IT IS (cultivar name, crop-type slug and display name via two LEFT JOINs),
// not only by what it was named. The cultivar-name term is a judgment call: it only ever matched by
// coincidence via display_name. LEFT JOINs throughout: a planting with no cultivar_id must keep matching the
// four terms it already had. Neither join can fan out (cultivar.id is a key; crop_types slugs are unique).
export function searchPlantings(sql, userId, pat, prefixPat) {
  const householdIds = householdScope(userId);
  return sql`
      SELECT p.id, p.display_name AS name, p.status,
             p.container_id AS project_id, pp.display_name AS project_name,
             LEFT(COALESCE(p.notes, ''), 160) AS snippet
      FROM public.garden_node p
      JOIN public.container pp ON pp.id = p.container_id
      LEFT JOIN public.cultivar cv ON cv.id = p.cultivar_id
      LEFT JOIN public.crop_types ct ON ct.slug = cv.crop_type_slug
      WHERE pp.created_by = ANY(${householdIds})
        AND p.deleted_at IS NULL AND p.archived_at IS NULL
        AND pp.deleted_at IS NULL AND pp.archived_at IS NULL
        AND (p.display_name ILIKE ${pat} ESCAPE '\\'
             OR p.notes ILIKE ${pat} ESCAPE '\\'
             OR p.lineage_note ILIKE ${pat} ESCAPE '\\'
             OR p.container_type ILIKE ${pat} ESCAPE '\\'
             OR cv.display_name ILIKE ${pat} ESCAPE '\\'
             OR cv.crop_type_slug ILIKE ${pat} ESCAPE '\\'
             OR ct.display_name ILIKE ${pat} ESCAPE '\\'
             -- V4-CROPTYPEALIAS-001: the searchable second name. A crop must be findable by a name
             -- it is not STORED under — Charentais is filed under crop type 'melon' / display
             -- 'Melon', so q=cantaloupe returned nothing until this column existed. Deliberately a
             -- separate column and NOT more display_name parentheticals: display_name is SELECTed
             -- as crop_name by lambda/facebook-share/index.js:319 and reaches the text of a public
             -- Facebook/Instagram post, so widening it would publish the alias list.
             OR ct.search_aliases ILIKE ${pat} ESCAPE '\\')
      ORDER BY CASE WHEN p.display_name ILIKE ${prefixPat} ESCAPE '\\' THEN 0 ELSE 1 END,
               p.display_name ASC
      LIMIT 20
    `;
}

export function searchProjects(sql, userId, pat, prefixPat) {
  const householdIds = householdScope(userId);
  return sql`
      SELECT id, display_name AS name, status, species, variety,
             LEFT(COALESCE(description, ''), 160) AS snippet
      FROM public.container
      WHERE created_by = ANY(${householdIds})
        AND deleted_at IS NULL AND archived_at IS NULL
        AND (display_name ILIKE ${pat} ESCAPE '\\'
             OR description ILIKE ${pat} ESCAPE '\\'
             OR species ILIKE ${pat} ESCAPE '\\'
             OR variety ILIKE ${pat} ESCAPE '\\')
      ORDER BY CASE WHEN display_name ILIKE ${prefixPat} ESCAPE '\\' THEN 0 ELSE 1 END,
               display_name ASC
      LIMIT 20
    `;
}

export function searchLocations(sql, userId, pat, prefixPat) {
  const householdIds = householdScope(userId);
  return sql`
      SELECT id, name, type_label
      FROM locations
      WHERE created_by = ANY(${householdIds})
        AND deleted_at IS NULL
        AND (name ILIKE ${pat} ESCAPE '\\'
             OR description ILIKE ${pat} ESCAPE '\\'
             OR notes ILIKE ${pat} ESCAPE '\\'
             OR type_label ILIKE ${pat} ESCAPE '\\')
      ORDER BY CASE WHEN name ILIKE ${prefixPat} ESCAPE '\\' THEN 0 ELSE 1 END,
               name ASC
      LIMIT 20
    `;
}

// Varieties are globally readable: no created_by filter (verbatim from the lambda/varieties GET list).
// CROP TYPE IS A MATCH AXIS (V4-SEARCHCROPTYPE-001): the cultivar name is the unreliable handle (users
// misspell heirloom and imported names), the crop type is the reliable one. Both the slug AND
// crop_types.display_name are matched, and the display name is load-bearing: 'bunching_onion' displays
// as "Onion (bunching / scallion)", so slug-only matching misses "scallion". LEFT JOIN, not JOIN: a
// cultivar with a null or dangling crop_type_slug must not vanish from results. It cannot fan out
// (crop_types slugs are unique).
export function searchVarieties(sql, pat, prefixPat) {
  return sql`
      SELECT c.id, c.display_name AS name, c.species, c.crop_type_slug, c.lifecycle,
             LEFT(COALESCE(c.care_notes, ''), 160) AS snippet
      FROM public.cultivar c
      LEFT JOIN public.crop_types ct ON ct.slug = c.crop_type_slug
      WHERE c.deleted_at IS NULL
        AND (c.display_name ILIKE ${pat} ESCAPE '\\'
             OR c.species ILIKE ${pat} ESCAPE '\\'
             OR c.genus ILIKE ${pat} ESCAPE '\\'
             OR c.care_notes ILIKE ${pat} ESCAPE '\\'
             OR c.soil_notes ILIKE ${pat} ESCAPE '\\'
             OR c.crop_type_slug ILIKE ${pat} ESCAPE '\\'
             OR ct.display_name ILIKE ${pat} ESCAPE '\\'
             -- V4-CROPTYPEALIAS-001 — THIS is the column that finally answers the sentence quoted
             -- above. Matching the display name got q=cucumber to Suyo Long, but 'cantaloupe' is a
             -- name the crop is not stored under at all: Charentais sits under crop type 'melon',
             -- display 'Melon', and no crop type anywhere is named cantaloupe.
             -- Measured per-column on prod 2026-08-28: q=cantaloupe matched 2 of the 4 melons —
             -- 'Cantaloupe' by its own name, 'Green Flesh' only through care_notes/soil_notes prose
             -- — and MISSED Charentais and Minnesota Mini. Not zero results, but partial ones that
             -- excluded the case Dave named, and the one hit that was not a name was prose-dependent.
             -- search_aliases carries alternates for 54 crop types, is matched HERE, and is rendered
             -- nowhere.
             OR ct.search_aliases ILIKE ${pat} ESCAPE '\\')
      ORDER BY CASE WHEN c.display_name ILIKE ${prefixPat} ESCAPE '\\' THEN 0 ELSE 1 END,
               c.display_name ASC
      LIMIT 20
    `;
}

export function searchEvents(sql, userId, pat) {
  const householdIds = householdScope(userId);
  return sql`
      SELECT e.id, e.event_type, e.title, e.event_date,
             e.project_id, e.plant_id, pp.display_name AS project_name,
             LEFT(COALESCE(e.notes, ''), 160) AS snippet
      FROM event_log e
      JOIN public.container pp ON pp.id = e.project_id
      WHERE pp.created_by = ANY(${householdIds})
        AND e.deleted_at IS NULL
        AND pp.deleted_at IS NULL AND pp.archived_at IS NULL
        -- BUG-ARCHIVEHIDE-002 (audit I31): and not on an ARCHIVED planting (the events feed's shape).
        AND NOT EXISTS (SELECT 1 FROM public.garden_node ga
                         WHERE ga.id = e.plant_id AND ga.archived_at IS NOT NULL)
        AND (e.title ILIKE ${pat} ESCAPE '\\'
             OR e.notes ILIKE ${pat} ESCAPE '\\'
             OR e.event_type ILIKE ${pat} ESCAPE '\\')
      ORDER BY e.created_at DESC
      LIMIT 20
    `;
}

// Seed rows are not capped at 20 (BUG-SEARCHSEEDCAP20-001). Header search shows seed packets and saved
// lots under their own "Seeds" group, split client-side on `category` (src/pages/Search.jsx), so one LIMIT
// 20 across every inventory category silently truncated Seeds. Seed rows take their own ceiling; every
// other category keeps LIMIT 20 and no longer loses slots to seed rows that sort first.
//
// ONE predicate, two caps: scope, soft-delete filter and matched columns are written once, in `hits`, so
// the groups cannot drift on who sees what. The sides are the client's own split: exactly 'seeds', and
// IS DISTINCT FROM 'seeds' for everything else, so a NULL category lands with the other inventory rather
// than vanishing. Ordering is name-prefix matches first, then name.
//
// SEARCH_SEED_CAP is a safety ceiling, not a page size. 2000 follows VARIETY_LIST_CAP
// (lambda/varieties/index.js); a full list of these six short fields stays far under Lambda's 6 MB
// response limit. Reaching it logs to CloudWatch rather than truncating in silence.
export const SEARCH_SEED_CAP = 2000;

export async function searchInventory(sql, userId, pat, prefixPat) {
  const householdIds = householdScope(userId);
  const rows = await sql`
      WITH hits AS (
        SELECT i.id, i.name, i.category, i.status, i.location_text,
               LEFT(COALESCE(i.notes, ''), 160) AS snippet,
               CASE WHEN i.name ILIKE ${prefixPat} ESCAPE '\\' THEN 0 ELSE 1 END AS prefix_rank
        FROM inventory_items i
        WHERE i.created_by = ANY(${householdIds})
          AND i.deleted_at IS NULL
          AND (i.name ILIKE ${pat} ESCAPE '\\'
               OR i.brand ILIKE ${pat} ESCAPE '\\'
               OR i.model ILIKE ${pat} ESCAPE '\\'
               OR i.category ILIKE ${pat} ESCAPE '\\'
               OR i.location_text ILIKE ${pat} ESCAPE '\\'
               OR i.notes ILIKE ${pat} ESCAPE '\\')
      )
      SELECT id, name, category, status, location_text, snippet
      FROM ((SELECT * FROM hits WHERE category = 'seeds'
             ORDER BY prefix_rank, name ASC
             LIMIT ${SEARCH_SEED_CAP}::int)
            UNION ALL
            (SELECT * FROM hits WHERE category IS DISTINCT FROM 'seeds'
             ORDER BY prefix_rank, name ASC
             LIMIT 20)) capped
      ORDER BY prefix_rank, name ASC
    `;
  if (rows.filter(r => r.category === 'seeds').length >= SEARCH_SEED_CAP) {
    console.error('search inventory hit SEARCH_SEED_CAP', SEARCH_SEED_CAP);
  }
  return rows;
}

// Supplier packet images are left out of photo search, as they are out of the unscoped Photo Library
// (lambda/photos/index.js, same literal; supplier-image-marker-sync.test.js). Every one carries a
// caption ("Seed packet · <supplier> (supplier image)"), so a search for a supplier or "packet" would
// answer with catalog pictures; the seed lot itself still matches under inventory. COALESCE:
// original_filename is NULL on most rows, and NOT LIKE on NULL would drop them. The pattern is SQL text,
// not a bound value: S12 in search.test.js holds every BOUND pattern to the escaped form.
export function searchPhotos(sql, userId, pat) {
  const householdIds = householdScope(userId);
  return sql`
      SELECT p.id, p.caption, p.project_id, p.plant_id, p.created_at
      FROM photos p
      LEFT JOIN public.container pp ON pp.id = p.project_id AND pp.deleted_at IS NULL
      WHERE p.created_by = ANY(${householdIds})
        AND p.deleted_at IS NULL
        AND COALESCE(p.original_filename, '') NOT LIKE 'vendor-image--%'
        -- BUG-ARCHIVEHIDE-002 (audit I32): the Photo Library's two archived-planting anti-joins
        -- (lambda/photos/index.js, unscoped list), copied: one for a photo on the planting, one for a
        -- photo on an event of the planting, scoped to a live event. Planting axis only, as there.
        AND NOT EXISTS (
          SELECT 1 FROM public.garden_node gna
          WHERE gna.id = p.plant_id AND gna.archived_at IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.event_log ea
          JOIN public.garden_node gne ON gne.id = ea.plant_id
          WHERE ea.id = p.event_id AND ea.deleted_at IS NULL
            AND gne.archived_at IS NOT NULL
        )
        -- T3b archive leftover: a photo on an ARCHIVED container is hidden, as in the Library's
        -- unscoped list. deleted_at sits in the JOIN, so a deleted container counts as no container
        -- and its photo stays visible (Library parity); no container at all passes.
        AND pp.archived_at IS NULL
        AND p.caption IS NOT NULL AND p.caption <> ''
        AND p.caption ILIKE ${pat} ESCAPE '\\'
      ORDER BY p.created_at DESC
      LIMIT 20
    `;
}

export const SEARCH_SECTIONS = ['plantings', 'projects', 'locations', 'varieties', 'events', 'inventory', 'photos'];

export async function handleSearch(sql, userId, rawQ) {
  const q = normalizeSearchQuery(rawQ);
  if (!q) return resp(400, { error: `Query must be ${SEARCH_MIN_LEN}-${SEARCH_MAX_LEN} characters` });
  const esc = likeEscape(q);
  const pat = '%' + esc + '%';
  const prefixPat = esc + '%';
  const settled = await Promise.allSettled([
    searchPlantings(sql, userId, pat, prefixPat),
    searchProjects(sql, userId, pat, prefixPat),
    searchLocations(sql, userId, pat, prefixPat),
    searchVarieties(sql, pat, prefixPat),
    searchEvents(sql, userId, pat),
    searchInventory(sql, userId, pat, prefixPat),
    searchPhotos(sql, userId, pat),
  ]);
  const results = {};
  // I33: a failed section is named at the TOP level, never inside `results` (Search.jsx spreads
  // results into its section list, so a key there would render as a section).
  const degraded = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') {
      results[SEARCH_SECTIONS[i]] = s.value;
    } else {
      console.error('search section failed:', SEARCH_SECTIONS[i], s.reason?.message ?? String(s.reason));
      results[SEARCH_SECTIONS[i]] = [];
      degraded.push(SEARCH_SECTIONS[i]);
    }
  });
  return resp(200, { query: q, results, ...(degraded.length ? { degraded } : {}) });
}
