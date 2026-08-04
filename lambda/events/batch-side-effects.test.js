// BUG-BATCHSIDEEFFECTS-001 — behavioural tests for the batch write path's reward side effects.
//
// These are NOT static-source assertions (the house pattern for SQL shape, see batch-order.test.js).
// The defect class here is behavioural — "how many XP grants does a 200-row batch produce" and
// "what does a retry do to user_stats" cannot be answered by regexing the source — so this file
// drives the real function against a recording mock of the neon sql tag.
//
// What it pins, in priority order:
//   1. the reward GRAIN: one flat-XP grant per batch, never per event
//   2. IDEMPOTENCY: nothing here increments; a retry is a no-op
//   3. O(1): round trips do not scale with batch size
//   4. NON-FATAL: a failing effect never propagates out of the function

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyBatchSideEffects } from './batchSideEffects.js';

const BATCH_ID = '11111111-1111-4111-8111-111111111111';
const USER = 'user_test';
const TZ = 'America/New_York';

// Recording mock of the neon tagged-template `sql`. Matches on the interpolated query text and
// returns canned rows; every call is retained for assertion.
function makeSql(overrides = {}) {
  const calls = [];
  const sql = (strings, ...params) => {
    const text = strings.raw.join(' ? ');
    calls.push({ text, params });
    for (const [needle, rows] of Object.entries(overrides)) {
      if (text.includes(needle)) {
        if (typeof rows === 'function') return rows(params);
        return Promise.resolve(rows);
      }
    }
    return Promise.resolve([]);
  };
  sql.calls = calls;
  sql.matching = (needle) => calls.filter((c) => c.text.includes(needle));
  return sql;
}

const DEFAULTS = {
  live_events: [{ today: '2026-08-04', live_events: 11993, days: ['2026-08-04', '2026-08-03'] }],
  'INSERT INTO user_stats': [{ current_streak: 37, total_events: 11993 }],
  'AS newly_earned': [{ newly_earned: [] }],
  'AS today_total': [{ granted: 10, today_total: 120 }],
};

function makeEvents(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `evt-${String(i).padStart(4, '0')}`,
    plant_id: `plant-${i}`,
    created_at: '2026-08-04T12:00:00Z',
    metadata: { batch_id: BATCH_ID, batch_v: 1 },
  }));
}

