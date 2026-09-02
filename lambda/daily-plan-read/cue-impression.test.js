// Unit tests for the Today weather-cue IMPRESSION LOG (OPS-CUEINSTRUMENT-001) — the POST handler in
// lambda/daily-plan-read/cue-impression.js.
//
// Same discipline as ready-impression.test.js / watch-impression.test.js: these EXECUTE the handler
// against a recording tagged-template `sql` stub and assert on the parameters actually bound — never
// a regex over the module source. What a stub cannot prove (that ON CONFLICT really arbitrates on
// uq_weather_cue_impression_day, that the CHECKs reject an out-of-vocabulary value) belongs in
// tests/integration/ once migrations/ops-cueinstrument-001 is applied; it is not written yet because
// the relation exists in NO environment — this lane authored the DDL and applied it nowhere.
//
// THE INVARIANT UNDER TEST, and it outranks every other assertion here: this write is a PASSENGER on
// the Lambda that serves Today's plan. No input, no failure, and no absence of the relation may
// produce anything other than a 202 — because the client cannot see the response and must never be
// made to care.
import { describe, it, expect, vi } from 'vitest';
import {
  handleCueImpressionPost, matchCueImpressionRoute, normalizeCueImpression,
  normalizePlanGeneratedAt, resolveModelVersion,
  CUE_IMPRESSIONS_PATH, WX_CUE_MODEL_VERSION, ET_TZ, CUES, FORMS,
} from './cue-impression.js';

const USER = 'user_dave';
const GEN = '2026-09-02T06:12:04.000Z';

function makeSql(results = []) {
  const calls = [];
  const queue = [...results];
  const sql = (strings, ...params) => {
    calls.push({ text: strings.join('?'), params });
    return Promise.resolve(queue.length ? queue.shift() : []);
  };
  sql.calls = calls;
  return sql;
}

function makeSqlFails(message) {
  const calls = [];
  const sql = (strings, ...params) => {
    calls.push({ text: strings.join('?'), params });
    return Promise.reject(new Error(message));
  };
  sql.calls = calls;
  return sql;
}

const ctx = (sql, body) => ({ sql, userId: USER, body });

// Destructure the INSERT's binds by template position:
// VALUES (${userId}, ${ET_TZ}, ${cue}, ${form}, ${modelVersion}, ${planGeneratedAt})
function binds(call) {
  const [userId, tz, cue, form, modelVersion, planGeneratedAt] = call.params;
  return { userId, tz, cue, form, modelVersion, planGeneratedAt };
}

const body = (over = {}) => ({
  cue: 'rain', form: 'check', model_version: WX_CUE_MODEL_VERSION, plan_generated_at: GEN, ...over,
});

describe('normalizeCueImpression — the closed vocabularies mirror the CHECK constraints', () => {
  it('accepts every cue engine.js computeCallout can emit', () => {
    for (const cue of ['freeze', 'cold', 'heat', 'rain', 'wet']) {
      const form = cue === 'freeze' || cue === 'cold' ? 'imperative' : 'check';
      expect(normalizeCueImpression(body({ cue, form }))?.cue).toBe(cue);
    }
    // The set the module exports is what the CHECK is closed at — pin it so widening one without
    // the other is a red test rather than a silent measurement hole.
    expect([...CUES].sort()).toEqual(['cold', 'freeze', 'heat', 'rain', 'wet']);
    expect([...FORMS].sort()).toEqual(['check', 'imperative']);
  });

  it('drops a row whose cue or form is outside the vocabulary', () => {
    expect(normalizeCueImpression(body({ cue: 'hail' }))).toBeNull();
    expect(normalizeCueImpression(body({ form: 'question' }))).toBeNull();
    expect(normalizeCueImpression(body({ cue: undefined }))).toBeNull();
    expect(normalizeCueImpression(undefined)).toBeNull();
    expect(normalizeCueImpression({})).toBeNull();
  });

  it('records the FORM, so the check/imperative split is measurable rather than assumed', () => {
    expect(normalizeCueImpression(body({ cue: 'freeze', form: 'imperative' })).form).toBe('imperative');
    expect(normalizeCueImpression(body({ cue: 'heat', form: 'check' })).form).toBe('check');
  });
});

describe('resolveModelVersion / normalizePlanGeneratedAt', () => {
  it('falls back to the mirrored constant for a missing or unusable model_version', () => {
    expect(resolveModelVersion(undefined)).toBe(WX_CUE_MODEL_VERSION);
    expect(resolveModelVersion('')).toBe(WX_CUE_MODEL_VERSION);
    expect(resolveModelVersion(42)).toBe(WX_CUE_MODEL_VERSION);
    expect(resolveModelVersion('x'.repeat(41))).toBe(WX_CUE_MODEL_VERSION);
    expect(resolveModelVersion('wxcue-v9')).toBe('wxcue-v9');
  });

  it('normalises the staleness coordinate to ISO, or to null — never to a bad value', () => {
    expect(normalizePlanGeneratedAt(GEN)).toBe(GEN);
    expect(normalizePlanGeneratedAt(new Date(GEN))).toBe(GEN);
    expect(normalizePlanGeneratedAt('not a date')).toBeNull();
    expect(normalizePlanGeneratedAt(null)).toBeNull();
    expect(normalizePlanGeneratedAt(1756800000000)).toBeNull();
  });
});

