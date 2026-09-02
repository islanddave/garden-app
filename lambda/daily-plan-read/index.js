// /api/daily-plan — DRG-TODAY-002 read model. GET-only, Clerk-authed, PER-USER, soft-delete filtered.
// Returns the persisted daily_plan row the overnight engine (DRG-TODAY-001) wrote for the requester's
// LOCAL (America/New_York) calendar date. Mutates nothing — the engine is the producer; this is the thin
// read seam the Today surface consumes. PER-USER (NOT household-scoped): each caretaker sees only their
// own plan (Dave's list vs Jen's list), matching the engine's one-row-per-user_id-per-day write. Mirrors
// lambda/findings/index.js on the auth/secrets/CORS seam (live, prod-proven).
import { neon } from '@neondatabase/serverless';
import { verifyToken } from '@clerk/backend';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { householdScope } from './household.js';  // V4-ASSIGNLENS-001 opt-in household widening (per-dir copy; bundle-safe)
import { applyDone, planItemIds } from './doneEvents.js';  // V3-TODAYDONE-001 vocabulary + pure fold (per-dir copy; bundle-safe)
import { matchCueImpressionRoute, handleCueImpressionPost } from './cue-impression.js';  // OPS-CUEINSTRUMENT-001 write path (dependency-free; CI-executable)

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
  // V4-AUTHZRESIDUE-001 (mirrors lambda/plants + lambda/photos): householdScope('') returns [''] and
  // `'' = ANY(ARRAY[''])` is TRUE in Postgres, so an empty/absent JWT subject would be a live
  // ownership value rather than a no-match. verifyToken rejects such a token first, so this is
  // defence-in-depth; the point is that the invariant is ENFORCED here rather than relied upon.
  if (!userId) return resp(401, { error: 'Unauthorized' });

  const method = event.requestContext?.http?.method ?? 'GET';
  const rawPath = event.rawPath ?? '/api/daily-plan';
  // OPS-CUEINSTRUMENT-001 — the impression beacon rides this Lambda's existing prefix. Handled and
  // RETURNED before the GET guard below, which is left byte-identical: this branch is reachable only
  // on its own literal path, so the plan read cannot be affected by anything in it. The writer is
  // fail-open (always 202) and its SQL lives in cue-impression.js, keeping this file's tagged-template
  // ordering — which index.test.js indexes positionally — untouched.
  const cueRoute = matchCueImpressionRoute(method, rawPath);
  if (cueRoute) {
    if (cueRoute.kind === 'method_not_allowed') return resp(405, { error: 'Method not allowed' });
    let body = {};
    try { body = event.body ? JSON.parse(event.body) : {}; } catch { body = {}; }
    const out = await handleCueImpressionPost({ sql: neon(secrets.NEON_DATABASE_URL), userId, body });
    return resp(out.statusCode, out.body);
  }
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
    // V4-ASSIGNLENS-001 — OPT-IN household widening. Default (no ?include=household) is byte-identical
    // and strictly PER-USER: the household_plans key is OMITTED unless explicitly opted in. Widening is
    // self-authorizing (householdScope resolves the requester's OWN household; a non-member gets []),
    // so there is no attacker-controlled sub to validate.
    const includeHousehold = (event.queryStringParameters?.include) === 'household';
    let householdPlans;
    if (includeHousehold) {
      const otherIds = householdScope(userId).filter((id) => id !== userId);
      householdPlans = await readHouseholdPlans(sql, otherIds);
    }
    const body = {
      schema_version: SCHEMA_VERSION,
      plan_date: row.plan_date ?? null,
      generated_at: row.generated_at ?? null,
      has_plan: row.items != null && !schemaStale,
      schema_stale: schemaStale,
      plan: plan,
    };
    if (includeHousehold) body.household_plans = householdPlans;
    return resp(200, body);
  } catch (err) {
    console.error('daily-plan-read lambda error', err);
    return resp(500, { error: 'Internal server error' });
  }
};

