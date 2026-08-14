// V4-HARVESTCENTER-001 (Put-Up) — storage_location vocab CRUD Lambda.
// Mirrors lambda/locations/index.js (auth/scope/resp skeleton, soft-delete, idempotent DELETE)
// but scoped on user_id (not created_by) and with no hierarchy/photo/with-path surface.
// storage_location = { id, user_id, label, kind CHECK(deep_freezer|fridge_freezer|fridge|
//   pantry|cold_storage|other), created_at, deleted_at }. Per-user, Soft-Delete-Only.
import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { householdScope } from './household.js';

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

const VALID_KINDS = ['deep_freezer', 'fridge_freezer', 'fridge', 'pantry', 'cold_storage', 'other'];

export function validateCreate(body) {
  if (!body || typeof body !== 'object') return 'body required';
  if (!body.label || typeof body.label !== 'string' || !body.label.trim()) return 'label is required';
  if (!body.kind || !VALID_KINDS.includes(body.kind)) return `kind must be one of: ${VALID_KINDS.join(', ')}`;
  return null;
}

export function validateUpdate(body) {
  if (!body || typeof body !== 'object') return 'body required';
  if (body.label != null && (typeof body.label !== 'string' || !body.label.trim())) return 'label must be non-blank';
  if (body.kind != null && !VALID_KINDS.includes(body.kind)) return `kind must be one of: ${VALID_KINDS.join(', ')}`;
  return null;
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
  // V4-AUTHZRESIDUE-001 (mirrors lambda/plants + lambda/photos): householdScope('') returns [''] and
  // `'' = ANY(ARRAY[''])` is TRUE in Postgres, so an empty/absent JWT subject would be a live
  // ownership value rather than a no-match. verifyToken rejects such a token first, so this is
  // defence-in-depth; the point is that the invariant is ENFORCED here rather than relied upon.
  if (!userId) return resp(401, { error: 'Unauthorized' });

  const sql = neon(secrets.NEON_DATABASE_URL);
  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/api/storage-locations';
  const householdIds = householdScope(userId);

  const idMatch = rawPath.match(/^\/api\/storage-locations\/([^/]+)$/);

  try {
    if (idMatch) {
      const locId = idMatch[1];

      if (method === 'PUT') {
        const body = JSON.parse(event.body ?? '{}');
        const verr = validateUpdate(body);
        if (verr) return resp(400, { error: verr });
        const rows = await sql`
          UPDATE storage_location
          SET
            label = COALESCE(${body.label ?? null}, label),
            kind  = COALESCE(${body.kind ?? null}, kind)
          WHERE id = ${locId}
            AND deleted_at IS NULL
            AND user_id = ANY(${householdIds})
          RETURNING *
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        return resp(200, rows[0]);
      }

      if (method === 'DELETE') {
        // BUG-DELNOOPOK-001: RETURNING-gated. Was an unconditional {ok:true}, so a not-found /
        // already-deleted / not-owned DELETE reported success; now 404, matching the PUT at :102.
        // No slug arm here (unlike locations) — storage_location has no slug column and this
        // route has only ever resolved by uuid on every verb.
        const rows = await sql`
          UPDATE storage_location
          SET deleted_at = NOW()
          WHERE id = ${locId}
            AND deleted_at IS NULL
            AND user_id = ANY(${householdIds})
          RETURNING id
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        return resp(200, { ok: true });
      }

      return resp(405, { error: 'Method not allowed' });
    }

    if (method === 'GET') {
      const rows = await sql`
        SELECT id, user_id, label, kind, created_at
        FROM storage_location
        WHERE user_id = ANY(${householdIds}) AND deleted_at IS NULL
        ORDER BY label
      `;
      return resp(200, rows);
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      const verr = validateCreate(body);
      if (verr) return resp(400, { error: verr });
      const rows = await sql`
        INSERT INTO storage_location (user_id, label, kind)
        VALUES (${userId}, ${body.label.trim()}, ${body.kind})
        RETURNING *
      `;
      return resp(201, rows[0]);
    }

    return resp(405, { error: 'Method not allowed' });

  } catch (err) {
    console.error('storage-location lambda error', err);
    if (err.code === '23514') return resp(400, { error: `Constraint violation: ${err.constraint ?? err.message}` });
    if (err.code === '23502') return resp(400, { error: `Required field missing: ${err.column ?? err.message}` });
    if (err.code === '23503') return resp(400, { error: `Foreign key violation: ${err.constraint ?? err.message}` });
    return resp(500, { error: 'Internal server error' });
  }
};
