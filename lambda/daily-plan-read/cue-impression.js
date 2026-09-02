// cue-impression.js — OPS-CUEINSTRUMENT-001. The write path for the Today weather-cue impression log
// (public.weather_cue_impression, migrations/ops-cueinstrument-001).
//
// WHAT IT MEASURES: "the cue was on screen, in this form, on this ET day". The negative label needs
// no new capture — join shown_on to what was logged that day in event_log, exactly as the watch and
// tray impression logs do. Without it, V5-WXCALLOUTRENDER-001 is a test that cannot fail: a cue
// shown and correctly ignored looks identical to a cue that never fired. public.ready_impression was
// the last instrument of this shape and it was dropped with V4-WEIGHQUEUEKILL-001; the six days it
// did survive produced the only real numbers anyone has about whether Dave acts on a surfaced cue.
//
// WHY THE CLIENT SENDS THE ROW AND THE SERVER DOES NOT DERIVE IT. Same structural reason as
// ready-impression.js, for a different surface. The cue is COMPUTED server-side (engine.js
// computeCallout, frozen into daily_plan.items), but whether it was RENDERED is a client fact: the
// Today block that hosts it only mounts when there is a plan, and the check-form mapping in
// src/lib/weatherCue.js can decline a cue whose engine copy no longer parses. A GET-side writer
// would record intent-to-serve and call it exposure. So the client sends what it painted, and this
// module's job is to distrust it: cue and form are validated against closed vocabularies that
// mirror the CHECK constraints, and shown_on is stamped from the SERVER's ET clock rather than the
// request, because a skewed phone clock or a tab left open across midnight would otherwise corrupt
// the dedupe grain the whole design rests on.
//
// SAME ROUTING TRICK AS ready-impression.js. /api/daily-plan/cue-impressions rides the EXISTING
// /api/daily-plan prefix in src/lib/api.js (first-match PREFIX table), so it lands on this Lambda
// with ZERO infra change: no new Function URL, no repo variable, no deploy-lambda.yml matrix entry,
// no api.js edit. It lives in its OWN module rather than in index.js for two reasons: index.js
// imports @neondatabase/@clerk/@aws-sdk at module scope and so cannot be executed by CI at all
// (index.test.js reads it as text), and index.test.js indexes that file's tagged templates
// POSITIONALLY — adding one there would silently re-point three existing guards at the wrong query.

export const CUE_IMPRESSIONS_PATH = '/api/daily-plan/cue-impressions';

// The plan reader stamps every date in this Lambda from America/New_York; the impression's civil day
// has to agree with the plan_date it describes, so the constant is restated here rather than derived
// from a request the client controls.
export const ET_TZ = 'America/New_York';

// MIRROR of src/lib/weatherCue.js WX_CUE_MODEL_VERSION, pinned in lockstep by cue-impression.test.js
// (same mechanism as ready-impression.js READY_MODEL_VERSION — the Lambda and src/ are separate
// module graphs and cannot share a constant). Used ONLY as the fallback when a request omits
// model_version: the client owns the model identity here, because the client owns the wording.
export const WX_CUE_MODEL_VERSION = 'wxcue-v1';

// Closed vocabularies, mirroring weather_cue_impression_cue_chk / _form_chk. CUES is engine.js
// computeCallout's five rules in priority order; FORMS is the render's two wordings. Rejecting here
// keeps the CHECK the backstop it is meant to be rather than the first line of defence — and a
// value outside these is a client/engine drift signal worth dropping loudly in the metric line,
// not a row worth writing.
export const CUES = new Set(['freeze', 'cold', 'heat', 'rain', 'wet']);
export const FORMS = new Set(['imperative', 'check']);

const MODEL_VERSION_MAX_LEN = 40;

export function resolveModelVersion(raw) {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= MODEL_VERSION_MAX_LEN
    ? raw
    : WX_CUE_MODEL_VERSION;
}

// The staleness coordinate, and the one field the client can supply garbage for without costing the
// row. Returns an ISO string or null; null is a real answer (the column is nullable) and is what a
// plan served before generated_at existed, or a client that omits it, correctly produces.
export function normalizePlanGeneratedAt(raw) {
  if (typeof raw !== 'string' && !(raw instanceof Date)) return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

// PURE. Validate + coerce one request body into an insertable row, or null.
//
// Single row, not a batch — computeCallout is priority-ordered and returns AT MOST ONE cue, so a
// batch shape here would invent a plurality the producer cannot express and hand the analysis a
// grain it would have to collapse back down.
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
  // A 405 rather than a fall-through, same reasoning as ready-impression.js: falling through hands
  // the request to the daily-plan read model, which answers with a plan for the wrong route.
  return { kind: 'method_not_allowed' };
}

// POST /api/daily-plan/cue-impressions
//
// ALWAYS 202, NEVER 4xx/5xx FOR A DATA PROBLEM. The client is a fire-and-forget beacon that swallows
// its response entirely (src/lib/weatherCueImpressions.js), so a status code has no reader — its only
// effect would be to turn a telemetry hiccup into a CloudWatch error rate on the Lambda that serves
// Today's plan, and, if the client ever grew a retry, into load on that read. A malformed body is
// dropped in normalization; a DB failure (including "relation does not exist" while the migration
// has not landed) logs a warning and still returns 202. Same fail-open posture as
// recordWatchImpressions and handleReadyImpressionPost, for the same reason: losing one day's
// impression is a rounding error against interfering with the Today read.
export async function handleCueImpressionPost(ctx) {
  const { sql, userId, body = {} } = ctx;
  const row = normalizeCueImpression(body);
  if (!row) return { statusCode: 202, body: { accepted: 0 } };

  try {
    // An explicit ::cast on EVERY bind. plan_generated_at is nullable and Neon's driver cannot type
    // a bare null parameter ("could not determine data type of parameter") — which, inside this
    // try/catch, would present as the log silently never populating rather than as an error anyone
    // sees. shown_on is stamped from the SERVER's ET clock, never the request body.
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
    // Named observability, matching the weather and watch writers: a log that quietly writes nothing
    // (an all-conflict day — the common case, since Dave opens Today many times) stays visible in
    // CloudWatch before anyone reads the table. `accepted` counts the row SUBMITTED; ON CONFLICT can
    // reduce what actually lands, and claiming otherwise would overstate the denominator.
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