describe('matchCueImpressionRoute', () => {
  it('claims POST on its own path and 405s every other method on it', () => {
    expect(matchCueImpressionRoute('POST', CUE_IMPRESSIONS_PATH)).toEqual({ kind: 'cue_impression_post' });
    expect(matchCueImpressionRoute('GET', CUE_IMPRESSIONS_PATH)).toEqual({ kind: 'method_not_allowed' });
    expect(matchCueImpressionRoute('DELETE', CUE_IMPRESSIONS_PATH)).toEqual({ kind: 'method_not_allowed' });
  });

  it('does NOT claim the plan read — the GET path must reach the read model untouched', () => {
    expect(matchCueImpressionRoute('GET', '/api/daily-plan')).toBeNull();
    expect(matchCueImpressionRoute('POST', '/api/daily-plan')).toBeNull();
  });

  it('rides the existing prefix, so no infra change is implied', () => {
    expect(CUE_IMPRESSIONS_PATH.startsWith('/api/daily-plan')).toBe(true);
  });
});

describe('handleCueImpressionPost — the write', () => {
  it('binds the cue, the form and the model version, and stamps the day SERVER-side in ET', async () => {
    const sql = makeSql();
    const out = await handleCueImpressionPost(ctx(sql, body({ cue: 'heat', form: 'check' })));

    expect(out).toEqual({ statusCode: 202, body: { accepted: 1 } });
    expect(sql.calls).toHaveLength(1);
    const b = binds(sql.calls[0]);
    expect(b).toEqual({
      userId: USER, tz: ET_TZ, cue: 'heat', form: 'check',
      modelVersion: WX_CUE_MODEL_VERSION, planGeneratedAt: GEN,
    });
    // shown_on is NOT a bind — it is computed from the server clock inside the statement, so a
    // skewed phone clock cannot move the dedupe grain.
    expect(sql.calls[0].text).toMatch(/NOW\(\) AT TIME ZONE \?::text\)::date/);
    expect(sql.calls[0].params).toHaveLength(6);
  });

  it('every bind carries an explicit ::cast — a bare null plan_generated_at is untypeable for Neon', async () => {
    const sql = makeSql();
    await handleCueImpressionPost(ctx(sql, body({ plan_generated_at: null })));
    const b = binds(sql.calls[0]);
    expect(b.planGeneratedAt).toBeNull();
    // The cast is what stops "could not determine data type of parameter" — which, inside the
    // handler's own try/catch, would present as the log silently never populating.
    expect(sql.calls[0].text).toMatch(/\?::timestamptz/);
    // EVERY bind, not just the nullable one: 5 ::text (user_id, the tz literal, cue, form,
    // model_version) + 1 ::timestamptz = the 6 params bound above. An uncast bind is the same
    // failure waiting for the first request that passes a null through it.
    const casts = sql.calls[0].text.match(/\?::[a-z]+/g) ?? [];
    expect(casts).toHaveLength(sql.calls[0].params.length);
    expect(casts.filter((c) => c === '?::text')).toHaveLength(5);
    expect(casts.filter((c) => c === '?::timestamptz')).toHaveLength(1);
  });

  it('names the uq_weather_cue_impression_day column list as its ON CONFLICT arbiter', async () => {
    const sql = makeSql();
    await handleCueImpressionPost(ctx(sql, body()));
    expect(sql.calls[0].text).toMatch(/ON CONFLICT \(user_id, shown_on, cue\) DO NOTHING/);
    expect(sql.calls[0].text).toMatch(/INSERT INTO public\.weather_cue_impression/);
  });

  it('writes NOTHING and still 202s when the body is not a renderable cue', async () => {
    const sql = makeSql();
    const out = await handleCueImpressionPost(ctx(sql, { cue: 'hail', form: 'check' }));
    expect(out).toEqual({ statusCode: 202, body: { accepted: 0 } });
    expect(sql.calls).toHaveLength(0);
  });

  it('202s — never 5xx — when the relation does not exist yet', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = makeSqlFails('relation "weather_cue_impression" does not exist');
    const out = await handleCueImpressionPost(ctx(sql, body()));
    expect(out).toEqual({ statusCode: 202, body: { accepted: 0 } });
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.parse(warn.mock.calls[0][0]).error).toMatch(/does not exist/);
    warn.mockRestore();
  });

  it('logs a named metric line, so an all-conflict day is visible before anyone reads the table', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sql = makeSql();
    await handleCueImpressionPost(ctx(sql, body({ cue: 'freeze', form: 'imperative' })));
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      metric: 'weather_cue_impression', model_version: WX_CUE_MODEL_VERSION,
      cue: 'freeze', form: 'imperative', stamped: true,
    });
    log.mockRestore();
  });
});

// ── Mirrored model constant — lockstep pin ───────────────────────────────────────────────────────
// The Lambda restates the CLIENT's model version as its fallback for a request that omits one (the
// module graphs can't share a constant). If either side moves alone, an impression written without
// a client version would be stamped with a generation that never produced it.
describe('the mirrored model version stays in lockstep with src/lib/weatherCue.js', () => {
  it('WX_CUE_MODEL_VERSION === the client constant', async () => {
    const client = await import('../../src/lib/weatherCue.js');
    expect(WX_CUE_MODEL_VERSION).toBe(client.WX_CUE_MODEL_VERSION);
  });

  it('the server vocabulary is exactly the client CUE_FORM key set', async () => {
    const client = await import('../../src/lib/weatherCue.js');
    expect([...CUES].sort()).toEqual(Object.keys(client.CUE_FORM).sort());
    expect([...FORMS].sort()).toEqual([...new Set(Object.values(client.CUE_FORM))].sort());
  });
});
