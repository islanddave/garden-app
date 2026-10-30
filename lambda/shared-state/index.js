import { neon } from '@neondatabase/serverless';
import { householdActive } from './household.js';
import { requestContext } from './request-context.js';

// garden_shared_state — the shared-garden reward substrate (V3-REWARDSTATE-001).
// Workspace-shared (not per-user): until V4 Workspaces there is no `workspaces` table on
// prod, so every authenticated household member reads/writes the SAME row set under the
// denormalized SENTINEL workspace value. SENTINEL mirrors gv.sentinel_workspace() and the
// workspace_id DEFAULT on the 8 Foundation tables. The data is common to the household, so the
// caller must be a household MEMBER, not just a logged-in user (BUG-AUTHZLAMBDA-001 B6).
const SENTINEL_WORKSPACE = '00000000-0000-0000-0000-000000000001';

const CORS = {}; // Lambda URL config is sole CORS source — handler must not duplicate

function resp(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(body),
  };
}

// UTC calendar date (YYYY-MM-DD) — the natural_key for a featured_of_day row.
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const PAYLOAD_MAX_CHARS = 2048;
const TALLY_BY_MAX = 100;

export const handler = async (event) => {
  // The kit answers OPTIONS and every sign-in refusal (401, the household gate's 403) before any statement.
  const ctx = await requestContext(event, { resp, neon });
  if (ctx.response) return ctx.response;
  const { userId, sql } = ctx;

  // The shared row belongs to one household, and a one-entry list is not a household, so it refuses even
  // its one member, still before any statement (the kit's neon() client issues nothing until queried). The
  // client turns any non-OK into null and renders nothing, so this log line is the only place a denial is
  // visible. Known limitation: one global list over a sentinel-pinned row; per-Space gating comes with
  // Spaces. Guard: membership-gate.test.js.
  if (!householdActive()) {
    console.warn(JSON.stringify({ msg: 'household-membership-denied', userId, reason: 'env-missing' }));
    return resp(403, { error: 'Forbidden' });
  }

  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '';

  try {
    // ── Featured-of-day ────────────────────────────────────────────────────────
    // GET /api/shared-state/featured-of-day[?date=YYYY-MM-DD]  -> { date, featured, updated_at }
    if (rawPath === '/api/shared-state/featured-of-day' && method === 'GET') {
      const date = event.queryStringParameters?.date ?? todayUTC();
      if (!DATE_RE.test(date)) return resp(400, { error: 'date must be YYYY-MM-DD' });
      const rows = await sql`
        SELECT payload, updated_at
        FROM garden_shared_state
        WHERE workspace_id = ${SENTINEL_WORKSPACE}::uuid
          AND kind = 'featured_of_day'
          AND natural_key = ${date}
          AND deleted_at IS NULL
      `;
      return resp(200, { date, featured: rows[0]?.payload ?? null, updated_at: rows[0]?.updated_at ?? null });
    }

    // PUT /api/shared-state/featured-of-day  { date?, payload }  -> upsert the day's featured item
    if (rawPath === '/api/shared-state/featured-of-day' && method === 'PUT') {
      const body = JSON.parse(event.body ?? '{}');
      const date = body.date ?? todayUTC();
      if (!DATE_RE.test(date)) return resp(400, { error: 'date must be YYYY-MM-DD' });
      if (body.payload === undefined || body.payload === null) return resp(400, { error: 'payload is required' });
      // BUG-LAMBDAVALIDATION-001 (I28): the shared row is read by every member's Today page, so it
      // gets a shape and a size. The one client sends { id } (~40 chars); no key is required.
      if (typeof body.payload !== 'object' || Array.isArray(body.payload)) {
        return resp(400, { error: 'payload must be an object' });
      }
      if (JSON.stringify(body.payload).length > PAYLOAD_MAX_CHARS) {
        return resp(400, { error: `payload must be at most ${PAYLOAD_MAX_CHARS} characters` });
      }
      const rows = await sql`
        INSERT INTO garden_shared_state (workspace_id, kind, natural_key, payload)
        VALUES (${SENTINEL_WORKSPACE}::uuid, 'featured_of_day', ${date}, ${JSON.stringify(body.payload)}::jsonb)
        ON CONFLICT (workspace_id, kind, natural_key) WHERE deleted_at IS NULL
        DO UPDATE SET payload = EXCLUDED.payload
        RETURNING payload, updated_at
      `;
      return resp(200, { date, featured: rows[0]?.payload ?? null, updated_at: rows[0]?.updated_at ?? null });
    }

    // ── Shared sighting tally (garden-wide atomic counter) ──────────────────────
    // GET /api/shared-state/tally/{natural_key}  -> { natural_key, counter }
    const tallyGet = rawPath.match(/^\/api\/shared-state\/tally\/([^/]+)$/);
    if (tallyGet && method === 'GET') {
      const key = decodeURIComponent(tallyGet[1]);
      if (!KEY_RE.test(key)) return resp(400, { error: 'invalid natural_key' });
      const rows = await sql`
        SELECT counter
        FROM garden_shared_state
        WHERE workspace_id = ${SENTINEL_WORKSPACE}::uuid
          AND kind = 'incentive_counter'
          AND natural_key = ${key}
          AND deleted_at IS NULL
      `;
      return resp(200, { natural_key: key, counter: Number(rows[0]?.counter ?? 0) });
    }

    // POST /api/shared-state/tally/{natural_key}/increment  { by? }  -> atomic +by
    const tallyInc = rawPath.match(/^\/api\/shared-state\/tally\/([^/]+)\/increment$/);
    if (tallyInc && method === 'POST') {
      const key = decodeURIComponent(tallyInc[1]);
      if (!KEY_RE.test(key)) return resp(400, { error: 'invalid natural_key' });
      const body = JSON.parse(event.body ?? '{}');
      // BUG-LAMBDAVALIDATION-001 (I28): an integer `by` is capped; anything else still counts as 1.
      if (Number.isInteger(body.by) && body.by > TALLY_BY_MAX) {
        return resp(400, { error: `by must be at most ${TALLY_BY_MAX}` });
      }
      const by = Number.isInteger(body.by) && body.by > 0 ? body.by : 1;
      // Atomic single-statement increment. The row-level lock taken on the ON CONFLICT
      // UPDATE serializes concurrent +by writes so none are lost (the migration dry-run
      // proved 2x100 concurrent = 200). Deliberately NO optimistic-version guard here: a
      // version-mismatch retry loop would shed concurrent increments. version still bumps
      // via the gv.bump_version trigger.
      const rows = await sql`
        INSERT INTO garden_shared_state (workspace_id, kind, natural_key, counter)
        VALUES (${SENTINEL_WORKSPACE}::uuid, 'incentive_counter', ${key}, ${by})
        ON CONFLICT (workspace_id, kind, natural_key) WHERE deleted_at IS NULL
        DO UPDATE SET counter = garden_shared_state.counter + ${by}
        RETURNING counter
      `;
      return resp(200, { natural_key: key, counter: Number(rows[0]?.counter ?? 0) });
    }

    return resp(405, { error: 'Method not allowed' });

  } catch (err) {
    console.error('shared-state lambda error', err);
    return resp(500, { error: 'Internal server error' });
  }
};
