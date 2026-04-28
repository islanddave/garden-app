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

  // NOTE: neon() uses HTTP mode — each sql`` call is its own connection/transaction.
  // set_config with is_local=true is transaction-scoped and does NOT persist across calls.
  // Fix: inline set_config via CTE in every query so the GUC is set in the same transaction
  // as the RLS check. Removing the standalone set_config call at the top.

  try {
    if (method === 'GET') {
      const entityType = event.queryStringParameters?.entity_type ?? null;
      const rows = entityType
        ? await sql`
            WITH _ AS (SELECT set_config('app.user_id', ${userId}, true))
            SELECT id, entity_type, entity_id, created_at
            FROM favorites
            WHERE user_id = ${userId}
              AND entity_type = ${entityType}
            ORDER BY created_at DESC
          `
        : await sql`
            WITH _ AS (SELECT set_config('app.user_id', ${userId}, true))
            SELECT id, entity_type, entity_id, created_at
            FROM favorites
            WHERE user_id = ${userId}
            ORDER BY entity_type, created_at DESC
          `;
      return resp(200, rows);
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      if (!body.entity_type) return resp(400, { error: 'entity_type is required' });
      if (!body.entity_id) return resp(400, { error: 'entity_id is required' });

      const existing = await sql`
        WITH _ AS (SELECT set_config('app.user_id', ${userId}, true))
        SELECT id FROM favorites
        WHERE user_id = ${userId}
          AND entity_type = ${body.entity_type}
          AND entity_id = ${body.entity_id}
      `;

      if (existing.length) {
        await sql`
          WITH _ AS (SELECT set_config('app.user_id', ${userId}, true))
          DELETE FROM favorites
          WHERE user_id = ${userId}
            AND entity_type = ${body.entity_type}
            AND entity_id = ${body.entity_id}
        `;
        return resp(200, { favorited: false, entity_type: body.entity_type, entity_id: body.entity_id });
      } else {
        await sql`
          WITH _ AS (SELECT set_config('app.user_id', ${userId}, true))
          INSERT INTO favorites (user_id, entity_type, entity_id)
          SELECT ${userId}, ${body.entity_type}, ${body.entity_id}
        `;
        return resp(201, { favorited: true, entity_type: body.entity_type, entity_id: body.entity_id });
      }
    }

    return resp(405, { error: 'Method not allowed' });

  } catch (err) {
    console.error('favorites lambda error', err);
    return resp(500, { error: 'Internal server error' });
  }
};
