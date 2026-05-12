// /api/dashboard — V1.2a-1 Session 3
// Returns aggregated dashboard state in a single round trip:
//   - recent_events: last 5 logged events
//   - active_projects: all non-deleted projects + entity_memory state (last_*_at, next_water_at, location_type, watering_interval_days)
//   - counts: projects, plants, locations, favorites
//   - user_stats: current_streak, longest_streak, last_active_date, total_events, xp (defaults if no row)
//   - water_due: projects with entity_memory.next_water_at < NOW(), ordered by next_water_at ASC (Tile 2 data)
//
// active_projects JOINs entity_memory (authoritative source for last_*_at since Lambda 2.1.x).
// LEFT JOIN: projects without any logged events return NULL for entity_memory fields.

import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

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
  if (method !== 'GET') return resp(405, { error: 'Method not allowed' });

  const sql = neon(secrets.NEON_DATABASE_URL);

  try {
    const [
      recentEvents,
      counts,
      favCount,
      activeProjects,
      userStatsRows,
      waterDue,
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
    });

  } catch (err) {
    console.error('dashboard lambda error', err);
    return resp(500, { error: 'Internal server error' });
  }
};
