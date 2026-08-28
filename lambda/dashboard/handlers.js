// Pure handlers for /api/dashboard Lambda (V1.2a-2 Session 2).
// Extracted from index.js so unit tests can import without dragging in
// @neondatabase/serverless / @clerk/backend / @aws-sdk/* (which aren't installed
// at the app-level package and would break vitest resolution at CI load time).
//
// Mirrors the lambda/events/validators.js extraction pattern — the test file
// imports ONLY this module, never index.js. index.js remains the Lambda entry
// point and wires neon + Clerk + SecretsManager to these pure builders.
//
// Each builder is a function that accepts `sql` (a neon tagged-template) plus
// pure inputs, calls `sql\`...\`` to assemble the parameterized query, and
// returns the Promise. Under test, `sql` is a mock that records the template
// strings + bound values — enabling SQL-shape assertions without a real DB.

// F9 UUID regex — applied before any SQL fires so Postgres never sees a malformed UUID.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- Pure validators ------------------------------------------------------

import { householdScope } from './household.js';
import { computeStreak, STREAK_GRACE_DAYS } from './streak.js';
import { NON_REWARD_EVENT_TYPES } from './eventTypes.rewards.js';

// DRG-WATERRECON-002: pinned to lambda/daily-plan/engine.js PLAN_SCHEMA_VERSION (kept in lockstep by the
// anti-drift source test). The alert bar trusts a daily_plan ONLY when its stored items.schema_version
// matches; a present-but-mismatched plan (a field rename / shape drift) is REJECTED -> legacy fallback +
// a LOUD error log (water_due_source='schema_mismatch'), never a silently-empty/garbage verdict.
export const PLAN_SCHEMA_VERSION = 1;

// V4-SOFTDEL-001 F3 — POLICY SWITCH for events whose PLANTING is soft-deleted but whose
// CONTAINER is still live. Two defensible products, and this constant is the whole choice:
//   false (SHIPPED — preserves the pre-fix observable behavior): the event SURVIVES. The
//     watering/harvest really happened in that container; the user deleted a planting record,
//     not the history. The feed keeps rendering the deleted planting's name beside it.
//   true  (the alternative): the event is HIDDEN, symmetric with the container rule below.
// Deliberately NOT decided by this fix — flipping this one literal switches every event read
// surface at once (dashboard feed here + the 5 events-Lambda queries carrying the same
// predicate; softdel-feed.test.js asserts the two files' copies stay equal).
// Measured on prod 2026-08-06: 56 live events sit under a soft-deleted planting (Dave, of
// 12,356 live events) and 0 (Jen, of 13); 0 of them carry a harvest_log row.
// The CONTAINER rule is NOT a switch — a soft-deleted container always hides its events.
export const HIDE_EVENTS_UNDER_DELETED_PLANTING = false;

export function isValidUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

// Route classification — pure routing decision based on method + rawPath.
// Returns one of:
//   { kind: 'options' }
//   { kind: 'dashboard' }
//   { kind: 'inactive-list' }
//   { kind: 'inactive-dismiss', projectId }
//   { kind: 'method-not-allowed' }
//   { kind: 'not-found' }
//   { kind: 'uuid-not-found' }  — UUID parse failure on dismiss
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

// ---- Response shape -------------------------------------------------------

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

// ---- SQL query builders ---------------------------------------------------
// Each builder takes `sql` (neon tagged-template or test mock) + pure inputs
// and returns the awaitable result. The SQL string + bind params are visible
// to the test mock via the tagged-template signature.

// V3-FEED-001: collapsed feed cap — recent_events returns at most FEED_CAP entries AFTER
// collapseBatches() folds each Log Many batch into one entry.
export const FEED_CAP = 20;

