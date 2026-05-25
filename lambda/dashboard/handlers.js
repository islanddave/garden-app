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

export function queryRecentEvents(sql, userId) {
  // HOUSEHOLD-MODE: widened at V3-ROLES teardown
  const householdIds = householdScope(userId);
  return sql`
      SELECT
        e.id, e.event_type, e.event_date, e.created_at,
        pp.name AS project_name,
        pr.display_name
      FROM event_log e
      JOIN plant_projects pp ON pp.id = e.project_id
      LEFT JOIN profiles pr ON pr.id = e.logged_by
      WHERE pp.created_by = ANY(${householdIds})
        AND e.deleted_at IS NULL
      ORDER BY e.created_at DESC
      LIMIT 5
    `;
}

export function queryCounts(sql, userId) {
  // HOUSEHOLD-MODE: widened at V3-ROLES teardown
  const householdIds = householdScope(userId);
  return sql`
      SELECT
        (
          SELECT COUNT(*)::int
          FROM plant_projects
          WHERE created_by = ANY(${householdIds}) AND deleted_at IS NULL
        ) AS project_count,
        (
          SELECT COUNT(*)::int
          FROM plants p
          JOIN plant_projects pp ON pp.id = p.project_id
          WHERE pp.created_by = ANY(${householdIds}) AND p.deleted_at IS NULL
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
        pp.id, pp.name, pp.status, pp.variety, pp.start_date,
        em.last_watered_at, em.last_observed_at, em.last_fertilized_at,
        em.last_pruned_at, em.last_harvested_at, em.last_event_at,
        em.next_water_at, em.location_type, em.watering_interval_days
      FROM plant_projects pp
      LEFT JOIN entity_memory em ON em.project_id = pp.id
      WHERE pp.created_by = ANY(${householdIds})
        AND pp.deleted_at IS NULL
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
  // HOUSEHOLD-MODE: widened at V3-ROLES teardown
  const householdIds = householdScope(userId);
  return sql`
      SELECT
        em.project_id, pp.name AS project_name,
        em.last_watered_at, em.next_water_at,
        em.location_type, em.watering_interval_days
      FROM entity_memory em
      JOIN plant_projects pp ON pp.id = em.project_id
      WHERE pp.created_by = ANY(${householdIds})
        AND pp.deleted_at IS NULL
        AND em.next_water_at IS NOT NULL
        AND em.next_water_at < NOW()
      ORDER BY em.next_water_at ASC
    `;
}

// §A Tile 3 — harvest_ready (status='harvesting', sort oldest last_observed_at).
// F1: days_since_obs computed via calendar-day arithmetic. May be NULL.
export function queryHarvestReady(sql, userId) {
  // HOUSEHOLD-MODE: widened at V3-ROLES teardown
  const householdIds = householdScope(userId);
  return sql`
      SELECT pp.id AS project_id, pp.name, pp.status,
             em.last_observed_at,
             (NOW()::date - em.last_observed_at::date)::int AS days_since_obs
      FROM plant_projects pp
      LEFT JOIN entity_memory em ON em.project_id = pp.id
      WHERE pp.status = 'harvesting'
        AND pp.created_by = ANY(${householdIds})
        AND pp.deleted_at IS NULL
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
  // HOUSEHOLD-MODE: widened at V3-ROLES teardown
  const householdIds = householdScope(userId);
  return sql`
      WITH flagged AS (
        SELECT DISTINCT ON (el.project_id)
          el.project_id,
          pp.name,
          'flagged'::text AS reason,
          el.severity,
          el.created_at AS event_at,
          (NOW()::date - el.created_at::date)::int AS days_stale
        FROM event_log el
        JOIN plant_projects pp ON pp.id = el.project_id
          AND pp.created_by = ANY(${householdIds}) AND pp.deleted_at IS NULL
        WHERE el.flagged_as_issue = true
          AND el.resolved_at IS NULL
          AND el.deleted_at IS NULL
        ORDER BY el.project_id, el.severity DESC NULLS LAST, el.created_at DESC
      ),
      stale AS (
        SELECT pp.id AS project_id,
               pp.name,
               'stale'::text AS reason,
               NULL::smallint AS severity,
               em.last_observed_at AS event_at,
               (NOW()::date - em.last_observed_at::date)::int AS days_stale
        FROM plant_projects pp
        LEFT JOIN entity_memory em ON em.project_id = pp.id
        WHERE pp.status IN ('sprouting','growing','flowering','fruiting')
          AND pp.created_by = ANY(${householdIds})
          AND pp.deleted_at IS NULL
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
export function queryInactiveCount(sql, userId) {
  // HOUSEHOLD-MODE: widened at V3-ROLES teardown
  const householdIds = householdScope(userId);
  return sql`
      SELECT COUNT(*)::int AS count
      FROM plant_projects pp
      WHERE pp.status IN ('harvested','ended')
        AND pp.created_by = ANY(${householdIds})
        AND pp.deleted_at IS NULL
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
    SELECT pp.id, pp.name, pp.variety, pp.status,
           pp.start_date,
           em.last_event_at,
           em.last_harvested_at,
           CASE WHEN d.dismissed_at IS NULL THEN false ELSE true END AS dismissed,
           d.dismissed_at
    FROM plant_projects pp
    LEFT JOIN entity_memory em ON em.project_id = pp.id
    LEFT JOIN inactive_project_dismissals d
      ON d.project_id = pp.id AND d.user_id = ${userId}
    WHERE pp.status IN ('harvested','ended')
      AND pp.created_by = ANY(${householdIds})
      AND pp.deleted_at IS NULL
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
      SELECT id FROM plant_projects
      WHERE id = ${projectId}::uuid
        AND created_by = ANY(${householdIds})
        AND status IN ('harvested','ended')
        AND deleted_at IS NULL
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
    recent_events: recentEvents,
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
