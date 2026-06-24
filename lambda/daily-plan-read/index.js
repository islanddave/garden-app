// /api/daily-plan — DRG-TODAY-002 read model. GET-only, Clerk-authed, PER-USER, soft-delete filtered.
// Returns the persisted daily_plan row the overnight engine (DRG-TODAY-001) wrote for the requester's
// LOCAL (America/New_York) calendar date. Mutates nothing — the engine is the producer; this is the thin
// read seam the Today surface consumes. PER-USER (NOT household-scoped): each caretaker sees only their
// own plan (Dave's list vs Jen's list), matching the engine's one-row-per-user_id-per-day write. Mirrors
// lambda/findings/index.js on the auth/secrets/CORS seam (live, prod-proven).
import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
const SCHEMA_VERSION = 1;       // API-response envelope version (client contract)
// DRG-WATERRECON-002: the version the STORED daily_plan.items must carry — pinned to
// lambda/daily-plan/engine.js PLAN_SCHEMA_VERSION (lockstep enforced by an anti-drift source test).
// A stored plan whose schema_version differs is a field-rename/shape-drift signal: we FAIL LOUD
// (log + schema_stale flag) and refuse to serve the now-untrustworthy task arrays as a real plan.
const PLAN_SCHEMA_VERSION = 1;

let _secrets = null;
async function getSecrets() {
  if (_secrets) return _secrets;
  const cmd = new GetSecretValueCommand({ SecretId: process.env.SECRET_NAME ?? 'garden-app/secrets' });
  const res = await sm.send(cmd);
  _secrets = JSON.parse(res.SecretString);
  return _secrets;
}

const CORS = {}; // Lambda URL config is sole CORS source — handler must not duplicate.
function resp(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...CORS }, body: JSON.stringify(body) };
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
      authorizedParties: ['https://garden.futureishere.net', 'https://dg6mmjhepoyt9.cloudfront.net'],
    });
    userId = payload.sub;
  } catch (err) {
    console.error('verifyToken failed:', err?.message ?? String(err));
    return resp(401, { error: 'Unauthorized' });
  }

  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/api/daily-plan';
  if (method !== 'GET' || rawPath !== '/api/daily-plan') {
    return resp(405, { error: 'Method not allowed' });
  }

  const sql = neon(secrets.NEON_DATABASE_URL);
  try {
    // Always returns exactly one row carrying today's ET date; items/generated_at are NULL when the engine
    // has not written a plan for this user today. plan_date is computed server-side so a client clock cannot
    // shift which day is served. Per-user; soft-delete filtered; newest wins.
    const rows = await sql`
      SELECT
        to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') AS plan_date,
        dp.items        AS items,
        dp.generated_at AS generated_at
      FROM (SELECT 1) _seed
      LEFT JOIN daily_plan dp
        ON dp.user_id = ${userId}
       AND dp.plan_date = (now() AT TIME ZONE 'America/New_York')::date
       AND dp.deleted_at IS NULL
      ORDER BY dp.generated_at DESC NULLS LAST
      LIMIT 1
    `;
    const row = rows[0] ?? {};
    let plan = row.items ?? null;
    // DRG-WATERRECON-002: guard the STORED plan's schema_version. A present plan whose version != expected
    // means the engine's items shape drifted out from under this reader — FAIL LOUD (log + schema_stale)
    // and serve an honest empty state rather than silently mapping renamed/garbage fields.
    let schemaStale = false;
    if (plan) {
      const storedV = (plan.schema_version ?? null);
      if (storedV !== null && storedV !== PLAN_SCHEMA_VERSION) {  // null = pre-stamp legacy row (current shape) -> serve
        console.error('[daily-plan] stored plan schema_version mismatch — refusing to serve stale/garbage plan',
          { storedV, expected: PLAN_SCHEMA_VERSION });
        schemaStale = true;
        plan = null;
      } else {
        // V3-TODAYDONE-001: best-effort read-time check-off — never let it break the prod Today read.
        try { plan = await annotateDone(sql, plan); }
        catch (e) { console.error('done-annotate (non-fatal):', e?.message ?? String(e)); }
      }
    }
    return resp(200, {
      schema_version: SCHEMA_VERSION,
      plan_date: row.plan_date ?? null,
      generated_at: row.generated_at ?? null,
      has_plan: row.items != null && !schemaStale,
      schema_stale: schemaStale,
      plan: plan,
    });
  } catch (err) {
    console.error('daily-plan-read lambda error', err);
    return resp(500, { error: 'Internal server error' });
  }
};

// V3-TODAYDONE-001 — read-time check-off. An actionable plan item is "done" for the day when a satisfying
// event was logged today (ET) for that planting. Derived from event_log, never stored (cross-device truthful).
// Placed AFTER the handler so the plan SELECT remains the first tagged query in the file (static-guard ordering).
const DONE_EVENTS = {
  water_due:  ['watering', 'rain'],
  no_history: ['watering', 'rain'],
  fertilize:  ['fertilizing'],
  pest:       ['observation', 'pest_treatment'],
  cold:       ['brought_inside', 'cover'],
};
export async function annotateDone(sql, plan) {
  const ids = [];
  for (const k of Object.keys(DONE_EVENTS)) for (const it of (plan?.[k] || [])) if (it && it.id) ids.push(it.id);
  if (ids.length === 0) return plan;
  const rows = await sql`
    SELECT DISTINCT e.plant_id, e.event_type
    FROM event_log e
    WHERE e.plant_id = ANY(${ids})
      AND e.deleted_at IS NULL
      AND (e.event_date AT TIME ZONE 'America/New_York')::date
          = (now() AT TIME ZONE 'America/New_York')::date
  `;
  const sat = new Set(rows.map((r) => `${r.plant_id}|${r.event_type}`));
  const out = { ...plan };
  for (const [k, types] of Object.entries(DONE_EVENTS)) {
    if (!Array.isArray(plan[k])) continue;
    out[k] = plan[k].map((it) => ({ ...it, done: !!(it && it.id && types.some((t) => sat.has(`${it.id}|${t}`))) }));
  }
  return out;
}
