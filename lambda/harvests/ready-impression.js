// ready-impression.js — V4-READYTRAYIMPRESSION-001. The write path for the harvest-session weigh-in
// tray's impression log (public.ready_impression, migrations/v4-readytrayimpression-001).
//
// WHAT IT MEASURES: "shown and not picked", with NO dismissal UI. The tray offers up to 14 chips at
// the top of /log?session=harvest; whether a chip gets tapped is already the signal. The negative
// label is derived by anti-joining the harvests logged that ET day — recon §D argues at length that
// a "not yet" control on a SEEDING tray would be UX noise, and V4-READYDISMISS-001 stays dropped.
//
// WHY THE CLIENT SENDS THE ROWS AND THE SERVER DOES NOT COMPUTE THEM. This is the one structural
// difference from recordWatchImpressions in watch-route.js, and it is not a shortcut. The watch band
// is ranked SERVER-side, so that writer reproduces the client's slot walk and labels regions itself.
// This surface ranks in the BROWSER (src/lib/harvestReadiness.js rankHarvestReady), merges in a
// recency fallback the server never sees, caps at 14 and then collapses to HARVEST_TRAY_COLLAPSED_MAX
// against the keyboard-shrunk viewport. The server cannot reconstruct a chip's slot or its region
// from any query. So the client sends what it rendered, and this module's job is to distrust it:
// every field is validated against a closed vocabulary, every row is scoped to the caller's
// household, and anything that does not typecheck is DROPPED rather than allowed to fail the batch.
//
// SAME ROUTING TRICK AS THE WATCH ROUTES. /api/harvests/ready-impressions rides the EXISTING
// /api/harvests prefix in src/lib/api.js (first-match PREFIX table), so it lands on this Lambda with
// ZERO infra change: no new Function URL, no repo variable, no deploy-lambda.yml matrix entry, no
// api.js edit. It lives HERE rather than in lambda/events — which serves the harvest-ready GET —
// deliberately: lambda/events also serves POST /api/events, the harvest save this write must never
// be able to disturb, and physical separation is a stronger guarantee than a careful try/catch.

import { isUuid } from './watch-route.js';

export const READY_IMPRESSIONS_PATH = '/api/harvests/ready-impressions';

// MIRROR of src/lib/harvestReadiness.js READY_MODEL_VERSION, pinned in lockstep by
// ready-impression.test.js (same mechanism as IMPRESSION_PROJECT_SLOT_CAP — the Lambda and src/ are
// separate module graphs and cannot share a constant). Used ONLY as the fallback when a request
// omits model_version: the client owns the model identity here, because the client IS the model.
export const READY_MODEL_VERSION = 'ready-v1';

// Closed vocabularies, matching ready_impression_region_chk / ready_impression_source_chk. A value
// outside these would fail the CHECK, and the writer inserts the whole tray in ONE statement — so an
// unvalidated string does not corrupt one row, it silently drops the entire session's impressions
// (the batch-blast-radius hazard watch_impression's DDL documents). Rejecting here keeps the CHECK
// as the backstop it is meant to be rather than the first line of defence.
export const READY_REGIONS = new Set(['tray', 'tray_tail']);
export const READY_SOURCES = new Set(['ready', 'recent']);

// The tray caps itself at 14 chips (EventNew.jsx `.slice(0, 14)`). This is the abuse bound, not the
// expected size: a well-behaved client never approaches it. Over-long payloads are TRUNCATED, not
// rejected — telemetry the caller cannot see the failure of should degrade, and the head of the
// array is the ranked part that carries the signal.
export const MAX_READY_IMPRESSIONS = 40;

const MODEL_VERSION_MAX_LEN = 40;
const INT16_MAX = 32767;

function toSmallint(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i >= -INT16_MAX - 1 && i <= INT16_MAX ? i : null;
}

// numeric(8,3) would round a long decimal itself, but rounding here keeps the value the analysis
// reads identical to the value the test asserts, and bounds a nonsense magnitude before it reaches
// the column. MAX_OVERDUE_RATIO is 3 client-side, so anything past 4 digits is a broken client.
function toRatio(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 9999) return null;
  return Math.round(n * 1000) / 1000;
}

// PURE. Validate + coerce the client's array into insertable rows, dropping anything malformed.
// Deduped on (plant_id, region) — the natural key's per-request slice — so one tray cannot bill
// itself twice for the same chip even before ON CONFLICT sees it, and the metric line below counts
// what was actually attempted.
export function normalizeReadyImpressions(items) {
  const out = [];
  const seen = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || !isUuid(it.plant_id)) continue;
    if (!READY_REGIONS.has(it.region) || !READY_SOURCES.has(it.source)) continue;
    const slot = toSmallint(it.slot);
    if (slot == null || slot < 1) continue;
    const key = `${it.plant_id}|${it.region}`;
    if (seen.has(key)) continue;

    // The snapshot contract, enforced ahead of ready_impression_snapshot_chk: a 'ready' row without
    // its rank coordinate is a model row that cannot be calibrated against, and a 'recent' row
    // carrying model fields is a fallback masquerading as a model claim. Both are dropped/nulled
    // here so the CHECK never has to fail a whole batch to say so.
    const isReady = it.source === 'ready';
    const overdueRatio = isReady ? toRatio(it.overdue_ratio) : null;
    if (isReady && overdueRatio == null) continue;

    seen.add(key);
    out.push({
      plant_id: it.plant_id,
      slot,
      region: it.region,
      source: it.source,
      overdue_ratio: overdueRatio,
      days_since_last_harvest: isReady ? toSmallint(it.days_since_last_harvest) : null,
      repeat_interval_days: isReady ? toSmallint(it.repeat_interval_days) : null,
    });
    if (out.length >= MAX_READY_IMPRESSIONS) break;
  }
  return out;
}

