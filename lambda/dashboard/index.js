// /api/dashboard — V1.2a-2 Session 2 (extends V1.2a-1 Session 3)
// Per-path method dispatch (F11):
//   - GET  /api/dashboard                                 → aggregated dashboard state
//   - GET  /api/projects/inactive                         → inactive project list (§7)
//   - POST /api/projects/inactive/:projectId/dismiss      → dismiss inactive project (§8)
//
// GET /api/dashboard returns aggregated dashboard state in a single round trip:
//   - recent_events: last 5 logged events
//   - active_projects: all non-deleted projects + entity_memory state
//   - counts: projects, plants, locations, favorites
//   - user_stats: current_streak, longest_streak, last_active_date, total_events, xp
//   - water_due: projects with entity_memory.next_water_at < NOW() (Tile 2)
//   - harvest_ready: projects with status='harvesting' ordered by oldest last_observed_at (Tile 3, §4)
//   - heads_up: Hybrid A+C union — flagged-unresolved + active-growth stale (Tile 4, §5)
//   - inactive_projects_count: scalar count of harvested/ended NOT dismissed (§6)
//
// F1: days computed via calendar-day arithmetic (NOW()::date - col::date)::int — NOT EXTRACT(DAY FROM interval).
// F7: Tile 4 stale predicate handles NULL last_observed_at with COALESCE(last_event_at, created_at) fallback.
// F9: POST dismiss validates UUID via regex BEFORE handler dispatch (404 on parse failure).
// F11: per-path method dispatch — no blanket non-GET 405.
// B6: Tile 4 'stale' = OBSERVATION staleness by design.

import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let _secrets = null;
async function getSecrets() {
  if (_secrets) return _secrets;
  const cmd = new GetSecretValueCommand({ SecretId: process.env.SECRET_NAME ?? 'garden-app/secrets' });
  const res = await sm.send(cmd);
  _secrets = JSON.parse(res.SecretString);
  return _secrets;
}

const CORS = {}; // Lambda URL config is sole CORS source — handler must not duplicate

function resp(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(body),
  };
}

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const secrets = await getSecrets();

  const authHeader = event.headers?.authorization ?? event.headers?.Authorization ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  let userId;
  try {
    const payload = await verifyToken(token, {
      secretKey: secrets.CLERK_SECRET_KEY,
      authorizedParties: [
        'https://garden.futureishere.net',
        'https://dg6mmjhepoyt9.cloudfront.net',
      ],
    });
    userId = payload.sub;
  } catch (err) {
    console.error('verifyToken failed:', err?.message ?? String(err));
    return resp(401, { error: 'Unauthorized' });
  }

  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/api/dashboard';

  const sql = neon(secrets.NEON_DATABASE_URL);

  try {
    // §F GET /api/projects/inactive
    if (rawPath === '/api/projects/inactive') {
      if (method !== 'GET') return resp(405, { error: 'Method not allowed' });
      return await handleGetInactive(sql, userId);
    }

    // §G POST /api/projects/inactive/:projectId/dismiss
    const dismissMatch = rawPath.match(/^\/api\/projects\/inactive\/([^/]+)\/dismiss$/);
    if (dismissMatch) {
      if (method !== 'POST') return resp(405, { error: 'Method not allowed' });
      const projectId = dismissMatch[1];
      // F9: UUID parse pre-validation — 404 on parse failure
      if (!UUID_RE.test(projectId)) return resp(404, { error: 'Not found' });
      return await handleDismissInactive(sql, userId, projectId);
    }

    // Default: /api/dashboard (existing GET aggregator)
    if (rawPath !== '/api/dashboard' && rawPath !== '/' && rawPath !== '') {
      // Unknown route — fall through to 404
      return resp(404, { error: 'Not found' });
    }
    if (method !== 'GET') return resp(405, { error: 'Method not allowed' });
    return await handleDashboard(sql, userId);

  } catch (err) {
    console.error('dashboard lambda error', err);
    return resp(500, { error: 'Internal server error' });
  }
};

