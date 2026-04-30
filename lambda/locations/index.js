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

function buildHierarchy(rows) {
  const byId = Object.fromEntries(rows.map(r => [r.id, { ...r, children: [] }]));
  const roots = [];
  for (const row of rows) {
    if (row.parent_id && byId[row.parent_id]) {
      byId[row.parent_id].children.push(byId[row.id]);
    } else {
      roots.push(byId[row.id]);
    }
  }
  return roots;
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

  const sql = neon(secrets.NEON_DATABASE_URL);
  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/api/locations';

  const idMatch = rawPath !== '/api/locations/with-path' && rawPath.match(/^\/api\/locations\/([^/]+)$/);

  try {
    if (idMatch) {
      const locId = idMatch[1];

      if (method === 'PUT') {
        const body = JSON.parse(event.body ?? '{}');
        const rows = await sql`
          UPDATE locations
          SET
            name        = COALESCE(${body.name ?? null}, name),
            type_label  = COALESCE(${body.type_label ?? null}, type_label),
            sort_order  = COALESCE(${body.sort_order ?? null}, sort_order),
            description = COALESCE(${body.description ?? null}, description),
            is_active   = COALESCE(${body.is_active ?? null}, is_active)
          WHERE id = ${locId}
            AND deleted_at IS NULL
          RETURNING *
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        return resp(200, rows[0]);
      }

      if (method === 'DELETE') {
        await sql`
          UPDATE locations
          SET deleted_at = NOW()
          WHERE id = ${locId}
            AND deleted_at IS NULL
        `;
        return resp(200, { ok: true });
      }

      return resp(405, { error: 'Method not allowed' });
    }

    if (method === 'GET') {
      const [locRows, pathRows] = await Promise.all([
        sql`
          SELECT id, name, slug, level, type_label, parent_id, sort_order,
                 description, is_active, created_at
          FROM locations
          WHERE deleted_at IS NULL
          ORDER BY level, sort_order, name
        `,
        sql`
          SELECT id, full_path, level, is_active
          FROM locations_with_path
          WHERE deleted_at IS NULL
          ORDER BY full_path
        `,
      ]);
      return resp(200, rawPath === "/api/locations/with-path" ? pathRows : { locations: locRows, locations_with_path: pathRows });
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      if (!body.name) return resp(400, { error: 'name is required' });

      let level = 0;
      if (body.parent_id) {
        const parentRows = await sql`
          SELECT level FROM locations WHERE id = ${body.parent_id} AND deleted_at IS NULL
        `;
        if (parentRows.length) level = Math.min(parentRows[0].level + 1, 3);
      }

      const slug = body.slug?.trim() ||
        body.name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

      const rows = await sql`
        INSERT INTO locations
          (name, slug, level, type_label, parent_id, sort_order, description)
        VALUES (
          ${body.name},
          ${slug},
          ${level},
          ${body.type_label ?? null},
          ${body.parent_id ?? null},
          ${body.sort_order ?? 0},
          ${body.description ?? null}
        )
        RETURNING *
      `;
      return resp(201, rows[0]);
    }

    return resp(405, { error: 'Method not allowed' });

  } catch (err) {
    console.error('locations lambda error', err);
    if (err.code === '23505') return resp(409, { error: 'Slug already exists' });
    return resp(500, { error: 'Internal server error' });
  }
};
