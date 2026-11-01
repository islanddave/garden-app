// OPS-CUEINSTRUMENT-001: the write path for the Today weather-cue impression log
// (public.weather_cue_impression, migrations/ops-cueinstrument-001).
//
// It measures "the cue was on screen, in this form, on this ET day". The negative label needs no new
// capture: join shown_on to what was logged that day in event_log, as the watch and tray impression logs do.
// Without it V5-WXCALLOUTRENDER-001 is a test that cannot fail, since a cue shown and correctly ignored
// looks identical to a cue that never fired.
//
// WHY THE CLIENT SENDS THE ROW AND THE SERVER DOES NOT DERIVE IT. The cue is COMPUTED server-side (engine.js
// computeCallout, frozen into daily_plan.items), but whether it was RENDERED is a client fact: the Today
// block only mounts when there is a plan, and src/lib/weatherCue.js can decline a cue whose engine copy no
// longer parses. A GET-side writer would record intent-to-serve and call it exposure. So this module
// distrusts the client: cue and form are validated against closed vocabularies that mirror the CHECK
// constraints, and shown_on is stamped from the SERVER's ET clock, since a skewed phone clock or a tab left
// open across midnight would corrupt the dedupe grain.
//
// ROUTING. /api/daily-plan/cue-impressions rides the existing /api/daily-plan prefix in src/lib/api.js, so
// it needs ZERO infra change. It lives in its OWN module, not index.js, because index.js imports
// @neondatabase/@clerk/@aws-sdk at module scope and cannot be executed by CI (index.test.js reads it as
// text), and index.test.js indexes that file's tagged templates POSITIONALLY: adding one there would
// silently re-point three existing guards at the wrong query.

export const CUE_IMPRESSIONS_PATH = '/api/daily-plan/cue-impressions';

// The plan reader stamps every date in this Lambda from America/New_York; the impression's civil day has to
// agree with the plan_date it describes, so the constant is restated here, not derived from the client.
export const ET_TZ = 'America/New_York';

// MIRROR of src/lib/weatherCue.js WX_CUE_MODEL_VERSION (the Lambda and src/ are separate module graphs),
// pinned in lockstep by cue-impression.test.js. Used ONLY as the fallback when a request omits model_version.
export const WX_CUE_MODEL_VERSION = 'wxcue-v3';

// Closed vocabularies, mirroring weather_cue_impression_cue_chk / _form_chk. CUES is engine.js computeCallout's
// six rules in priority order (`cool` admitted by migrations/v5-chillband-001/0a-widen-cue-check.sql); FORMS is
// the render's two wordings. Rejecting here keeps the CHECK a backstop, and a value outside these is a
// client/engine drift signal worth dropping loudly in the metric line.
export const CUES = new Set(['freeze', 'cold', 'cool', 'heat', 'rain', 'wet']);
export const FORMS = new Set(['imperative', 'check']);

const MODEL_VERSION_MAX_LEN = 40;

export function resolveModelVersion(raw) {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= MODEL_VERSION_MAX_LEN
    ? raw
    : WX_CUE_MODEL_VERSION;
}

// The staleness coordinate, and the one field the client can supply garbage for without costing the row.
// null is a real answer (the column is nullable): a plan served before generated_at existed, or a client that omits it.
export function normalizePlanGeneratedAt(raw) {
  if (typeof raw !== 'string' && !(raw instanceof Date)) return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

// PURE. Validate + coerce one request body into an insertable row, or null. Single row, not a batch:
// computeCallout returns AT MOST ONE cue, so a batch shape would invent a plurality the producer cannot express.
export function normalizeCueImpression(body) {
  const b = body ?? {};
  if (!CUES.has(b.cue) || !FORMS.has(b.form)) return null;
  return {
    cue: b.cue,
    form: b.form,
    model_version: resolveModelVersion(b.model_version),
    plan_generated_at: normalizePlanGeneratedAt(b.plan_generated_at),
  };
}

export function matchCueImpressionRoute(method, rawPath) {
  if (rawPath !== CUE_IMPRESSIONS_PATH) return null;
  if (method === 'POST') return { kind: 'cue_impression_post' };
  // A 405 rather than a fall-through: falling through hands the request to the daily-plan read model, which answers with a plan for the wrong route.
  return { kind: 'method_not_allowed' };
}

// POST /api/daily-plan/cue-impressions. ALWAYS 202, NEVER 4xx/5xx FOR A DATA PROBLEM. The client is a
// fire-and-forget beacon that swallows its response (src/lib/weatherCueImpressions.js), so a status code has
// no reader; its only effect would be a CloudWatch error rate on the Lambda that serves Today's plan. A
// malformed body is dropped in normalization; a DB failure (including "relation does not exist" before the
// migration lands) logs a warning and still returns 202. Same fail-open posture as recordWatchImpressions
// and handleReadyImpressionPost: losing one day's impression is a rounding error against interfering with Today.
export async function handleCueImpressionPost(ctx) {
  const { sql, userId, body = {} } = ctx;
  const row = normalizeCueImpression(body);
  if (!row) return { statusCode: 202, body: { accepted: 0 } };

  try {
    // An explicit ::cast on EVERY bind: plan_generated_at is nullable and Neon's driver cannot type a bare
    // null parameter, which inside this try/catch would present as the log silently never populating.
    // shown_on is stamped from the SERVER's ET clock, never the request body.
    await sql`
      INSERT INTO public.weather_cue_impression
        (user_id, shown_on, cue, form, model_version, plan_generated_at)
      VALUES (${userId}::text,
              (NOW() AT TIME ZONE ${ET_TZ}::text)::date,
              ${row.cue}::text,
              ${row.form}::text,
              ${row.model_version}::text,
              ${row.plan_generated_at}::timestamptz)
      ON CONFLICT (user_id, shown_on, cue) DO NOTHING
    `;
    // Named observability: a log that quietly writes nothing (an all-conflict day, the common case) stays
    // visible in CloudWatch. `accepted` counts the row SUBMITTED; ON CONFLICT can reduce what lands.
    console.log(JSON.stringify({
      metric: 'weather_cue_impression', model_version: row.model_version,
      cue: row.cue, form: row.form, stamped: row.plan_generated_at != null,
    }));
    return { statusCode: 202, body: { accepted: 1 } };
  } catch (e) {
    console.warn(JSON.stringify({
      msg: 'weather_cue_impression write failed — Today unaffected', error: e?.message,
    }));
    return { statusCode: 202, body: { accepted: 0 } };
  }
}
