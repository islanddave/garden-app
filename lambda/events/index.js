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

  const sql = neon(secrets.NEON_DATABASE_URL);
  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/api/events';

  const idMatch = rawPath.match(/^\/api\/events\/([^/]+)$/);

  try {
    if (idMatch) {
      const eventId = idMatch[1];

      if (method === 'GET') {
        const rows = await sql`
          WITH _ AS (SELECT set_config('app.user_id', ${userId}, true))
          SELECT
            e.id, e.project_id, e.location_id, e.plant_id,
            e.event_type, e.event_date, e.notes, e.private_notes,
            e.quantity, e.is_public, e.logged_by, e.created_at,
            pp.name AS project_name
          FROM event_log e
          JOIN plant_projects pp ON pp.id = e.project_id
          WHERE e.id = ${eventId}
            AND e.deleted_at IS NULL
            AND pp.created_by = ${userId}
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        return resp(200, rows[0]);
      }

      return resp(405, { error: 'Method not allowed' });
    }

    // /api/events
    if (method === 'GET') {
      const projectId = event.queryStringParameters?.project_id ?? null;
      const limit = Math.min(parseInt(event.queryStringParameters?.limit ?? '50', 10), 200);

      const rows = projectId
        ? await sql`
            WITH _ AS (SELECT set_config('app.user_id', ${userId}, true))
            SELECT
              e.id, e.project_id, e.location_id, e.plant_id,
              e.event_type, e.event_date, e.notes,
              e.quantity, e.is_public, e.logged_by, e.created_at,
              pp.name AS project_name
            FROM event_log e
            JOIN plant_projects pp ON pp.id = e.project_id
            WHERE pp.created_by = ${userId}
              AND e.project_id = ${projectId}
              AND e.deleted_at IS NULL
            ORDER BY e.event_date DESC, e.created_at DESC
            LIMIT ${limit}
          `
        : await sql`
            WITH _ AS (SELECT set_config('app.user_id', ${userId}, true))
            SELECT
              e.id, e.project_id, e.location_id, e.plant_id,
              e.event_type, e.event_date, e.notes,
              e.quantity, e.is_public, e.logged_by, e.created_at,
              pp.name AS project_name
            FROM event_log e
            JOIN plant_projects pp ON pp.id = e.project_id
            WHERE pp.created_by = ${userId}
              AND e.deleted_at IS NULL
            ORDER BY e.event_date DESC, e.created_at DESC
            LIMIT ${limit}
          `;
      return resp(200, rows);
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      if (!body.event_type) return resp(400, { error: 'event_type is required' });
      if (!body.project_id) return resp(400, { error: 'project_id is required' });
      // location_id is optional — stored as NULL if not provided

      const eventDate = body.event_date
        ? new Date(body.event_date).toISOString()
        : new Date().toISOString();

      // Insert event
      const eventRows = await sql`
        WITH _ AS (SELECT set_config('app.user_id', ${userId}, true))
        INSERT INTO event_log
          (project_id, location_id, plant_id, event_type, event_date,
           notes, private_notes, quantity, is_public, logged_by)
        VALUES (
          ${body.project_id},
          ${body.location_id ?? null},
          ${body.plant_id ?? null},
          ${body.event_type},
          ${eventDate},
          ${body.notes ?? null},
          ${body.private_notes ?? null},
          ${body.quantity ?? null},
          ${body.is_public ?? true},
          ${userId}
        )
        RETURNING *
      `;
      const newEvent = eventRows[0];

      // Upsert user_stats — increment event count, update streak
      // user_stats schema assumed: user_id TEXT PK, event_count INT, streak INT,
      // last_event_date DATE, xp INT, level INT
      // This is a best-effort operation — non-fatal on failure
      try {
        await sql`
          WITH _ AS (SELECT set_config('app.user_id', ${userId}, true))
          INSERT INTO user_stats (user_id, event_count, last_event_date, xp, streak)
          VALUES (${userId}, 1, CURRENT_DATE, 10, 1)
          ON CONFLICT (user_id) DO UPDATE
          SET
            event_count     = user_stats.event_count + 1,
            xp              = user_stats.xp + 10,
            streak          = CASE
              WHEN user_stats.last_event_date = CURRENT_DATE - INTERVAL '1 day'
                THEN user_stats.streak + 1
              WHEN user_stats.last_event_date = CURRENT_DATE
                THEN user_stats.streak
              ELSE 1
            END,
            last_event_date = CURRENT_DATE
        `;
      } catch (statsErr) {
        console.warn('user_stats upsert failed (non-fatal)', statsErr.message);
      }

      return resp(201, newEvent);
    }

    return resp(405, { error: 'Method not allowed' });

  } catch (err) {
    console.error('events lambda error', err);
    return resp(500, { error: 'Internal server error' });
  }
};
