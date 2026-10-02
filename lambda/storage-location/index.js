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

// Put-Up R2a — the two refusals a place answers, and the words of each.
//
// RE-KIND. A put-up's discard-by date can be WORKED OUT from the kind of place it sits in (a general
// figure, the house figure for candy, a recipe's "how long, and where"). Changing the kind under such
// a date leaves it standing on a kind of place the food is no longer recorded at, so a PUT that
// CHANGES the kind is refused while the place holds one. What counts is one put-up that is live by
// the Pantry's own predicate (lambda/preservation/pantryRoutes.js listPantry: not removed,
// COALESCE(remaining_count, package_count) > 0, not consumed), has a stored date, and whose basis is
// table, house, recipe or unrecorded (NULL: its origin is unknown, and here unknown is not read as
// "his own date"). A typed date, "no date", a used-up or a removed put-up never count.
//   * A PUT is a re-kind only when `kind` is sent AND differs from the stored kind. The shipped
//     "Edit locations" form sends { label, kind } on every Save, a plain rename included, so a rule
//     keyed on the key's presence would refuse every rename of a place that holds dated put-ups.
//   * A refused PUT writes nothing, the name included: the check and the write are ONE statement.
//
// DELETE. Refused while the place holds anything: a live put-up (the same liveness, whatever its date)
// or a pantry item that is not removed and not used up. A deleted place keeps its Pantry heading but
// can no longer be listed, renamed or picked, so an empty place is the only one that can go. A going
// batch's stage that names the place does not block (as before R2a).
//
// Each answer is a coded 409 carrying `n` and one plain sentence, the same in `message` and `error`:
// a cached older bundle prints `message`, then `error`, exactly as sent, so these are user copy.
export function placeHasDatedJars(n) {
  const words = n === 1
    ? '1 put-up in this place has a date worked out from the kind of place it is now. Set its date by hand, or move it somewhere else, then change the kind.'
    : `${n} put-ups in this place have dates worked out from the kind of place it is now. Set those dates by hand, or move them somewhere else, then change the kind.`;
  return { error: words, code: 'place_has_dated_jars', message: words, n };
}
export function placeInUse(n) {
  const words = n === 1
    ? '1 thing is stored in this place. Move it first, then delete it.'
    : `${n} things are stored in this place. Move them first, then delete it.`;
  return { error: words, code: 'place_in_use', message: words, n };
}

