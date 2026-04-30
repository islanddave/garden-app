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

  const sql = neon(secrets.NEON_DATABASE_URL);
  const method = event.requestContext?.http?.method ?? 'GET';

  try {
    // GET /api/favorites
    // With entity_type+entity_id: returns {favorited:bool} for single-entity check
    // Without: returns array of all user favorites
    if (method === 'GET') {
      const entityType = event.queryStringParameters?.entity_type ?? null;
      const entityId   = event.queryStringParameters?.entity_id   ?? null;
      if (entityType && entityId) {
        const rows = await sql`
          SELECT id FROM favorites
          WHERE user_id = ${userId}
            AND entity_type = ${entityType}
            AND entity_id = ${entityId}::uuid
        `;
        return resp(200, { favorited: rows.length > 0, id: rows[0]?.id ?? null });
      }
      const rows = await sql`
        SELECT id, entity_type, entity_id, created_at
        FROM favorites
        WHERE user_id = ${userId}
        ORDER BY entity_type, created_at DESC
      `;
      return resp(200, rows);
    }

    // POST /api/favorites — upsert (insert or ignore if already favorited)
    if (method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      if (!body.entity_type) return resp(400, { error: 'entity_type is required' });
      if (!body.entity_id)   return resp(400, { error: 'entity_id is required' });
      const rows = await sql`
        INSERT INTO favorites (user_id, entity_type, entity_id)
        VALUES (${userId}, ${body.entity_type}, ${body.entity_id}::uuid)
        ON CONFLICT (user_id, entity_type, entity_id) DO NOTHING
        RETURNING id
      `;
      const id = rows[0]?.id ?? null;
      return resp(201, { favorited: true, id, entity_type: body.entity_type, entity_id: body.entity_id });
    }

    // DELETE /api/favorites?entity_type=x&entity_id=y
    if (method === 'DELETE') {
      const entityType = event.queryStringParameters?.entity_type ?? null;
      const entityId   = event.queryStringParameters?.entity_id   ?? null;
      if (!entityType || !entityId) return resp(400, { error: 'entity_type and entity_id are required' });
      await sql`
        DELETE FROM favorites
        WHERE user_id = ${userId}
          AND entity_type = ${entityType}
          AND entity_id = ${entityId}::uuid
      `;
      return resp(200, { favorited: false, entity_type: entityType, entity_id: entityId });
    }

    return resp(405, { error: 'Method not allowed' });

  } catch (err) {
    console.error('favorites lambda error', err);
    return resp(500, { error: 'Internal server error' });
  }
};