export function resolveModelVersion(raw) {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= MODEL_VERSION_MAX_LEN
    ? raw
    : READY_MODEL_VERSION;
}

export function matchReadyImpressionRoute(method, rawPath) {
  if (rawPath !== READY_IMPRESSIONS_PATH) return null;
  if (method === 'POST') return { kind: 'ready_impression_post' };
  // A 405 rather than a fall-through, same reasoning as matchWatchRoute: falling through hands the
  // request to the /api/harvests read model, which answers with a message about the wrong route.
  return { kind: 'method_not_allowed' };
}

// POST /api/harvests/ready-impressions
//
// ALWAYS 202, NEVER 4xx/5xx FOR A DATA PROBLEM. The client is a fire-and-forget beacon that swallows
// its response entirely (src/lib/readyImpressions.js), so a status code has no reader — its only
// effect would be to turn a telemetry hiccup into a CloudWatch error rate and, if the client ever
// grew a retry, into load on the harvest-logging path. Malformed rows are dropped in normalization
// and the count is reported; a DB failure (including "relation does not exist" while the migration
// has not landed) logs a warning and still returns 202. Same fail-open posture as
// recordWatchImpressions, for the same reason: losing one session's impressions is a rounding error
// against interfering with a weigh-in.
export async function handleReadyImpressionPost(ctx) {
  const { sql, userId, householdIds, tz, body = {} } = ctx;
  const rows = normalizeReadyImpressions(body.impressions);
  const modelVersion = resolveModelVersion(body.model_version);
  if (rows.length === 0) return { statusCode: 202, body: { accepted: 0 } };

  try {
    // ONE statement for the whole tray, over unnest'd arrays with an explicit ::cast on EVERY bind —
    // scalar binds in a SELECT list and nullable array elements are both untypeable for Neon's
    // driver ("could not determine data type of parameter"), which inside this try/catch would
    // present as the log silently never populating.
    //
    // shown_on is stamped from the SERVER's ET clock, not the client's: a phone with a skewed clock
    // (or a session open across midnight) would otherwise corrupt the dedupe grain the whole design
    // rests on.
    //
    // THE JOIN IS THE AUTHORIZATION, AND IT IS ALSO THE FK GUARD. plant_ids arrive from the client,
    // so scope is enforced here rather than assumed: a planting is the caller's if its project is
    // (plant_projects.created_by) or, for the 4 live projectless plantings on prod, if the planting
    // itself is. Rows failing that filter are dropped by the join instead of inserted. The same join
    // converts a bogus/deleted plant_id from an FK violation that would drop the ENTIRE batch into a
    // per-row no-op — which matters more here than on the watch path, because here the ids are
    // caller-supplied.
    await sql`
      INSERT INTO public.ready_impression
        (user_id, plant_id, shown_on, slot, region, source, model_version,
         overdue_ratio, days_since_last_harvest, repeat_interval_days)
      SELECT ${userId}::text, u.plant_id, (NOW() AT TIME ZONE ${tz}::text)::date,
             u.slot, u.region, u.source, ${modelVersion}::text,
             u.overdue_ratio, u.days_since_last_harvest, u.repeat_interval_days
        FROM unnest(
               ${rows.map((r) => r.plant_id)}::uuid[],
               ${rows.map((r) => r.slot)}::smallint[],
               ${rows.map((r) => r.region)}::text[],
               ${rows.map((r) => r.source)}::text[],
               ${rows.map((r) => r.overdue_ratio)}::numeric[],
               ${rows.map((r) => r.days_since_last_harvest)}::smallint[],
               ${rows.map((r) => r.repeat_interval_days)}::smallint[]
             ) AS u(plant_id, slot, region, source, overdue_ratio,
                    days_since_last_harvest, repeat_interval_days)
        JOIN public.plants p ON p.id = u.plant_id AND p.deleted_at IS NULL
        LEFT JOIN public.plant_projects pj ON pj.id = p.project_id
       WHERE COALESCE(pj.created_by, p.created_by) = ANY(${householdIds}::text[])
      ON CONFLICT (user_id, plant_id, shown_on, region) DO NOTHING
    `;
    // Named observability, matching the weather and watch writers: a log that quietly writes nothing
    // (all-conflict days, an all-dropped batch) stays visible in CloudWatch before anyone reads the
    // table. `accepted` counts rows SUBMITTED — the ON CONFLICT and the scope join can each reduce
    // what actually lands, and claiming otherwise would overstate the denominator.
    console.log(JSON.stringify({
      metric: 'ready_impressions', model_version: modelVersion,
      tray: rows.filter((r) => r.region === 'tray').length,
      tray_tail: rows.filter((r) => r.region === 'tray_tail').length,
      ready: rows.filter((r) => r.source === 'ready').length,
      recent: rows.filter((r) => r.source === 'recent').length,
    }));
    return { statusCode: 202, body: { accepted: rows.length } };
  } catch (e) {
    console.warn(JSON.stringify({
      msg: 'ready_impression write failed — harvest flow unaffected', error: e?.message,
    }));
    return { statusCode: 202, body: { accepted: 0 } };
  }
}
