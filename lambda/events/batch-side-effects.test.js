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
    expect(Object.keys(out).sort()).toEqual(
      ['daily_xp_remaining', 'newly_earned_achievements', 'total_events', 'updated_streak', 'xp_gained'].sort(),
    );
    expect(out.xp_gained).toBe(10);
    expect(out.daily_xp_remaining).toBe(180);
  });
});
