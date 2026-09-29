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

// Put-Up release 1a — the answer to a DUPLICATE PLACE, given before the constraint that raises it.
//
// Release 1b adds UNIQUE (user_id, kind, lower(label)) WHERE deleted_at IS NULL on storage_location
// (V4's data model, 1b) while THIS code is the deployed writer, and until now a 23505 here fell
// through to a bare 500 that the shipped "+ New location" form retries once and then shows as
// "try again (SRV)" — sometimes for a place that already exists, since its own retry after a lost
// response re-sends a create that already landed. So both writers answer it now, in 1a, while no
// database carries the index and the branch is dormant:
//   POST — FIND-OR-CREATE (V4's place find-or-create): the caller's live place with that kind and
//     that name, whatever its case, comes back with 200 and `existing: true`. Every shipped caller
//     only needs the row (it selects row.id), so a create that turns out to be a pick still lands
//     the jar in the right place.
//   PUT — a rename or re-kind onto a name the owner already uses cannot be turned into a pick, so it
//     is refused: 409 `place_exists` carrying the other place's id.
// Every coded 409 carries a plain-words `message`, mirrored in `error` (which apiFetch surfaces).
const PLACE_EXISTS_WORDS = 'You already have a place with that name. Pick it instead, or use a different name.';
function placeExists(existingId) {
  return { error: PLACE_EXISTS_WORDS, code: 'place_exists', message: PLACE_EXISTS_WORDS, existing_id: existingId };
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
        let rows;
        try {
          rows = await sql`
            UPDATE storage_location
            SET
              label = COALESCE(${body.label ?? null}, label),
              kind  = COALESCE(${body.kind ?? null}, kind)
            WHERE id = ${locId}
              AND deleted_at IS NULL
              AND user_id = ANY(${householdIds})
            RETURNING *
          `;
        } catch (err) {
          if (err.code !== '23505') throw err;
          // The clash is with another live place of the SAME OWNER (the unique key starts at user_id,
          // and a household member may be editing someone else's place), under the name and kind this
          // statement would have written — the same COALESCEs as the SET.
          const clash = await sql`
            SELECT o.id
            FROM storage_location t
            JOIN storage_location o
              ON o.user_id = t.user_id
             AND o.id <> t.id
             AND o.deleted_at IS NULL
             AND o.kind = COALESCE(${body.kind ?? null}, t.kind)
             AND lower(o.label) = lower(COALESCE(${body.label ?? null}, t.label))
            WHERE t.id = ${locId}
              AND t.user_id = ANY(${householdIds})
              AND t.deleted_at IS NULL
            ORDER BY o.created_at, o.id
            LIMIT 1
          `;
          return resp(409, placeExists(clash[0]?.id ?? null));
        }
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
      const label = body.label.trim();
      try {
        const rows = await sql`
          INSERT INTO storage_location (user_id, label, kind)
          VALUES (${userId}, ${label}, ${body.kind})
          RETURNING *
        `;
        return resp(201, rows[0]);
      } catch (err) {
        if (err.code !== '23505') throw err;
        // Exactly the unique key the insert collided on: this caller, this kind, this name in any case.
        const existing = await sql`
          SELECT id, user_id, label, kind, created_at, deleted_at
          FROM storage_location
          WHERE user_id = ${userId}
            AND kind = ${body.kind}
            AND lower(label) = lower(${label})
            AND deleted_at IS NULL
          ORDER BY created_at, id
          LIMIT 1
        `;
        if (existing.length) return resp(200, { ...existing[0], existing: true });
        return resp(409, placeExists(null));
      }
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
