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
          WHERE pp.created_by = ANY(${householdIds}) AND p.deleted_at IS NULL AND p.archived_at IS NULL AND pp.archived_at IS NULL
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

export function queryActiveProjects(sql, userId) {
  // HOUSEHOLD-MODE: widened at V3-ROLES teardown
  const householdIds = householdScope(userId);
  return sql`
      SELECT
        pp.id, pp.display_name AS name, pp.status, pp.variety, pp.start_date,
        em.last_watered_at, em.last_observed_at, em.last_fertilized_at,
        em.last_pruned_at, em.last_harvested_at, em.last_event_at,
        em.next_water_at, em.location_type, em.watering_interval_days
      FROM public.container pp
      LEFT JOIN entity_memory em ON em.project_id = pp.id
      WHERE pp.created_by = ANY(${householdIds})
        AND pp.deleted_at IS NULL
        AND pp.archived_at IS NULL
      ORDER BY pp.created_at DESC
    `;
}

export function queryUserStats(sql, userId) {
  return sql`
      SELECT current_streak, longest_streak, last_active_date, total_events, xp
      FROM user_stats
      WHERE user_id = ${userId}
    `;
}

// V1.2-streak-fix (2026-05-25): DISTINCT activity days (by event_date in the user's TZ) + today,
// for live streak recompute via the pure helper. Per-USER (created_by) — a streak is the user's
// own activity, not household-scoped. Recomputing here means the displayed streak is never stale.
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
  return sql`
      SELECT
        em.project_id, pp.display_name AS project_name,
        em.last_watered_at, em.next_water_at,
        em.location_type, em.watering_interval_days
      FROM entity_memory em
      JOIN public.container pp ON pp.id = em.project_id
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
      LEFT JOIN entity_memory em ON em.project_id = pp.id
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
          (NOW()::date - el.created_at::date)::int AS days_stale
        FROM event_log el
        JOIN public.container pp ON pp.id = el.project_id
          AND (pp.assignee_user_id = ${userId} OR (pp.assignee_user_id IS NULL AND pp.created_by = ${userId})) AND pp.deleted_at IS NULL AND pp.archived_at IS NULL
        WHERE el.flagged_as_issue = true
          AND el.resolved_at IS NULL
          AND el.deleted_at IS NULL
        ORDER BY el.project_id, el.severity DESC NULLS LAST, el.created_at DESC
      ),
      stale AS (
        SELECT pp.id AS project_id,
               pp.display_name AS name,
               'stale'::text AS reason,
               NULL::smallint AS severity,
               em.last_observed_at AS event_at,
               (NOW()::date - em.last_observed_at::date)::int AS days_stale
        FROM public.container pp
        LEFT JOIN entity_memory em ON em.project_id = pp.id
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
    LEFT JOIN entity_memory em ON em.project_id = pp.id
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

// ---- Composite handler bodies --------------------------------------------
// These compose the per-query builders. Pure in the sense that they don't
// import neon/Clerk — they accept `sql` from the caller.

export async function handleDashboard(sql, userId) {
  // §D Promise.all parallelization — all aggregation queries fire concurrently.
  // V1.2-streak-fix: + queryActivityDays (appended LAST) feeds the live streak recompute.
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
  ] = await Promise.all([
    queryRecentEvents(sql, userId),
    queryCounts(sql, userId),
    queryFavoriteCount(sql, userId),
    queryActiveProjects(sql, userId),
    queryUserStats(sql, userId),
    queryWaterDue(sql, userId),
    queryHarvestReady(sql, userId),
    queryHeadsUp(sql, userId),
    queryInactiveCount(sql, userId),
    queryActivityDays(sql, userId),
  ]);

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
