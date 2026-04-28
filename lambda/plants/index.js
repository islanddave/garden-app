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
  const rawPath = event.rawPath ?? '/api/plants';

  const idMatch = rawPath.match(/^\/api\/plants\/([^/]+)$/);

  try {
    if (idMatch) {
      const plantId = idMatch[1];

      if (method === 'GET') {
        const rows = await sql`
          WITH _ AS (SELECT set_config('app.user_id', ${userId}, true))
          SELECT p.id, p.name, p.genus, p.species, p.variety, p.quantity,
                 p.status, p.notes, p.project_id, p.created_at, p.updated_at,
                 pp.name AS project_name
          FROM plants p
          JOIN plant_projects pp ON pp.id = p.project_id
          WHERE p.id = ${plantId}
            AND p.deleted_at IS NULL
            AND pp.created_by = ${userId}
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        return resp(200, rows[0]);
      }

      if (method === 'PUT') {
        const body = JSON.parse(event.body ?? '{}');
        const rows = await sql`
          WITH _ AS (SELECT set_config('app.user_id', ${userId}, true))
          UPDATE plants p
          SET
            name     = COALESCE(${body.name ?? null}, p.name),
            genus    = COALESCE(${body.genus ?? null}, p.genus),
            species  = COALESCE(${body.species ?? null}, p.species),
            variety  = COALESCE(${body.variety ?? null}, p.variety),
            quantity = COALESCE(${body.quantity ?? null}, p.quantity),
            status   = COALESCE(${body.status ?? null}, p.status),
            notes    = COALESCE(${body.notes ?? null}, p.notes)
          FROM plant_projects pp
          WHERE p.id = ${plantId}
            AND p.project_id = pp.id
            AND pp.created_by = ${userId}
            AND p.deleted_at IS NULL
          RETURNING p.*
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        return resp(200, rows[0]);
      }

      if (method === 'DELETE') {
        await sql`
          WITH _ AS (SELECT set_config('app.user_id', ${userId}, true))
          UPDATE plants p
          SET deleted_at = NOW()
          FROM plant_projects pp
          WHERE p.id = ${plantId}
            AND p.project_id = pp.id
            AND pp.created_by = ${userId}
            AND p.deleted_at IS NULL
        `;
        return resp(200, { ok: true });
      }

      return resp(405, { error: 'Method not allowed' });
    }

    if (method === 'GET') {
      const projectId = event.queryStringParameters?.project_id ?? null;
      const rows = projectId
        ? await sql`
            WITH _ AS (SELECT set_config('app.user_id', ${userId}, true))
            SELECT p.id, p.name, p.genus, p.species, p.variety, p.quantity,
                   p.status, p.notes, p.project_id, p.created_at,
                   pp.name AS project_name
            FROM plants p
            JOIN plant_projects pp ON pp.id = p.project_id
            WHERE pp.created_by = ${userId}
              AND p.project_id = ${projectId}
              AND p.deleted_at IS NULL
            ORDER BY p.created_at DESC
          `
        : await sql`
            WITH _ AS (SELECT set_config('app.user_id', ${userId}, true))
            SELECT p.id, p.name, p.genus, p.species, p.variety, p.quantity,
                   p.status, p.notes, p.project_id, p.created_at,
                   pp.name AS project_name
            FROM plants p
            JOIN plant_projects pp ON pp.id = p.project_id
            WHERE pp.created_by = ${userId}
              AND p.deleted_at IS NULL
            ORDER BY p.created_at DESC
          `;
      return resp(200, rows);
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      if (!body.name) return resp(400, { error: 'name is required' });
      if (!body.project_id) return resp(400, { error: 'project_id is required' });
      const qty = parseInt(body.quantity, 10);
      const rows = await sql`
        WITH _ AS (SELECT set_config('app.user_id', ${userId}, true))
        INSERT INTO plants
          (project_id, name, genus, species, variety, quantity, status, notes, created_by)
        VALUES (
          ${body.project_id},
          ${body.name},
          ${body.genus ?? null},
          ${body.species ?? null},
          ${body.variety ?? null},
          ${isNaN(qty) || qty < 1 ? 1 : qty},
          ${body.status ?? null},
          ${body.notes ?? null},
          ${userId}
        )
        RETURNING *
      `;
      return resp(201, rows[0]);
    }

    return resp(405, { error: 'Method not allowed' });

  } catch (err) {
    console.error('plants lambda error', err);
    return resp(500, { error: 'Internal server error' });
  }
};