// One line per place write and per refusal. storage_location has no updated_at, no trigger and no
// audit row, so without this a rename, a re-kind, a delete or an "it won't let me" leaves no trace.
function logPlace(event, fields) {
  console.log(JSON.stringify({ event, ...fields }));
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
        // Put-Up release 1b (05 §6a "place labels"): trimmed on every writer, as the POST already
        // trims, so " Fridge" and "Fridge" cannot become two places under the (user, kind,
        // lower(label)) key — and a rename cannot slip past the clash check below by a space.
        const label = body.label == null ? null : String(body.label).trim();
        let rows;
        try {
          // Put-Up R2a: the re-kind refusal (see placeHasDatedJars above), decided IN the write. `target`
          // is the place as this statement's snapshot sees it; `dated` counts what would be stranded;
          // the UPDATE runs only for a save that sends no kind, sends the stored kind (a rename), or
          // finds nothing dated. One row comes back whenever the place exists: written, or refused
          // with `n`. No row is the same 404 as ever.
          rows = await sql`
            WITH target AS (
              SELECT id, user_id, label, kind, created_at, deleted_at
              FROM storage_location
              WHERE id = ${locId}
                AND deleted_at IS NULL
                AND user_id = ANY(${householdIds})
            ),
            dated AS (
              SELECT count(*)::int AS n
              FROM preservation_log p
              WHERE p.storage_location_id = ${locId}
                AND p.user_id = ANY(${householdIds})
                AND p.deleted_at IS NULL
                AND COALESCE(p.remaining_count, p.package_count) > 0
                AND p.consumed_at IS NULL
                AND p.use_by_target IS NOT NULL
                AND (p.use_by_basis IS NULL OR p.use_by_basis IN ('table', 'house', 'recipe'))
            ),
            written AS (
              UPDATE storage_location
              SET
                label = COALESCE(${label}, label),
                kind  = COALESCE(${body.kind ?? null}, kind)
              WHERE id = ${locId}
                AND deleted_at IS NULL
                AND user_id = ANY(${householdIds})
                AND (${body.kind ?? null}::text IS NULL
                     OR kind = ${body.kind ?? null}::text
                     OR (SELECT n FROM dated) = 0)
              RETURNING id, user_id, label, kind, created_at, deleted_at
            )
            SELECT target.id, target.user_id,
                   COALESCE(written.label, target.label) AS label,
                   COALESCE(written.kind, target.kind) AS kind,
                   target.created_at, target.deleted_at,
                   target.kind AS old_kind,
                   (written.id IS NULL) AS refused,
                   (SELECT n FROM dated) AS n
            FROM target
            LEFT JOIN written ON written.id = target.id
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
             AND lower(o.label) = lower(COALESCE(${label}, t.label))
            WHERE t.id = ${locId}
              AND t.user_id = ANY(${householdIds})
              AND t.deleted_at IS NULL
            ORDER BY o.created_at, o.id
            LIMIT 1
          `;
          return resp(409, placeExists(clash[0]?.id ?? null));
        }
        if (!rows.length) return resp(404, { error: 'Not found' });
        // The answer is the place alone, the six columns it has always been.
        const { old_kind: oldKind = null, refused, n, ...place } = rows[0];
        const dated = Number(n ?? 0);
        if (refused) {
          // Refused with nothing dated: the place itself changed under the statement (removed on another
          // phone between the snapshot and the row lock). The same answer as a place that is not there.
          if (dated < 1) return resp(404, { error: 'Not found' });
          logPlace('storage_location_refused', {
            op: 'rekind', code: 'place_has_dated_jars', place_id: locId, old_kind: oldKind, new_kind: body.kind ?? null, n: dated,
          });
          return resp(409, placeHasDatedJars(dated));
        }
        logPlace('storage_location_write', { op: 'update', place_id: locId, old_kind: oldKind, new_kind: place.kind ?? null, n: dated });
        return resp(200, place);
      }

      if (method === 'DELETE') {
        // BUG-DELNOOPOK-001: RETURNING-gated. Was an unconditional {ok:true}, so a not-found /
        // already-deleted / not-owned DELETE reported success; now 404, matching the PUT at :102.
        // No slug arm here (unlike locations) — storage_location has no slug column and this
        // route has only ever resolved by uuid on every verb.
        // Put-Up R2a: the in-use refusal (see placeInUse above), decided IN the write, as the re-kind
        // is. `held` counts what is stored here; the soft-delete runs only when that is nothing. One
        // row comes back whenever the place exists: gone, or refused with `n`.
        const rows = await sql`
          WITH target AS (
            SELECT id, kind
            FROM storage_location
            WHERE id = ${locId}
              AND deleted_at IS NULL
              AND user_id = ANY(${householdIds})
          ),
          held AS (
            SELECT ((SELECT count(*)
                     FROM preservation_log p
                     WHERE p.storage_location_id = ${locId}
                       AND p.user_id = ANY(${householdIds})
                       AND p.deleted_at IS NULL
                       AND COALESCE(p.remaining_count, p.package_count) > 0
                       AND p.consumed_at IS NULL)
                  + (SELECT count(*)
                     FROM pantry_item pit
                     WHERE pit.storage_location_id = ${locId}
                       AND pit.user_id = ANY(${householdIds})
                       AND pit.deleted_at IS NULL
                       AND pit.used_up_at IS NULL))::int AS n
          ),
          gone AS (
            UPDATE storage_location
            SET deleted_at = NOW()
            WHERE id = ${locId}
              AND deleted_at IS NULL
              AND user_id = ANY(${householdIds})
              AND (SELECT n FROM held) = 0
            RETURNING id
          )
          SELECT target.id, target.kind AS old_kind,
                 (gone.id IS NULL) AS refused,
                 (SELECT n FROM held) AS n
          FROM target
          LEFT JOIN gone ON gone.id = target.id
        `;
        if (!rows.length) return resp(404, { error: 'Not found' });
        const { old_kind: oldKind = null, refused, n } = rows[0];
        const held = Number(n ?? 0);
        if (refused) {
          // Refused with nothing stored: removed on another phone under this statement. Not there.
          if (held < 1) return resp(404, { error: 'Not found' });
          logPlace('storage_location_refused', {
            op: 'delete', code: 'place_in_use', place_id: locId, old_kind: oldKind, new_kind: null, n: held,
          });
          return resp(409, placeInUse(held));
        }
        logPlace('storage_location_write', { op: 'delete', place_id: locId, old_kind: oldKind, new_kind: null, n: held });
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
        logPlace('storage_location_write', { op: 'create', place_id: rows[0]?.id ?? null, old_kind: null, new_kind: rows[0]?.kind ?? body.kind, n: 0 });
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