function run(sql, events, extra = {}) {
  return applyBatchSideEffects({
    sql,
    userId: USER,
    userTz: TZ,
    batchId: BATCH_ID,
    eventType: 'watering',
    events,
    itemCount: events.length,
    tzOffsetMin: 0,
    dailyXpCap: 300,
    flatXpPerAction: 10,
    ...extra,
  });
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('reward grain — one logging action, one award', () => {
  it('a 200-planting batch produces exactly ONE event_logged XP grant', async () => {
    const sql = makeSql(DEFAULTS);
    await run(sql, makeEvents(200));
    const grants = sql.matching('AS today_total').filter((c) => c.text.includes('INSERT INTO xp_events'));
    expect(grants).toHaveLength(1);
  });

  it('a 1-planting batch produces the same single grant — grain is the action, not the row', async () => {
    const sql = makeSql(DEFAULTS);
    await run(sql, makeEvents(1));
    const grants = sql.matching('AS today_total').filter((c) => c.text.includes('INSERT INTO xp_events'));
    expect(grants).toHaveLength(1);
  });

  it('the XP grant is keyed on the BATCH id, not an event id — that is what makes a retry a no-op', async () => {
    const sql = makeSql(DEFAULTS);
    await run(sql, makeEvents(50));
    // NB: select the FLAT grant specifically. The achievement CTE also inserts into xp_events, and
    // an index-0 pick silently tested the wrong statement.
    const grant = sql.matching('AS today_total')[0];
    expect(grant.params).toContain(BATCH_ID);
    expect(grant.params.some((p) => String(p).startsWith('evt-'))).toBe(false);
  });

  it('the XP grant carries ON CONFLICT DO NOTHING against the 0c unique index', async () => {
    const sql = makeSql(DEFAULTS);
    await run(sql, makeEvents(3));
    const grant = sql.matching('AS today_total')[0];
    expect(grant.text).toMatch(/INSERT INTO xp_events/);
    expect(grant.text).toMatch(/ON CONFLICT \(user_id, reason, source_id\) WHERE source_id IS NOT NULL DO NOTHING/);
  });

  it('emits exactly one log_entry_created telemetry row for the whole batch', async () => {
    const sql = makeSql(DEFAULTS);
    await run(sql, makeEvents(157));
    const tel = sql.matching('INSERT INTO app_events');
    expect(tel).toHaveLength(1);
    expect(tel[0].params).toContain('log_entry_created');
  });

  it('adds a daily_xp_capped telemetry row only when the grant was actually suppressed', async () => {
    const capped = makeSql({ ...DEFAULTS, 'AS today_total': [{ granted: 0, today_total: 300 }] });
    await run(capped, makeEvents(4));
    const names = capped.matching('INSERT INTO app_events').flatMap((c) => c.params);
    expect(names).toContain('daily_xp_capped');

    const notCapped = makeSql(DEFAULTS);
    await run(notCapped, makeEvents(4));
    const names2 = notCapped.matching('INSERT INTO app_events').flatMap((c) => c.params);
    expect(names2).not.toContain('daily_xp_capped');
  });
});

describe('idempotency — a retry must not double-count', () => {
  it('user_stats.total_events is written as an ABSOLUTE recomputed value, never incremented', async () => {
    const sql = makeSql(DEFAULTS);
    await run(sql, makeEvents(10));
    const upsert = sql.matching('INSERT INTO user_stats')[0];
    // The blind `+ 1` is the exact mechanism that left total_events at 2,003 against 11,993 real
    // rows. Its absence here is the fix; assert on the absence, not just on the presence.
    expect(upsert.text).not.toMatch(/total_events\s*=\s*user_stats\.total_events\s*\+/);
    expect(upsert.params).toContain(11993);
  });

  it('the streak/count read recomputes from event_log rather than trusting stored state', async () => {
    const sql = makeSql(DEFAULTS);
    await run(sql, makeEvents(2));
    const read = sql.matching('live_events')[0];
    expect(read.text).toMatch(/count\(\*\)::int FROM event_log/);
    expect(read.text).toMatch(/SELECT DISTINCT/);
  });

  it('telemetry is guarded by NOT EXISTS on batch_id so a re-hit cannot duplicate it', async () => {
    const sql = makeSql(DEFAULTS);
    await run(sql, makeEvents(2));
    const tel = sql.matching('INSERT INTO app_events')[0];
    expect(tel.text).toMatch(/WHERE NOT EXISTS/);
    expect(tel.text).toMatch(/a\.metadata->>'batch_id'/);
  });

  it('achievement grants stay ON CONFLICT DO NOTHING on both the badge and its XP', async () => {
    const sql = makeSql(DEFAULTS);
    await run(sql, makeEvents(2));
    const ach = sql.matching('user_achievements')[0];
    expect(ach.text).toMatch(/ON CONFLICT \(user_id, achievement_id\) DO NOTHING/);
    expect(ach.text).toMatch(/ON CONFLICT \(user_id, reason, source_id\) WHERE source_id IS NOT NULL DO NOTHING/);
  });

  it('attributes batch-level effects to a DETERMINISTIC anchor event so retries agree', async () => {
    const shuffled = [...makeEvents(5)].reverse();
    const a = makeSql(DEFAULTS);
    await run(a, shuffled);
    const b = makeSql(DEFAULTS);
    await run(b, makeEvents(5));
    const anchorOf = (sql) => sql.matching('user_achievements')[0].params.find((p) => String(p).startsWith('evt-'));
    expect(anchorOf(a)).toBe('evt-0000');
    expect(anchorOf(a)).toBe(anchorOf(b));
  });
});

describe('performance characteristics of the batch path are preserved', () => {
  it('round trips are O(1) in batch size — 1 planting and 500 plantings cost the same', async () => {
    const small = makeSql(DEFAULTS);
    await run(small, makeEvents(1));
    const large = makeSql(DEFAULTS);
    await run(large, makeEvents(500));
    // The batch endpoint exists because logging many plantings at once is a real workflow. A
    // per-event reward model would have made this O(N) INSERTs.
    expect(large.calls.length).toBe(small.calls.length);
  });
});

describe('non-fatal posture — reward accounting never breaks the user save', () => {
  it('a throwing side effect is swallowed and the function still returns', async () => {
    const sql = (strings, ...params) => {
      const text = strings.raw.join(' ? ');
      if (text.includes('INSERT INTO xp_events') && text.includes("'event_logged'")) {
        return Promise.reject(new Error('boom'));
      }
      if (text.includes('live_events')) return Promise.resolve(DEFAULTS.live_events);
      if (text.includes('INSERT INTO user_stats')) return Promise.resolve(DEFAULTS['INSERT INTO user_stats']);
      return Promise.resolve([]);
    };
    const out = await run(sql, makeEvents(3));
    expect(out.xp_gained).toBe(0);
    expect(out.updated_streak).toBe(37);
  });

  it('returns the same reward keys the single-event POST returns', async () => {
    const sql = makeSql(DEFAULTS);
    const out = await run(sql, makeEvents(3));
    // BUG-XPPROGRESSION-001 added level + leveled_up to BOTH paths' contracts. The whole point of
    // this assertion is that the two paths stay in step, so it is widened rather than relaxed —
    // index.js's resp(201, …) must carry these same two keys.
    expect(Object.keys(out).sort()).toEqual(
      ['daily_xp_remaining', 'level', 'leveled_up', 'newly_earned_achievements',
        'total_events', 'updated_streak', 'xp_gained'].sort(),
    );
    expect(out.xp_gained).toBe(10);
    expect(out.daily_xp_remaining).toBe(180);
  });
});

// ── BUG-XPPROGRESSION-001 — level progression on the batch path ────────────────────────────────
// Behavioural, not static-source, for the same reason as the rest of this file: "does a retry
// re-announce a level-up" and "is the level the evaluator sees the pre- or post-grant one" cannot
// be answered by regexing SQL.
//
// The recording mock returns whatever `level` the canned rows carry — i.e. it stands in for
// trg_user_stats_level. That is deliberate and it is the correct seam: the trigger's own maths is
// proved against real Postgres in migrations/v4-xpprogression-001/gates.yml (every boundary,
// levels 1-200) and in tests/integration/xp-level.int.test.js. What THIS file must prove is the
// wiring — that the Lambda reads the level rather than computing one, in the right order, and
// reports it honestly.
describe('level progression (BUG-XPPROGRESSION-001)', () => {
  // Step 2's upsert returns the level BEFORE this batch's grants; Step 3's flat grant returns the
  // level AFTER them. Distinct values so a test cannot pass by reading the wrong one.
  const LEVELLING = {
    ...DEFAULTS,
    'INSERT INTO user_stats': [{ current_streak: 37, total_events: 11993, level: 6 }],
    'AS today_total': [{ granted: 10, today_total: 120, level_after_flat: 7 }],
  };

  it('reports the post-grant level, not the level the batch started at', async () => {
    const sql = makeSql(LEVELLING);
    const out = await run(sql, makeEvents(3));
    expect(out.level).toBe(7);
    expect(out.leveled_up).toBe(true);
  });

  it('does NOT claim a level-up when the batch did not cross a boundary', async () => {
    const sql = makeSql({
      ...DEFAULTS,
      'INSERT INTO user_stats': [{ current_streak: 37, total_events: 11993, level: 7 }],
      'AS today_total': [{ granted: 10, today_total: 120, level_after_flat: 7 }],
    });
    const out = await run(sql, makeEvents(3));
    expect(out.level).toBe(7);
    expect(out.leveled_up).toBe(false);
  });

  it('IDEMPOTENT: a retry (both grants no-op, level already final) does not re-announce', async () => {
    // On an idempotency re-hit the ON CONFLICT DO NOTHING grants award nothing, so Step 2 and
    // Step 3 both read the SAME already-final level. leveled_up must be false — otherwise every
    // retry of a level-crossing batch would re-fire the celebration.
    const sql = makeSql({
      ...DEFAULTS,
      'INSERT INTO user_stats': [{ current_streak: 37, total_events: 11993, level: 7 }],
      'AS today_total': [{ granted: 0, today_total: 300, level_after_flat: 7 }],
    });
    const out = await run(sql, makeEvents(157));
    expect(out.level).toBe(7);
    expect(out.leveled_up).toBe(false);
    expect(out.xp_gained).toBe(0);
  });

  it('the achievement evaluator receives the POST-flat-grant level, not the pre-grant one', async () => {
    // THE ORDERING GUARANTEE. If the evaluator ran before the flat grant (the pre-fix order) the
    // interpolated level would be 6 and a {"level": 7} achievement would fire one action late.
    const sql = makeSql(LEVELLING);
    await run(sql, makeEvents(3));
    const evalCall = sql.matching('AS newly_earned')[0];
    expect(evalCall).toBeDefined();
    expect(evalCall.params).toContain(7);
    expect(evalCall.params).not.toContain(6);
  });

  it('the flat XP grant is issued BEFORE the achievement evaluation', async () => {
    const sql = makeSql(LEVELLING);
    await run(sql, makeEvents(3));
    const order = sql.calls.map((c) => c.text);
    const flatIdx = order.findIndex((t) => t.includes('AS today_total'));
    const achIdx  = order.findIndex((t) => t.includes('AS newly_earned'));
    expect(flatIdx).toBeGreaterThan(-1);
    expect(achIdx).toBeGreaterThan(-1);
    expect(flatIdx).toBeLessThan(achIdx);
  });

  it('carries a WHEN level branch so level_5 / level_9 can be candidates at all', async () => {
    const sql = makeSql(LEVELLING);
    await run(sql, makeEvents(3));
    const evalCall = sql.matching('AS newly_earned')[0];
    expect(evalCall.text).toContain("WHEN 'level'");
    expect(evalCall.text).toContain("(a.trigger_value->>'level')::int");
  });

  it('NEVER computes a level: no curve arithmetic reaches the DB from this file', async () => {
    // The curve lives in public.xp_level(). If this file ever grows its own copy, the level would
    // drift from the trigger's the moment either changed — the drift class this ticket closes.
    const sql = makeSql(LEVELLING);
    await run(sql, makeEvents(3));
    for (const c of sql.calls) {
      expect(c.text).not.toMatch(/sqrt\s*\(/i);
      expect(c.text).not.toMatch(/SET\s+level\s*=/i);
    }
  });

  it('degrades to level: null (not 0, not 1) when the user_stats upsert throws', async () => {
    const sql = (strings, ...params) => {
      const text = strings.raw.join(' ? ');
      if (text.includes('INSERT INTO user_stats')) return Promise.reject(new Error('boom'));
      if (text.includes('live_events')) return Promise.resolve(DEFAULTS.live_events);
      return Promise.resolve([]);
    };
    const out = await applyBatchSideEffects({
      sql, userId: USER, userTz: TZ, batchId: BATCH_ID, eventType: 'watering',
      events: makeEvents(3), itemCount: 3, tzOffsetMin: 0, dailyXpCap: 300, flatXpPerAction: 10,
    });
    // A level of 0 or 1 here would be a lie the UI would render as a demotion.
    expect(out.level).toBeNull();
    expect(out.leveled_up).toBe(false);
  });
});