async function handleDashboard(sql, userId) {
  // §D Promise.all parallelization — all 9 queries fire concurrently.
  // Tile 4 'stale' = OBSERVATION staleness by design (B6). A project with recent watering
  // but no observation in 21d IS stale — observation = user's chance to notice issues.
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
  ] = await Promise.all([
    sql`
      SELECT
        e.id, e.event_type, e.event_date, e.created_at,
        pp.name AS project_name,
        pr.display_name
      FROM event_log e
      JOIN plant_projects pp ON pp.id = e.project_id
      LEFT JOIN profiles pr ON pr.id = e.logged_by
      WHERE pp.created_by = ${userId}
        AND e.deleted_at IS NULL
      ORDER BY e.created_at DESC
      LIMIT 5
    `,
    sql`
      SELECT
        (
          SELECT COUNT(*)::int
          FROM plant_projects
          WHERE created_by = ${userId} AND deleted_at IS NULL
        ) AS project_count,
        (
          SELECT COUNT(*)::int
          FROM plants p
          JOIN plant_projects pp ON pp.id = p.project_id
          WHERE pp.created_by = ${userId} AND p.deleted_at IS NULL
        ) AS plant_count,
        (
          SELECT COUNT(*)::int
          FROM locations
          WHERE deleted_at IS NULL
        ) AS location_count
    `,
    sql`
      SELECT COUNT(*)::int AS count
      FROM favorites
      WHERE user_id = ${userId}
    `,
    sql`
      SELECT
        pp.id, pp.name, pp.status, pp.variety, pp.start_date,
        em.last_watered_at, em.last_observed_at, em.last_fertilized_at,
        em.last_pruned_at, em.last_harvested_at, em.last_event_at,
        em.next_water_at, em.location_type, em.watering_interval_days
      FROM plant_projects pp
      LEFT JOIN entity_memory em ON em.project_id = pp.id
      WHERE pp.created_by = ${userId}
        AND pp.deleted_at IS NULL
      ORDER BY pp.created_at DESC
    `,
    sql`
      SELECT current_streak, longest_streak, last_active_date, total_events, xp
      FROM user_stats
      WHERE user_id = ${userId}
    `,
    sql`
      SELECT
        em.project_id, pp.name AS project_name,
        em.last_watered_at, em.next_water_at,
        em.location_type, em.watering_interval_days
      FROM entity_memory em
      JOIN plant_projects pp ON pp.id = em.project_id
      WHERE pp.created_by = ${userId}
        AND pp.deleted_at IS NULL
        AND em.next_water_at IS NOT NULL
        AND em.next_water_at < NOW()
      ORDER BY em.next_water_at ASC
    `,
    // §A Tile 3 — harvest_ready (status='harvesting', sort oldest last_observed_at).
    // F1: days_since_obs computed via calendar-day arithmetic. May be NULL.
    sql`
      SELECT pp.id AS project_id, pp.name, pp.status,
             em.last_observed_at,
             (NOW()::date - em.last_observed_at::date)::int AS days_since_obs
      FROM plant_projects pp
      LEFT JOIN entity_memory em ON em.project_id = pp.id
      WHERE pp.status = 'harvesting'
        AND pp.created_by = ${userId}
        AND pp.deleted_at IS NULL
      ORDER BY em.last_observed_at ASC NULLS LAST
      LIMIT 5
    `,
    // §B Tile 4 — heads_up Hybrid A+C union.
    // F1: days_stale via calendar-day arithmetic.
    // F7: stale predicate tightened — handles NULL last_observed_at with last_event_at/created_at fallback.
    // SQL-layer NOT EXISTS dedup ensures a project surfaces ONCE (as 'flagged' if it has both).
    // ORDER BY severity DESC NULLS LAST → severity=3 sorts before severity=1; stale (NULL severity) last.
    sql`
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
          AND pp.created_by = ${userId} AND pp.deleted_at IS NULL
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
          AND pp.created_by = ${userId}
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
    `,
    // §C inactive_projects_count — harvested/ended status, NOT dismissed by this user.
    sql`
      SELECT COUNT(*)::int AS count
      FROM plant_projects pp
      WHERE pp.status IN ('harvested','ended')
        AND pp.created_by = ${userId}
        AND pp.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM inactive_project_dismissals d
          WHERE d.user_id = ${userId} AND d.project_id = pp.id
        )
    `,
  ]);

  const userStats = userStatsRows[0] ?? {
    current_streak: 0,
    longest_streak: 0,
    last_active_date: null,
    total_events: 0,
    xp: 0,
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

async function handleGetInactive(sql, userId) {
  // §F GET /api/projects/inactive
  // Per V002 §7 (canonical) — schema doc §5.4 superseded (no `ended_at` column).
  // Sort: undismissed first (d.dismissed_at IS NULL DESC), then by last_event_at DESC.
  // No pagination — acceptable at <100 inactive projects/user; revisit at V2 multi-user.
  const rows = await sql`
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
      AND pp.created_by = ${userId}
      AND pp.deleted_at IS NULL
    ORDER BY d.dismissed_at IS NULL DESC, em.last_event_at DESC NULLS LAST
  `;
  return resp(200, rows);
}

async function handleDismissInactive(sql, userId, projectId) {
  // §G POST /api/projects/inactive/:projectId/dismiss
  // Single-CTE ownership-check + idempotent dismiss. F9 UUID validation already done in dispatch.
  // COALESCE handles idempotent case where ON CONFLICT DO NOTHING returns empty but row already exists.
  // status='not_found' (no owned row) → 404 — matches existence-oblivious cross-tenant pattern.
  // status='dismissed' → 200 with { dismissed: true, dismissed_at }.
  const rows = await sql`
    WITH owned AS (
      SELECT id FROM plant_projects
      WHERE id = ${projectId}::uuid
        AND created_by = ${userId}
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

  const row = rows[0];
  if (!row || row.status === 'not_found') {
    return resp(404, { error: 'Not found' });
  }
  return resp(200, { dismissed: true, dismissed_at: row.dismissed_at });
}
