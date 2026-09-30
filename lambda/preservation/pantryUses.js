// Release F — POST /api/pantry/uses: "Mark used" / "Used up" on a jar (06 §1.3; contract-F §2.6).
//
// WHY IT SHIPS IN F. A draw from a jar stamps delta_at, and from F the legacy PUT refuses a
// remaining_count on a jar whose delta_at is set (the stale-bundle refusal). The F client therefore
// stops sending remaining_count in its PUT and posts here instead — otherwise every drawn jar would 409
// forever. F accepted only `fate` NULL (eaten); B′ adds 'discarded' (Went bad = all_remaining) and
// 'given_away' (Gave it away = a count, or all of it). 'batch' is written only by the line routes. The undo
// route is B′'s, in pantryRoutes.js (POST /api/pantry/uses/:id/undo).
//
// ONE STATEMENT. `pre` reads and LOCKS the jar (household-scoped, live), `want` fixes how many this tap
// uses (all_remaining = what is left right now), the UPDATE moves the count only if that many are left
// (the WHERE is the race guard: two phones cannot both take the last jar), and the pantry_use row is
// inserted from the UPDATE's RETURNING — so a refused tap writes no use. 0 rows → 409 only_n_left with
// the number the jar really has, which `pre` carries in the same statement.
//   * delta_at = now() on every move (06 §1.3 item 5); consumed_at stamped (kept) at 0 left.
//   * boss F2: on a WEIGHED jar (one container, a mass unit) that reaches 0 left, remaining_amount is
//     set to 0 in the same UPDATE, so the batch line never reads "about 92 g left" beside "used up".
//   * The key is the tap's (V4 "Idempotency"): a 23505 on uq_pantry_use_idempotency_key is a replay.
//   * preservation_log is audited, so the statement rides the actor GUC in one transaction.
import { KITCHEN_UUID_RE, MASS_G } from './kitchenBatch.js';