// V3-TODAYDONE-001 — read-time check-off. An actionable plan item is "done" for the day when a satisfying
// event was logged today (ET) for that planting. Derived from event_log, never stored (cross-device truthful).
// Placed AFTER the handler so the plan SELECT remains the first tagged query in the file (static-guard ordering).
// The done vocabulary and the fold itself live in ./doneEvents.js — dependency-free so CI can
// actually EXECUTE them (nothing may import this file: its @neondatabase / @clerk / @aws-sdk
// imports are not installed by the root-only `npm ci`). What stays here is the query that decides
// WHICH events count as satisfying.
export async function annotateDone(sql, plan) {
  const ids = planItemIds(plan);
  if (ids.length === 0) return plan;
  // V4-WATERMATH-001 F0 interim snooze window. watering/rain keep the ET-calendar-day rule (a
  // watering "counts for today"). A `moisture_check` ADDITIONALLY satisfies on a rolling 24h
  // window, because an ET-day-only snooze tapped at 09:00 expires at midnight and the planting
  // re-nags at the 02:00/12:00 run ~17-21h later — a snooze the app visibly overrides, which is the
  // affordance-extinction pattern canon V100 §"Pre-F2 interim snooze semantics" forbids. Two
  // reader-level SQL edits (this one and the dashboard bar's `fresh` CTE), superseded by the engine
  // fold at F2. Written as an OR against the unchanged day predicate rather than as an exclusive
  // branch so no existing type's behaviour moves; the two windows differ only for a moisture_check
  // logged >24h ago but still inside a 25-hour DST fall-back day, where the union is the more
  // lenient (snooze survives ~1h longer) and therefore fail-safe direction.
  const rows = await sql`
    SELECT DISTINCT e.plant_id, e.event_type
    FROM event_log e
    WHERE e.plant_id = ANY(${ids})
      AND e.deleted_at IS NULL
      AND (
            (e.event_date AT TIME ZONE 'America/New_York')::date
              = (now() AT TIME ZONE 'America/New_York')::date
            OR (e.event_type = 'moisture_check' AND e.event_date > now() - INTERVAL '24 hours')
          )
  `;
  const sat = new Set(rows.map((r) => `${r.plant_id}|${r.event_type}`));
  // BUG-BACKDATEDFEED-001 — the feed bucket ALSO checks off on its own cadence, so a feeding recorded
  // today but dated an earlier day retires the card (see doneEvents.js fedWithinInterval for why this
  // widening is correct for feeding and wrong for watering). Scoped to the fertilize items that carry
  // a numeric interval, so a plan stored before engine.js emitted one costs no extra query at all.
  const fertIds = (Array.isArray(plan?.fertilize) ? plan.fertilize : [])
    .filter((it) => it && it.id && typeof it.interval === 'number')
    .map((it) => it.id);
  const ctx = fertIds.length ? await lastFertByPlant(sql, fertIds) : null;
  return applyDone(plan, sat, ctx);
}


// V4-ASSIGNLENS-001 — opt-in read of OTHER household caretakers' plans for today (Today's "also show
// Jen's care needs" section). Per-row: newest-wins dedup, the same schema_version guard as the primary
// plan (a version-skewed row is skipped, never served as garbage), and read-time done-annotation (plant
// -scoped, so a member's items check off from today's events regardless of who logged them). Defined
// AFTER annotateDone so it is the last tagged query in the file (static-guard ordering invariant).
export async function readHouseholdPlans(sql, ids) {
  if (!ids || ids.length === 0) return [];
  const rows = await sql`
    SELECT dp.user_id AS user_id, dp.items AS items, dp.generated_at AS generated_at
    FROM daily_plan dp
    WHERE dp.user_id = ANY(${ids})
      AND dp.plan_date = (now() AT TIME ZONE 'America/New_York')::date
      AND dp.deleted_at IS NULL
    ORDER BY dp.generated_at DESC NULLS LAST
  `;
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.user_id)) continue;   // newest wins (ORDER BY generated_at DESC)
    seen.add(r.user_id);
    let plan = r.items ?? null;
    if (plan) {
      const storedV = plan.schema_version ?? null;
      if (storedV !== null && storedV !== PLAN_SCHEMA_VERSION) { plan = null; }
      else { try { plan = await annotateDone(sql, plan); } catch (e) { console.error('household done-annotate (non-fatal):', e?.message ?? String(e)); } }
    }
    if (plan) out.push({ user_id: r.user_id, generated_at: r.generated_at, plan });
  }
  return out;
}

// BUG-BACKDATEDFEED-001 — newest fertilizing date per planting, as an ET calendar date, plus today's ET
// date from the same round trip (one clock, so the comparison can never straddle two).
//
// Defined LAST on purpose. index.test.js indexes the file's tagged templates positionally (stmts[0]
// = plan read, stmts[1] = done-derivation, stmts[2] = household read); appending here keeps every
// existing index valid instead of silently re-pointing three guards at the wrong query. Same
// ordering invariant readHouseholdPlans documents above — it just is not the last one any more.
//
// Deliberately reads event_log rather than entity_memory.last_fertilized_at: the ENGINE decides
// due-ness from max(event_log.event_date), and a checker that consulted a different surface than the
// generator could disagree with it — the cache is derived, and an undo that repairs one need not
// repair the other in the same instant.
export async function lastFertByPlant(sql, ids) {
  const rows = await sql`
    SELECT e.plant_id AS plant_id,
           to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') AS today,
           to_char(max((e.event_date AT TIME ZONE 'America/New_York')::date), 'YYYY-MM-DD') AS last_fert
    FROM event_log e
    WHERE e.plant_id = ANY(${ids})
      AND e.event_type = 'fertilizing'
      AND e.deleted_at IS NULL
    GROUP BY e.plant_id
  `;
  const lastFert = new Map();
  let today = null;
  for (const r of rows) {
    if (r.last_fert) lastFert.set(r.plant_id, r.last_fert);
    if (r.today) today = r.today;
  }
  // A planting with no fertilizing history yields no row at all, so `today` can be null here; the
  // fold treats a null-today ctx as "no cadence signal" and falls back to the day rule.
  return today ? { today, lastFert } : null;
}
