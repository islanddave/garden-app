import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

let _secrets = null;
async function getSecrets() {
  if (_secrets) return _secrets;
  const cmd = new GetSecretValueCommand({ SecretId: 'garden-app/secrets' });
  const res = await sm.send(cmd);
  _secrets = JSON.parse(res.SecretString);
  return _secrets;
}

const CORS = {
  'Access-Control-Allow-Origin': 'https://garden.futureishere.net',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
};

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
    const payload = await verifyToken(token, { secretKey: secrets.CLERK_SECRET_KEY });
    userId = payload.sub;
  } catch {
    return resp(401, { error: 'Unauthorized' });
  }

  const method = event.requestContext?.http?.method ?? 'GET';
  if (method !== 'GET') return resp(405, { error: 'Method not allowed' });

  const sql = neon(secrets.NEON_DATABASE_URL);

  try {
    await sql`SELECT set_config('app.user_id', ${userId}, true)`;

    // All dashboard queries run in parallel
    const [
      recentEvents,
      counts,
      favCount,
    ] = await Promise.all([
      // Recent event log entries (last 5), with project name and display_name attribution.
      // profiles.display_name: assumed column on profiles table keyed by user_id TEXT.
      sql`
        SELECT
          e.id, e.event_type, e.event_date, e.created_at,
          pp.name AS project_name,
          pr.display_name
        FROM event_log e
        JOIN plant_projects pp ON pp.id = e.project_id
        LEFT JOIN profiles pr ON pr.user_id = e.logged_by
        WHERE pp.created_by = ${userId}
          AND e.deleted_at IS NULL
        ORDER BY e.created_at DESC
        LIMIT 5
      `,
      // Aggregate counts for projects / plants / locations owned by this user
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
      // Favorites count for this user
      sql`
        SELECT COUNT(*)::int AS count
        FROM favorites
        WHERE user_id = ${userId}
      `,
    ]);

    return resp(200, {
      recent_events: recentEvents,
      counts: {
        projects:  counts[0].project_count,
        plants:    counts[0].plant_count,
        locations: counts[0].location_count,
        favorites: favCount[0].count,
      },
    });

  } catch (err) {
    console.error('dashboard lambda error', err);
    return resp(500, { error: 'Internal server error' });
  }
};