const MASS_UNITS = Object.keys(MASS_G);
const bad = (error) => ({ status: 400, body: { error } });
const isUuid = (v) => typeof v === 'string' && KITCHEN_UUID_RE.test(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// Release B′ widens the fates this route writes (V4 §2.5 "Went bad" / "Gave it away"). NULL = eaten.
// F's chk_pantry_use_fate already admits both; v5-pantry-001 gates.yml pins that it still does.
export const USE_FATES = ['discarded', 'given_away'];

export function isPantryUsesPath(rawPath) {
  return rawPath === '/api/pantry/uses' || rawPath === '/api/pantry/uses/';
}

export function validateUse(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body required';
  const known = ['idempotency_key', 'preservation_log_id', 'count_used', 'all_remaining', 'fate'];
  const unknown = Object.keys(body).filter((k) => !known.includes(k));
  if (unknown.length) return `unknown field(s): ${unknown.join(', ')}`;
  if (!isUuid(body.idempotency_key ?? null)) return 'idempotency_key must be a uuid';
  if (!isUuid(body.preservation_log_id ?? null)) return 'preservation_log_id must be a uuid';
  // B′ (V4 §2.5): the row sheet's two fates. 'batch' stays the line routes' alone.
  if (has(body, 'fate') && body.fate != null && !USE_FATES.includes(body.fate)) {
    return `fate must be one of: ${USE_FATES.join(', ')} (or absent, for eaten)`;
  }
  const all = body.all_remaining === true;
  if (has(body, 'all_remaining') && typeof body.all_remaining !== 'boolean') return 'all_remaining must be true or false';
  if (all === (body.count_used != null)) return 'send count_used or all_remaining: true, one of them';
  // "Went bad" is a use of what is LEFT (V4 §2.5), never of a count.
  if (body.fate === 'discarded' && !all) return 'Went bad is all that is left — send all_remaining: true';
  if (!all && (!Number.isInteger(Number(body.count_used)) || Number(body.count_used) < 1)) {
    return 'count_used must be a whole number, 1 or more';
  }
  return null;
}

export async function handlePantryUses({ sql, rawPath, method, rawBody, userId, householdIds }) {
  if (!isPantryUsesPath(rawPath)) return null;
  if (method !== 'POST') return { status: 405, body: { error: 'Method not allowed' } };
  const body = JSON.parse(rawBody ?? '{}');
  const verr = validateUse(body);
  if (verr) return bad(verr);
  const all = body.all_remaining === true;
  const n = all ? null : Number(body.count_used);
  let rows;
  try {
    [, rows] = await sql.transaction([
      sql`SELECT set_config('app.actor_clerk_sub', ${userId}, true)`,
      sql`
      WITH prior AS (
        -- A tap already recorded under this key is a REPLAY, decided before anything moves: without
        -- this, a retried "Used up" meets 0 left and answers only_n_left instead of its own success.
        SELECT u.id FROM pantry_use u WHERE u.idempotency_key = ${body.idempotency_key}::uuid
      ), pre AS (
        SELECT p.id, COALESCE(p.remaining_count, p.package_count) AS left_n
        FROM preservation_log p
        WHERE p.id = ${body.preservation_log_id}::uuid
          AND p.user_id = ANY(${householdIds})
          AND p.deleted_at IS NULL
        FOR UPDATE
      ), want AS (
        SELECT pre.id, CASE WHEN ${all}::boolean THEN pre.left_n ELSE ${n}::int END AS n FROM pre
        WHERE NOT EXISTS (SELECT 1 FROM prior)
      ), jar AS (
        UPDATE preservation_log p SET
          remaining_count  = COALESCE(p.remaining_count, p.package_count) - w.n,
          delta_at         = now(),
          consumed_at      = CASE WHEN COALESCE(p.remaining_count, p.package_count) - w.n = 0
                                  THEN COALESCE(p.consumed_at, now()) ELSE p.consumed_at END,
          remaining_amount = CASE WHEN p.package_count = 1 AND p.quantity_unit = ANY(${MASS_UNITS}::text[])
                                   AND COALESCE(p.remaining_count, p.package_count) - w.n = 0
                                  THEN 0 ELSE p.remaining_amount END
        FROM want w
        WHERE p.id = w.id
          AND w.n >= 1
          AND COALESCE(p.remaining_count, p.package_count) >= w.n
        RETURNING p.id, p.remaining_count, p.consumed_at, p.remaining_amount, w.n AS used
      ), use AS (
        INSERT INTO pantry_use (created_by, preservation_log_id, count_used, fate, idempotency_key)
        SELECT ${userId}::text, jar.id, jar.used, ${body.fate ?? null}::text, ${body.idempotency_key}::uuid FROM jar
        RETURNING id, created_by, preservation_log_id, count_used, fate, kitchen_batch_input_id,
                  reverses_use_id, idempotency_key, used_at, note, created_at
      )
      SELECT (SELECT count(*)::int FROM prior) AS prior_n,
             (SELECT left_n FROM pre) AS left_n,
             (SELECT row_to_json(use) FROM use) AS use,
             (SELECT json_build_object('id', jar.id, 'remaining_count', jar.remaining_count,
                                       'consumed_at', jar.consumed_at, 'remaining_amount', jar.remaining_amount)
                FROM jar) AS jar
    `,
    ]);
  } catch (err) {
    if (err?.code === '23505' && err.constraint === 'uq_pantry_use_idempotency_key') return replayUse(sql, body, householdIds);
    throw err;
  }
  const r = rows[0] ?? {};
  if (r.prior_n) return replayUse(sql, body, householdIds);
  if (r.left_n == null) return { status: 404, body: { error: 'Not found', code: 'not_found' } };
  if (!r.use) {
    const left = Number(r.left_n);
    return {
      status: 409,
      body: {
        error: left === 0 ? 'None are left in that one.' : `Only ${left} left in that one.`,
        code: 'only_n_left',
        n: left,
      },
    };
  }
  return { status: 201, body: { use: r.use, jar: r.jar } };
}

// The replay: the use under this key, read owner-scoped through its jar (V4 "Idempotency": a key
// someone outside the household holds is a 409 with no payload).
async function replayUse(sql, body, householdIds) {
  const prior = await sql`
    SELECT row_to_json(u) AS use,
           json_build_object('id', p.id, 'remaining_count', p.remaining_count,
                             'consumed_at', p.consumed_at, 'remaining_amount', p.remaining_amount) AS jar
    FROM pantry_use u
    JOIN preservation_log p ON p.id = u.preservation_log_id
    WHERE u.idempotency_key = ${body.idempotency_key}::uuid
      AND p.user_id = ANY(${householdIds})
  `;
  if (!prior.length) return { status: 409, body: { error: 'That key is already in use.', code: 'key_conflict' } };
  return { status: 200, body: { replayed: true, use: prior[0].use, jar: prior[0].jar } };
}
