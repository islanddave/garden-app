// Unit tests for the weigh-in tray IMPRESSION LOG (V4-READYTRAYIMPRESSION-001) — the POST handler
// in lambda/harvests/ready-impression.js.
//
// Same discipline as watch-impression.test.js: these EXECUTE the handler against a recording
// tagged-template `sql` stub and assert on the parameters actually bound — never a regex over the
// module source. What a stub cannot prove (the unnest expansion, the ON CONFLICT arbiter, the
// household join dropping a foreign planting, the FK) belongs in tests/integration/ once
// migrations/v4-readytrayimpression-001 is applied; it is not written yet because the relation
// exists in no environment.
//
// THE INVARIANT UNDER TEST, and it outranks every other assertion here: this write is a PASSENGER
// on the weigh-in flow. No input, no failure, and no absence of the relation may produce anything
// other than a 202 — because the client cannot see the response and must never be made to care.
import { describe, it, expect, vi } from 'vitest';
import {
  handleReadyImpressionPost, matchReadyImpressionRoute, normalizeReadyImpressions,
  resolveModelVersion, READY_IMPRESSIONS_PATH, READY_MODEL_VERSION, MAX_READY_IMPRESSIONS,
} from './ready-impression.js';

const USER = 'user_dave';
const HOUSEHOLD = ['user_dave', 'user_jen'];
const TZ = 'America/New_York';
const P1 = '11111111-2222-4333-8444-555555555555';
const P2 = '22222222-2222-4333-8444-555555555555';

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

const ctx = (sql, body) => ({ sql, userId: USER, householdIds: HOUSEHOLD, tz: TZ, body });

// Destructure the INSERT's binds by template position:
// SELECT ${userId} .. ${tz} .. ${modelVersion} .. FROM unnest(${plantIds}, ${slots}, ${regions},
// ${sources}, ${ratios}, ${daysSince}, ${intervals}) .. ANY(${householdIds}).
function binds(call) {
  const [userId, tz, modelVersion, plantIds, slots, regions, sources, ratios, daysSince,
    intervals, householdIds] = call.params;
  return { userId, tz, modelVersion, plantIds, slots, regions, sources, ratios, daysSince, intervals, householdIds };
}

const ready = (over = {}) => ({
  plant_id: P1, slot: 1, region: 'tray', source: 'ready',
  overdue_ratio: 1.5, days_since_last_harvest: 6, repeat_interval_days: 4, ...over,
});

describe('matchReadyImpressionRoute', () => {
  it('matches POST on the path and nothing else', () => {
    expect(matchReadyImpressionRoute('POST', READY_IMPRESSIONS_PATH)).toEqual({ kind: 'ready_impression_post' });
    expect(matchReadyImpressionRoute('POST', '/api/harvests')).toBeNull();
    expect(matchReadyImpressionRoute('GET', '/api/harvests/watch')).toBeNull();
  });

  // A wrong verb must 405 here rather than fall through to the read model, which would answer with a
  // message about a different route entirely. Same contract as matchWatchRoute.
  it('answers a wrong verb on its own path with method_not_allowed, not a fall-through', () => {
    expect(matchReadyImpressionRoute('GET', READY_IMPRESSIONS_PATH)).toEqual({ kind: 'method_not_allowed' });
    expect(matchReadyImpressionRoute('DELETE', READY_IMPRESSIONS_PATH)).toEqual({ kind: 'method_not_allowed' });
  });

  it('the path rides the existing /api/harvests prefix (no new Function URL / repo variable)', () => {
    expect(READY_IMPRESSIONS_PATH.startsWith('/api/harvests/')).toBe(true);
  });
});

