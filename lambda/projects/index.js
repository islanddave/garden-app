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

const CORS = {}; // Lambda URL config is sole CORS source — handler must not duplicate

function resp(statusCode, body, extra = {}) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extra },
    body: JSON.stringify(body),
  };
}

export const handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  let secrets;
  try {
    secrets = await getSecrets();
    if (!secrets.CLERK_SECRET_KEY || !secrets.NEON_DATABASE_URL) {
      console.error('projects lambda: missing required secrets', Object.keys(secrets));
      return resp(500, { error: 'Internal server error' });
    }
  } catch (err) {
    console.error('projects lambda: secrets fetch failed', err);
    return resp(500, { error: 'Internal server error' });
  }

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
  const rawPath = event.rawPath ?? '/api/projects';
  const idMatch = rawPath.match(/^\/api\/projects\/([^/]+)$/);

  try {
    const sql = neon(secrets.NEON_DATABASE_URL);

    if (idMatch) {
      const projectId = idMatch[1];

      if (method === 'GET') {
        const [projectRows, plantCountRows, eventCountRows] = await Promise.all([
          sql`
            SELECT id, name, slug, status, variety, description, start_date,
                   is_public, location_id, created_at, updated_at, created_by
            FROM plant_projects
            WHERE id = ${projectId}
              AND created_by = ${userId}
              AND deleted_at IS NULL
          `,
          sql`
            SELECT COUNT(*)::int AS count
            FROM plants
            WHERE project_id = ${projectId}
              AND deleted_at IS NULL
          `,
          sql`
            SELECT COUNT(*)::int AS count
            FROM event_log
            WHERE project_id = ${projectId}
              AND deleted_at IS NULL
          `,
        ]);
        if (!projectRows.length) return resp(404, { error: 'Not found' });
        return resp(200, {
          ...projectRows[0],
          plant_count: plantCountRows[0].count,
          event_count: eventCountRows[0].count,
        });
      }

      if (method === 'PUT') {
        const body = JSON.parse(event.body ?? '{}');
        const rows = await sql`
          UPDATE plant_projects
          SET
            name        = COALESCE(${body.name ?? null}, name),
            description = COALESCE(${body.description ?? null}, description),
            status      = COALESCE(${body.status ?? null}, status),
            variety     = COALESCE(${body.variety ?? null}, variety),
            start_date  = COALESCE(${body.start_date ?? null}, start_date),
            is_public   = COALESCE(${body.is_public ?? null}, is_public),
            location_id = COALESCE(${body.location_id ?? null}, location_id)
          WHERE id = ${projectId}
            AND created_by = ${userId}
            AND deleted_at IS NULL
          RETURNING *
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        return resp(200, rows[0]);
      }

      if (method === 'DELETE') {
        await sql`
          UPDATE plant_projects
          SET deleted_at = NOW()
          WHERE id = ${projectId}
            AND created_by = ${userId}
            AND deleted_at IS NULL
        `;
        return resp(200, { ok: true });
      }

      return resp(405, { error: 'Method not allowed' });
    }

    if (method === 'GET') {
      const rows = await sql`
        SELECT id, name, slug, status, variety, start_date, is_public, location_id,
               created_at, updated_at
        FROM plant_projects
        WHERE created_by = ${userId}
          AND deleted_at IS NULL
        ORDER BY start_date DESC NULLS LAST, created_at DESC
      `;
      return resp(200, rows);
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      if (!body.name) return resp(400, { error: 'name is required' });
      const rows = await sql`
        INSERT INTO plant_projects
          (name, slug, status, variety, description, start_date, is_public, location_id, created_by)
        VALUES (
          ${body.name},
          ${body.slug ?? body.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-')},
          ${body.status ?? 'planning'},
          ${body.variety ?? null},
          ${body.description ?? null},
          ${body.start_date ?? null},
          ${body.is_public ?? false},
          ${body.location_id ?? null},
          ${userId}
        )
        RETURNING *
      `;
      return resp(201, rows[0]);
    }

    return resp(405, { error: 'Method not allowed' });

  } catch (err) {
    console.error('projects lambda error', err);
    return resp(500, { error: 'Internal server error' });
  }
};