export function queryRecentEvents(sql, userId) {
  // HOUSEHOLD-MODE: widened at V3-ROLES teardown
  // V3-FEED-001: raw window (LIMIT 200, pre-collapse) + batch linkage. batch_id comes from
  // event_log.metadata->>'batch_id' (written by POST /api/events/batch); event_batches.item_count
  // gives the exact batch size even when the 200-row window truncates a batch. 200 must
  // comfortably exceed FEED_CAP + the largest realistic batch (~113 plantings today; hard cap 500).
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
        -- Deleted-PLANTING policy — see HIDE_EVENTS_UNDER_DELETED_PLANTING. Disabled today, so
        -- this OR is TRUE on its first operand and the gn test never runs.
        AND (${HIDE_EVENTS_UNDER_DELETED_PLANTING}::boolean IS NOT TRUE
             OR e.plant_id IS NULL OR gn.deleted_at IS NULL)
      ORDER BY e.created_at DESC
      LIMIT 200
    `;
}

// V3-FEED-001 pure collapse: one Log Many batch -> ONE feed entry. Rows arrive created_at DESC;
// a batch anchors at its newest row (order otherwise preserved). batch_count prefers
// event_batches.item_count (exact, window-truncation-proof); falls back to occurrences seen in
// the raw window. Undone batches never appear (their events are soft-deleted upstream).
// Cap applies AFTER collapsing.
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
          WHERE deleted_at IS NULL
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

// ── Care re-key Step D (care-rekey-001 / V4-CAREKEY-001) — the container care rollup ────────────
//
// entity_memory is now keyed on the PLANTING (plant_id). Every project-level display in this file
// used to read a single `entity_memory` row keyed on the container, which is exactly the coarse
// cache the re-key retires. Repointing those reads at plant_id alone would be wrong in both
// directions, so each one is rewritten to the same rollup:
//
//     the container's care recency = the newest of { its plantings' rows } ∪ { its own row }
//
// Both arms are load-bearing, measured on live prod at cutover:
//   * plant arm  — 262 rows. The real per-planting care history. Without it the tiles go blank.
//   * project arm — 76 rows. Project-LEVEL events (55 live events carry no plant_id: 11 waterings,
//     14 observations, 13 photos, all status_changes) never attribute to any planting, and 7
//     containers have a project row with NO plant rows under them at all. Dropping this arm would
//     silently erase those containers from the dashboard. The 3-way exactly-one-parent CHECK keeps
//     this arm alive on purpose (design §2), so the rollup keeps reading it.
//
// GREATEST/MAX ignore NULLs in Postgres, so a container with only one arm populated still reports
// that arm. entity_memory is 344 rows total; the OR in the rollup predicate may not use either
// index, and at this size that is deliberate — clarity over a plan that saves microseconds.
//
// The rollup is written out at each call site rather than shared, because these are neon tagged
// templates: a `sql` fragment cannot be interpolated into another `sql` template without becoming a
// bound parameter. The shape is identical everywhere and care-rekey-reads.test.js pins it.
//
// ── BUG-ROLLUPLIFECYCLE-001 — the plant arm's lifecycle filter is NOT uniform, on purpose ────────
//
// The rule: **a rollup whose value crosses a threshold, decides eligibility, or ranks a list must
// range over the SAME population as the eligibility guard standing next to it. A rollup whose value
// is only displayed as history may range wider.**
//
// Every ACTIONABLE query here already builds its `plantings` array and/or its EXISTS guard with
// `deleted_at IS NULL AND archived_at IS NULL AND status NOT IN (...)`, while its rollup used
// `deleted_at IS NULL` alone. That is not a stylistic drift — it makes the row assert a claim and
// then name no planting that could be its subject: "water due", with an empty due list. Measured on
// prod 2026-08-10: the Peppers container was legacy-water-due SOLELY on an archived planting's
// frozen `last_watered_at`, honest verdict 2026-08-13. And because an archived planting's dates
// never advance again, that error is monotonic — it recedes further into the past every day rather
// than aging out.
//
// So the ACTIONABLE five carry the full actionability predicate:
//   :queryWaterDue (legacy MIN) · :queryWaterDueFromPlan plan_rows display join · its legacy_rows
//   MIN · :queryHarvestReady · :queryHeadsUp stale
// `archived_at IS NULL` alone would NOT close it: a `failed` planting is dead tissue with a frozen
// date, and `dormant` is the class the daily-plan engine already suppresses because interval-
// watering a dormant succulent rots the crown.
//
// The HISTORY two keep archived plantings, and must:
//   :queryActiveProjects (recent activity) · :queryInactiveList
// Archiving a planting does not un-happen its events. A bed that produced a full spring crop and had
// it pulled DID have activity, and the turnover date is the input to the succession decision.
// `lambda/projects/index.js`'s four `last_activity_at` copies are history for the same reason.
//
// Direction of harm differs by aggregate and is why both halves matter: the water-due MIN goes DOWN,
// producing a false POSITIVE; the observation MAXes go UP, SUPPRESSING a genuine stale/harvest alert.
// Soft-deleted plantings belong to neither class and are already excluded everywhere — a soft-delete
// is a retraction of the record, an archive is a completion of it.
//
// ── BUG-WATERBARARCHIVED-001 — the same predicate exists up to FOUR times per query ──────────────
// Each actionable query repeats the lifecycle predicate at: (1) the entity_memory rollup arm,
// (2) the EXISTS eligibility guard, (3) the displayed `plantings` json_agg, and in queryHeadsUp
// (4) a per-event `gn.id = el.plant_id` filter. rollup-lifecycle.test.js compares (1) against (2)
// only; copy (3) — the array this row DISPLAYS, and so the one that makes the contradiction visible
// to the grower — was unpinned, and a mutation dropping archived_at + 'rooting' from it left all 170
// dashboard tests green. waterbar-archived.test.js now pins ALL sites to one population, by mutual
// agreement rather than by literal, and alias/count-agnostically so a 5th copy is covered on sight.
// Edit any one of these and you must edit them together, or that file goes red naming the outlier.
export function queryActiveProjects(sql, userId) {
  // HOUSEHOLD-MODE: widened at V3-ROLES teardown
  const householdIds = householdScope(userId);
  // DRG-WXWATER-002b: this tile feeds project COUNT + harvest-status gate + zero-state ONLY — it renders
  // NO water/care verdict (the dashboard's only water cue is the water_due tile, already reconciled to the
  // daily-plan verdict via queryWaterDueFromPlan / DRG-WATERRECON-001). The naive entity_memory water fields
  // (next_water_at / location_type / watering_interval_days) that used to be selected here were dead weight
  // AND a latent divergence trap — a future surface wiring the raw next_water_at would reintroduce exactly the
  // rain-blind "false Overdue" class WXWATER-002 closes. Dropped. If a per-project water cue is ever wanted,
  // source it from the plan verdict (queryWaterDueFromPlan), never from raw entity_memory. Guarded by
  // index.test.js "queryActiveProjects carries no naive water verdict". Activity last_* timestamps stay.
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

// BUG-XPPROGRESSION-001 — `level` and `xp_to_next_level` added. Before this, the column was not
// selected at all, so even a correct level would have been invisible to every client: the app's
// only XP pixel is a bare number two taps deep in the streak modal, while /achievements has been
// printing "Reach level 5" as a locked hint the whole time.
// The two derived fields are computed by public.xp_level_floor() rather than in JS on purpose —
// one definition of the curve, server-side, shared with the trigger that maintains user_stats.level
// (migrations/v4-xpprogression-001/0a). The client renders a bar; it does not own the maths.
// xp_into_level / xp_to_next_level are both relative to the CURRENT band, so a progress bar is
// xp_into_level / (xp_into_level + xp_to_next_level) with no client-side threshold table.
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

// V1.2-streak-fix (2026-05-25): DISTINCT activity days (by event_date in the user's TZ) + today,
// for live streak recompute via the pure helper. Per-USER (created_by) — a streak is the user's
// own activity, not household-scoped. Recomputing here means the displayed streak is never stale.
//
// V4-WATERMATH-001 F0 (2026-08-12) — NON_REWARD_EVENT_TYPES filter. This recompute is AUTHORITATIVE
// for what the user sees: handleDashboard overwrites storedStats.current_streak with
// computeStreak(activityDays, …), so whatever this query returns IS the displayed streak, no matter
// what the write path stored. The events Lambda filters the reward partition out of its grant path,
// both of its recomputes and its achievement counts — but this is a THIRD, independent reader, and
// until now it counted every event type. Left unfiltered, tapping "I checked the soil" every morning
// would sustain a streak indefinitely: a rewarded farmable loop, which is the exact thing the
// partition exists to prevent.
//
// Scoped to the activity-DAY subquery only. The `today` term is a clock reading, not an event
// aggregate, so it takes no predicate — filtering there would be meaningless, and a blanket WHERE
// would be the easy mistake.
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
  // V3-SCOPE-002: caretaker scope — surface a project if assigned to this user, OR unassigned and
  //   created by this user. A planting assigned to another household member must NOT show on this
  //   user's bar (V3-SCOPE-001 scoped by created_by only, which missed reassigned-but-Dave-created rows).
  // V3-ATTN-002: suppress projects with no actionable planting — only alert when the container holds at
  //   least one planting NOT in dormant/ended/failed/rooting (NULL status counts as actionable, fail-open
  //   toward alerting). Empty/all-inactive containers never alert (alerts are planting-driven, not project-driven).
  // Care re-key Step D: driven off `container` + the rollup instead of `FROM entity_memory` keyed
  // on the container. next_water_at is NULL on every plant-keyed row (design §8.1), so the rollup
  // reconstitutes it at READ time with the same interval ladder the project row used to bake in —
  // and takes the MIN, not the MAX: this bar answers "does anything in here need water", so the
  // most-overdue planting decides, and the ORDER BY then sorts the worst first. That is a real
  // behaviour change, and the intended one: one overdue planting in a 66-planting container used to
  // be invisible behind a single container-wide verdict.
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

// DRG-WATERRECON-001 (2026-06-24): the alert bar's "needs water" now derives from the SAME nightly DrG/care engine
// verdict the Today page reads (daily_plan), instead of the naive entity_memory cadence — they were computing
// "needs water" independently and disagreed on ~100% of containers (e.g. Dracaena: engine 10d not-due vs the bar's
// 4d location-default; established 5-gal-bag peppers nagging daily). Single source of truth: the engine decides WHICH
// plantings are due; this query (a) reads today's per-user daily_plan water_due, (b) drops plantings already satisfied
// today via a watering/rain event_log row in ET (the SAME done-logic daily-plan-read.annotateDone uses, so bar and
// Today stay consistent on same-day logging), (c) groups by container into the band's existing row shape, and (d)
// LEFT JOINs entity_memory + container for the display fields the UI reads (last_watered_at, location_type). When no
// plan row exists for today (rare engine-skip), it FALLS BACK to the legacy entity_memory query so the bar never
// blanks — flagged via water_due_source so the silent-divergence case is observable. ONE sql call (drop-in for
// queryWaterDue in the handleDashboard Promise.all; preserves the FIFO contract its tests assert).
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

// §A Tile 3 — harvest_ready (status='harvesting', sort oldest last_observed_at).
// F1: days_since_obs computed via calendar-day arithmetic. May be NULL.
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

// §B Tile 4 — heads_up Hybrid A+C union.
// F1: days_stale via calendar-day arithmetic.
// F7: stale predicate tightened — handles NULL last_observed_at with last_event_at/created_at fallback.
// SQL-layer NOT EXISTS dedup ensures a project surfaces ONCE (as 'flagged' if it has both).
// ORDER BY severity DESC NULLS LAST → severity=3 sorts before severity=1; stale (NULL severity) last.
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

// §C inactive_projects_count — harvested/ended status, NOT dismissed by this user.
// NOTE (E3, 2026-06-04): 'harvested' is now a LOGGABLE project status — harvesting is
// repeatable (see LOGGABLE_PROJECT_STATUSES in src/lib/constants.js). This count still
// groups 'harvested' WITH 'ended' as "inactive", which is semantically loose now.
// DEPRIORITIZED per Dave: the dashboard projects-list UI is currently hidden, so this
// count is not user-visible. Revisit (split 'harvested' out of "inactive") only if that
// list is re-surfaced.
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

// §F GET /api/projects/inactive
// Per V002 §7 (canonical) — schema doc §5.4 superseded (no `ended_at` column).
// Sort: undismissed first (d.dismissed_at IS NULL DESC), then by last_event_at DESC.
// No pagination — acceptable at <100 inactive projects/user; revisit at V2 multi-user.
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

// §G POST /api/projects/inactive/:projectId/dismiss
// Single-CTE ownership-check + idempotent dismiss. F9 UUID validation done upstream.
// COALESCE handles idempotent case where ON CONFLICT DO NOTHING returns empty but row already exists.
// status='not_found' (no owned row) → 404 — matches existence-oblivious cross-tenant pattern.
// status='dismissed' → 200 with { dismissed: true, dismissed_at }.
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
  // V3-ATTNFILTER-001 (2026-06-22) — "Give attention to" is a PLANTING-level surface, not project-level.
  // A project being "stale" is meaningless (Dave: the tile showed "Herb Plants — 8 days ago", a container).
  // Rank individual plantings by last activity (a planting-specific event OR a project-wide event with no
  // plant_id), and surface the single oldest one still inside the 24h-30d "engaged-but-going-stale" window.
  // Caretaker-scoped (assignee, created_by fallback) like water_due/heads_up; excludes planning/harvested/
  // ended projects and dormant/ended/failed/rooting plantings (same actionable-planting filter as water_due).
  // >30d defers to the inactive surface, matching the prior project-level threshold.
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

// ---- Composite handler bodies --------------------------------------------
// These compose the per-query builders. Pure in the sense that they don't
// import neon/Clerk — they accept `sql` from the caller.

export async function handleDashboard(sql, userId) {
  // §D Promise.all parallelization — all aggregation queries fire concurrently.
  // V1.2-streak-fix: + queryActivityDays (appended LAST) feeds the live streak recompute.
  // DRG-WATERRECON-002 per-tile isolation: allSettled (not all) so ONE failing tile query degrades that
  // tile to a safe fallback + a LOUD error log, instead of rejecting the whole dashboard (a single bad
  // tile used to 500 the entire page). Order is the same FIFO the tile tests assert; fallbacks preserve the
  // exact row shapes the assembly below indexes into (counts[0], favCount[0], inactiveCountRows[0]).
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
    return TILE_FALLBACKS[i];
  });

  const storedStats = userStatsRows[0] ?? {
    current_streak: 0,
    longest_streak: 0,
    last_active_date: null,
    total_events: 0,
    xp: 0,
  };
  // V1.2-streak-fix (2026-05-25): recompute the streak live from activity days so a stale streak
  // never lingers (the old value only changed on POST). longest never regresses below the stored
  // value; xp / total_events still come from the stored row. See streak.js for the model.
  const act = activityDaysRows?.[0] ?? { today: null, days: [] };
  const activityDays = (act.days ?? []).map((d) => String(d).slice(0, 10));
  const computedStreak = computeStreak(activityDays, act.today, STREAK_GRACE_DAYS);
  const userStats = {
    ...storedStats,
    current_streak: computedStreak.current,
    longest_streak: Math.max(computedStreak.longest, storedStats.longest_streak ?? 0),
    last_active_date: activityDays.length ? activityDays[0] : storedStats.last_active_date,
  };

  // OBSERVABILITY (DRG-WATERRECON-001): the bar fell back to the legacy entity_memory verdict because no
  // daily_plan row exists for today (engine-skip) — surfaces the otherwise-silent bar/Today divergence on skip days.
  if (Array.isArray(waterDue) && waterDue.some((r) => r && r.water_due_source === 'schema_mismatch')) {
    // DRG-WATERRECON-002: a daily_plan row exists today but its items.schema_version != PLAN_SCHEMA_VERSION
    // — a field rename / shape drift. Reject-and-fall-back is LOUD here so it never silently empties the bar.
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

// ---- V4-SEARCH-002: server-side universal search ---------------------------
// GET /api/search?q=... — seven per-entity parameterized ILIKE queries run via
// Promise.allSettled (one failing section degrades to [] instead of 500ing the
// whole endpoint). Scoping predicates copied VERBATIM from each entity's
// canonical read handler (never re-derived): plantings/events scope via parent
// container.created_by; projects/locations/inventory/photos via own created_by;
// varieties (cultivar) are globally readable. All queries filter
// deleted_at IS NULL (+ archived_at where the source handler does).
// private_notes (container, event_log) excluded from BOTH predicate and
// projection by design. LIKE metacharacters escaped (wildcard-injection guard);
// every pattern binds with explicit ESCAPE '\'. No S3/presign here — photo rows
// return caption + parent ids only (dashboard Lambda has no S3 env; L-072 class).

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

// V4-SEARCHCROPTYPE-001 (BD-072) — a planting is now findable by WHAT IT IS, not only by what it was
// named. Three terms added over two LEFT JOINs: the cultivar's name, the crop-type slug, and the
// crop type's display name.
//
// THE CULTIVAR-NAME TERM IS A JUDGMENT CALL and is called out rather than buried. The ticket says
// "match on crop type, NOT JUST cultivar name", which presumes cultivar name is already matched —
// for plantings it only ever was by coincidence, via display_name. Measured on prod: of 231 live
// plantings carrying a cultivar, 140 are named exactly after it and 199 contain it, so 32 are
// findable by their variety today only if you know the name someone typed into the planting.
//
// LEFT JOINs throughout: a planting with no cultivar_id (a bare container, a rescue with no ID yet)
// must keep appearing for the four terms it already matched on. Neither join can fan out —
// cultivar.id is a key and crop_types has 150 rows with 150 distinct slugs.
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
             OR ct.display_name ILIKE ${pat} ESCAPE '\\')
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

// Varieties are globally readable — no created_by filter (verbatim from
// lambda/varieties GET list: "Globally readable — no created_by filter.").
// V4-SEARCHCROPTYPE-001 (BD-072, Dave 2026-08-28) — CROP TYPE IS A MATCH AXIS, not just a column we
// happen to select. Dave: "I don't always remember spelling — is it charentais? charantais?
// chantareis? but I know it is a cantaloupe." The cultivar name is the unreliable handle; the crop
// type is the reliable one, so crop-type matching is the fallback that makes search work at all for
// heirloom and imported names, not a nicety layered on top.
//
// BOTH the slug AND crop_types.display_name are matched, and the display name is the load-bearing
// half: 'bunching_onion' displays as "Onion (bunching / scallion)" and 'mache' as "Mache (Corn
// Salad)", so slug-only matching would miss every search for "scallion" or "corn salad". Measured on
// prod: Suyo Long matches NONE of the five columns this query used before for q='cucumber' — not
// display_name, species, genus, care_notes or soil_notes — so Dave's stated case genuinely failed.
//
// LEFT JOIN, not JOIN: a cultivar with a null or dangling crop_type_slug must not vanish from search
// results it already appeared in. Cannot fan out — crop_types is 150 rows with 150 distinct slugs.
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
             OR ct.display_name ILIKE ${pat} ESCAPE '\\')
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
        AND (e.title ILIKE ${pat} ESCAPE '\\'
             OR e.notes ILIKE ${pat} ESCAPE '\\'
             OR e.event_type ILIKE ${pat} ESCAPE '\\')
      ORDER BY e.created_at DESC
      LIMIT 20
    `;
}