describe('normalizeReadyImpressions — the client is not trusted', () => {
  it('keeps a well-formed row verbatim', () => {
    expect(normalizeReadyImpressions([ready()])).toEqual([{
      plant_id: P1, slot: 1, region: 'tray', source: 'ready',
      overdue_ratio: 1.5, days_since_last_harvest: 6, repeat_interval_days: 4,
    }]);
  });

  // MUTATION TARGET: drop any vocabulary/shape guard -> red here. Each of these would otherwise
  // reach a CHECK constraint, and the writer inserts the whole tray in ONE statement — so one bad
  // value does not spoil one row, it silently drops the entire session.
  it.each([
    ['a non-uuid plant_id', { plant_id: 'plant-1' }],
    ['an unknown region', { region: 'top5' }],
    ['an unknown source', { source: 'fallback' }],
    ['a zero slot', { slot: 0 }],
    ['a non-numeric slot', { slot: 'first' }],
    ['a ready row with no overdue_ratio', { overdue_ratio: null }],
    ['a ready row with a NaN overdue_ratio', { overdue_ratio: 'lots' }],
  ])('drops %s', (_label, over) => {
    expect(normalizeReadyImpressions([ready(over)])).toEqual([]);
  });

  it('nulls the model snapshot on a recent row instead of laundering it into a model claim', () => {
    const [r] = normalizeReadyImpressions([ready({
      source: 'recent', overdue_ratio: 2.2, days_since_last_harvest: 9, repeat_interval_days: 4,
    })]);
    expect(r.source).toBe('recent');
    expect(r.overdue_ratio).toBeNull();
    expect(r.days_since_last_harvest).toBeNull();
    expect(r.repeat_interval_days).toBeNull();
  });

  // The per-request slice of the natural key. Belt over the ON CONFLICT suspenders, and it is what
  // makes the metric line count what was actually attempted.
  it('dedupes on (plant_id, region) but keeps the same plant in a different region', () => {
    const rows = normalizeReadyImpressions([
      ready(), ready({ slot: 4 }), ready({ region: 'tray_tail', slot: 2 }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.region)).toEqual(['tray', 'tray_tail']);
    expect(rows[0].slot).toBe(1); // the FIRST occurrence wins, not the last
  });

  it('rounds overdue_ratio to the numeric(8,3) scale and rejects an absurd magnitude', () => {
    expect(normalizeReadyImpressions([ready({ overdue_ratio: 1.23456 })])[0].overdue_ratio).toBe(1.235);
    expect(normalizeReadyImpressions([ready({ overdue_ratio: 1e9 })])).toEqual([]);
    expect(normalizeReadyImpressions([ready({ overdue_ratio: -1 })])).toEqual([]);
  });

  it('nulls a smallint that would overflow the column rather than failing the batch', () => {
    const [r] = normalizeReadyImpressions([ready({ days_since_last_harvest: 40000 })]);
    expect(r.days_since_last_harvest).toBeNull();
    expect(r.overdue_ratio).toBe(1.5); // the row itself survives
  });

  it('truncates an over-long payload instead of rejecting it', () => {
    const many = Array.from({ length: MAX_READY_IMPRESSIONS + 10 }, (_, i) => ready({
      plant_id: `${(i % 10)}1111111-2222-4333-8444-55555555555${i % 10}`,
      region: i % 2 ? 'tray' : 'tray_tail', slot: i + 1,
    }));
    expect(normalizeReadyImpressions(many).length).toBeLessThanOrEqual(MAX_READY_IMPRESSIONS);
  });

  it.each([[null], [undefined], ['nope'], [{}], [[null, 3, 'x']]])('survives junk input %s', (v) => {
    expect(normalizeReadyImpressions(v)).toEqual([]);
  });
});

describe('resolveModelVersion — the client owns the model identity, within limits', () => {
  it('takes the client value when it is a sane string', () => {
    expect(resolveModelVersion('ready-v2')).toBe('ready-v2');
  });
  it('falls back to the mirrored constant when absent, empty or oversized', () => {
    expect(resolveModelVersion(undefined)).toBe(READY_MODEL_VERSION);
    expect(resolveModelVersion('')).toBe(READY_MODEL_VERSION);
    expect(resolveModelVersion(42)).toBe(READY_MODEL_VERSION);
    expect(resolveModelVersion('x'.repeat(41))).toBe(READY_MODEL_VERSION);
  });
});

describe('POST /api/harvests/ready-impressions', () => {
  it('writes ONE batch statement carrying every accepted row', async () => {
    const sql = makeSql();
    const res = await handleReadyImpressionPost(ctx(sql, {
      model_version: 'ready-v1',
      impressions: [
        ready(),
        ready({ plant_id: P2, slot: 1, region: 'tray_tail', source: 'recent', overdue_ratio: null,
          days_since_last_harvest: null, repeat_interval_days: null }),
      ],
    }));
    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({ accepted: 2 });

    expect(sql.calls).toHaveLength(1); // ONE statement, never N inserts
    const b = binds(sql.calls[0]);
    expect(sql.calls[0].text).toMatch(/INSERT INTO public\.ready_impression/);
    expect(b.userId).toBe(USER);
    expect(b.householdIds).toEqual(HOUSEHOLD);
    expect(b.modelVersion).toBe('ready-v1');
    expect(b.plantIds).toEqual([P1, P2]);
    expect(b.slots).toEqual([1, 1]);
    expect(b.regions).toEqual(['tray', 'tray_tail']);
    expect(b.sources).toEqual(['ready', 'recent']);
    expect(b.ratios).toEqual([1.5, null]);
    expect(b.daysSince).toEqual([6, null]);
    expect(b.intervals).toEqual([4, null]);
  });

  // THE DAY GRAIN. Stamped from the SERVER's ET clock inside the statement: a phone with a skewed
  // clock, or a session held open across midnight, would otherwise decide which day an impression
  // belongs to. MUTATION TARGET: accept a client-sent shown_on -> red here.
  it('stamps shown_on from the server ET clock and never from the request body', async () => {
    const sql = makeSql();
    await handleReadyImpressionPost(ctx(sql, {
      shown_on: '1999-01-01', impressions: [ready()],
    }));
    const call = sql.calls[0];
    expect(call.text).toMatch(/\(NOW\(\) AT TIME ZONE \?::text\)::date/);
    expect(binds(call).tz).toBe(TZ);
    expect(call.params).not.toContain('1999-01-01');
  });

  // Neon missing-cast class: the driver cannot type a NULL bind (or any bind in a bare SELECT list),
  // and inside this handler's try/catch that presents as the log silently never populating.
  // MUTATION TARGET: drop any ::cast -> red here.
  it('every bind carries an explicit ::cast, and the dedupe target is the natural key', async () => {
    const sql = makeSql();
    await handleReadyImpressionPost(ctx(sql, { impressions: [ready()] }));
    const q = sql.calls[0].text;
    expect(q).toMatch(/\?::text,/);           // user_id
    expect(q).toMatch(/\?::uuid\[\]/);        // plant_ids
    expect(q).toMatch(/\?::smallint\[\]/);    // slots / days_since / intervals (nullable elements)
    expect(q).toMatch(/\?::text\[\]/);        // regions / sources
    expect(q).toMatch(/\?::numeric\[\]/);     // overdue_ratios (nullable elements)
    expect(q).toMatch(/ON CONFLICT \(user_id, plant_id, shown_on, region\) DO NOTHING/);
  });

  // The join is the AUTHORIZATION (plant_ids are caller-supplied here, unlike the watch path) and
  // simultaneously the FK guard that turns a bogus id from a whole-batch failure into a per-row
  // no-op. MUTATION TARGET: delete either arm of the COALESCE -> the 4 live projectless plantings on
  // prod silently stop being recorded, with no error anywhere.
  it('scopes every row to the caller household, with the projectless-planting arm intact', async () => {
    const sql = makeSql();
    await handleReadyImpressionPost(ctx(sql, { impressions: [ready()] }));
    const q = sql.calls[0].text;
    expect(q).toMatch(/JOIN public\.plants p ON p\.id = u\.plant_id AND p\.deleted_at IS NULL/);
    expect(q).toMatch(/LEFT JOIN public\.plant_projects pj ON pj\.id = p\.project_id/);
    expect(q).toMatch(/COALESCE\(pj\.created_by, p\.created_by\) = ANY\(\?::text\[\]\)/);
  });

  // THE NON-FATALITY INVARIANT — the exact shape of the migration-lands-late window.
  // MUTATION TARGET: remove the try/catch, or return a 5xx -> red here.
  it('a failing insert logs a warning and STILL answers 202', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sql = makeSqlFails('relation "public.ready_impression" does not exist');
      const res = await handleReadyImpressionPost(ctx(sql, { impressions: [ready()] }));
      expect(res.statusCode).toBe(202);
      expect(res.body).toEqual({ accepted: 0 });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/harvest flow unaffected/);
      expect(warn.mock.calls[0][0]).toMatch(/does not exist/);
    } finally {
      warn.mockRestore();
    }
  });

  it('issues ZERO statements and still answers 202 when nothing survives validation', async () => {
    const sql = makeSql();
    for (const body of [{}, { impressions: [] }, { impressions: [{ plant_id: 'nope' }] }]) {
      const res = await handleReadyImpressionPost(ctx(sql, body));
      expect(res.statusCode).toBe(202);
      expect(res.body).toEqual({ accepted: 0 });
    }
    expect(sql.calls).toHaveLength(0);
  });

  it('emits the named metric line so an all-conflict day is still visible in CloudWatch', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const sql = makeSql();
      await handleReadyImpressionPost(ctx(sql, {
        impressions: [ready(), ready({ plant_id: P2, region: 'tray_tail', source: 'recent',
          overdue_ratio: null, days_since_last_harvest: null, repeat_interval_days: null })],
      }));
      const line = JSON.parse(log.mock.calls[0][0]);
      expect(line).toMatchObject({
        metric: 'ready_impressions', model_version: READY_MODEL_VERSION,
        tray: 1, tray_tail: 1, ready: 1, recent: 1,
      });
    } finally {
      log.mockRestore();
    }
  });
});

// ── Mirrored model constant — lockstep pin ───────────────────────────────────────────────────────
// The Lambda restates the CLIENT's model version as its fallback for a request that omits one (the
// module graphs can't share a constant). If either side moves alone, an impression written without
// a client version would be stamped with a generation that never produced it.
describe('the mirrored model version stays in lockstep with src/lib/harvestReadiness.js', () => {
  it('READY_MODEL_VERSION === the client constant', async () => {
    const client = await import('../../src/lib/harvestReadiness.js');
    expect(READY_MODEL_VERSION).toBe(client.READY_MODEL_VERSION);
  });
});