export function searchInventory(sql, userId, pat, prefixPat) {
  const householdIds = householdScope(userId);
  return sql`
      SELECT i.id, i.name, i.category, i.status, i.location_text,
             LEFT(COALESCE(i.notes, ''), 160) AS snippet
      FROM inventory_items i
      WHERE i.created_by = ANY(${householdIds})
        AND i.deleted_at IS NULL
        AND (i.name ILIKE ${pat} ESCAPE '\\'
             OR i.brand ILIKE ${pat} ESCAPE '\\'
             OR i.model ILIKE ${pat} ESCAPE '\\'
             OR i.category ILIKE ${pat} ESCAPE '\\'
             OR i.location_text ILIKE ${pat} ESCAPE '\\'
             OR i.notes ILIKE ${pat} ESCAPE '\\')
      ORDER BY CASE WHEN i.name ILIKE ${prefixPat} ESCAPE '\\' THEN 0 ELSE 1 END,
               i.name ASC
      LIMIT 20
    `;
}

export function searchPhotos(sql, userId, pat) {
  const householdIds = householdScope(userId);
  return sql`
      SELECT p.id, p.caption, p.project_id, p.plant_id, p.created_at
      FROM photos p
      WHERE p.created_by = ANY(${householdIds})
        AND p.deleted_at IS NULL
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
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') {
      results[SEARCH_SECTIONS[i]] = s.value;
    } else {
      console.error('search section failed:', SEARCH_SECTIONS[i], s.reason?.message ?? String(s.reason));
      results[SEARCH_SECTIONS[i]] = [];
    }
  });
  return resp(200, { query: q, results });
}
