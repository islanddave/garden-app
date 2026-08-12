// V4-WATERMATH-001 F0 — `moisture_check` as a first-class event type, and the zero-reward rule.
//
// WHY THE ZERO-REWARD RULE IS LOAD-BEARING: moisture_check is a one-tap "not thirsty" snooze that
// sits next to the primary log button. If it granted XP it would be a farmable dopamine lever —
// tap it across 200 plantings, cap the daily XP, sustain a streak without gardening — and it would
// poison the V1.1 watering learner with events that mean "I did nothing".
//
// WHERE THE RULE HAS TO LIVE (verified against LIVE NEON 2026-08-12, not against app code):
//   SELECT tgname, proname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid ... WHERE NOT tgisinternal
//   event_log  -> prevent_ownership_transfer, set_updated_at    <- NEITHER touches any reward table
//   user_stats -> trg_user_stats_level = `NEW.level := public.xp_level(NEW.xp)`
// There is NO database trigger that grants xp, streak or total_events. Every grant is application
// code in this Lambda, so the exclusion is enforced here — and it is enforced in THREE places,
// because two of them are recomputes that would otherwise re-grant retroactively:
//   (1) the flat XP grant                  — gated off outright;
//   (2) user_stats.total_events + streak    — recomputed as count(*) over event_log, so an
//                                             unfiltered recompute absorbs moisture_check rows on
//                                             the NEXT event the user logs;
//   (3) the achievement evaluator's counts  — today_events feeds multi_per_day.
//
// End-to-end proof against a real database (a moisture_check POST granting literally zero rows in
// xp_events, and total_events not moving) lives in tests/integration/watermath-f0.int.test.js.
// This file pins the vocabulary invariants and the batch-path recompute, which execute DB-free.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyBatchSideEffects } from './batchSideEffects.js';
import {
  EVENT_TYPES,
  EVENT_TYPE_META,
  REQUIRED_META_FIELDS,
  BATCH_EXCLUDED_TYPES,
  BATCH_EVENT_TYPES,
  NON_REWARD_EVENT_TYPES,
  isRewardedEventType,
  PLANTING_REQUIRED_TYPES,
} from '../../src/lib/eventTypes.js';
import * as generated from './eventTypes.generated.js';
import { validateBatchBody, validatePostBody } from './validators.js';

describe('moisture_check joins the canonical vocabulary', () => {
  it('is a real event type', () => {
    expect(EVENT_TYPES).toContain('moisture_check');
  });

  it('carries complete display metadata (the META completeness contract)', () => {
    const meta = EVENT_TYPE_META.moisture_check;
    expect(meta).toBeTruthy();
    for (const f of REQUIRED_META_FIELDS) {
      expect(meta[f], `missing ${f}`).toBeTruthy();
    }
    // A raw snake_case label means the picker fell through to the fallback resolver.
    expect(meta.label).not.toMatch(/_/);
  });

  it('is NOT an alias of `observation` — that mapping falsely checks off PEST tasks', () => {
    // The daily-plan DONE_EVENTS map treats an `observation` as satisfying PEST work. Reusing
    // `observation` for "I felt the soil" would silently mark pest tasks done that nobody did.
    // Its own value in its own row is what keeps the two signals separable.
    expect(EVENT_TYPES.filter((t) => t === 'moisture_check')).toHaveLength(1);
    expect(EVENT_TYPE_META.moisture_check).not.toBe(EVENT_TYPE_META.observation);
    expect(EVENT_TYPE_META.moisture_check.label).not.toMatch(/observ/i);
  });

  it('predicates on a specific planting', () => {
    // "The soil is still damp" is a claim about ONE pot. A space-level target would be a
    // fabricated observation covering plantings the user never touched.
    expect(PLANTING_REQUIRED_TYPES.has('moisture_check')).toBe(true);
  });

  it('is accepted by the single-event POST validator', () => {
    expect(validatePostBody({ event_type: 'moisture_check', plant_id: 'p1' })).toBeNull();
  });
});

describe('moisture_check is excluded from the batch path', () => {
  it('is in BATCH_EXCLUDED_TYPES and therefore absent from the derived allowlist', () => {
    expect(BATCH_EXCLUDED_TYPES).toContain('moisture_check');
    expect(BATCH_EVENT_TYPES).not.toContain('moisture_check');
  });

  it('the batch validator REJECTS it — one tap must not suppress the whole water bar', () => {
    const r = validateBatchBody({
      idempotency_key: 'k', event_type: 'moisture_check', scope: { type: 'all' },
    });
    expect(r?.status).toBe(400);
    expect(r.error).toMatch(/event_type must be one of/);
  });

  it('the derived allowlist is still DERIVED, not hand-listed (drift guard)', () => {
    expect(BATCH_EVENT_TYPES).toEqual(EVENT_TYPES.filter((t) => !BATCH_EXCLUDED_TYPES.includes(t)));
  });
});

describe('the codegen bridge carries the new contract into the Lambda', () => {
  // The deployed events Lambda is a standalone zip with no bundler: it CANNOT import src/lib/.
  // If codegen drops any of these, the Lambda silently reverts to the old vocabulary at runtime
  // while every src/-side test stays green.
  it('generated EVENT_TYPES / BATCH_EVENT_TYPES match the canonical source byte-for-byte', () => {
    expect(generated.EVENT_TYPES).toEqual(EVENT_TYPES);
    expect(generated.BATCH_EVENT_TYPES).toEqual(BATCH_EVENT_TYPES);
    expect(generated.BATCH_EXCLUDED_TYPES).toEqual(BATCH_EXCLUDED_TYPES);
  });

  it('generated NON_REWARD_EVENT_TYPES matches, and the predicate agrees with the list', () => {
    expect(generated.NON_REWARD_EVENT_TYPES).toEqual(NON_REWARD_EVENT_TYPES);
    expect(generated.isRewardedEventType('moisture_check')).toBe(false);
    expect(generated.isRewardedEventType('watering')).toBe(true);
  });
});

describe('the reward partition', () => {
  it('moisture_check is non-rewarded; ordinary logging types are rewarded', () => {
    expect(NON_REWARD_EVENT_TYPES).toContain('moisture_check');
    expect(isRewardedEventType('moisture_check')).toBe(false);
    for (const t of ['watering', 'rain', 'harvest', 'observation', 'fertilizing']) {
      expect(isRewardedEventType(t), t).toBe(true);
    }
  });

  it('unknown / free-text types default to REWARDED — exclusion is opt-in, never inferred', () => {
    // The single-event POST accepts free text. Defaulting those to non-rewarded would silently
    // stop paying XP for real logging the moment anyone typed a custom type.
    expect(isRewardedEventType('some_custom_type')).toBe(true);
    expect(isRewardedEventType(undefined)).toBe(true);
  });

  it('every non-rewarded type is also barred from batch — no bulk farming route', () => {
    for (const t of NON_REWARD_EVENT_TYPES) {
      expect(BATCH_EVENT_TYPES, t).not.toContain(t);
    }
  });
});

// ── Batch recompute: executed, not regexed ──────────────────────────────────────────────────────
// applyBatchSideEffects is importable and runnable, so this drives the REAL function against a
// recording mock of the neon `sql` tag and asserts on the parameters it actually binds.
const BATCH_ID = '11111111-1111-4111-8111-111111111111';

function makeSql() {
  const calls = [];
  const sql = (strings, ...params) => {
    const text = strings.raw.join(' ? ');
    calls.push({ text, params });
    if (text.includes('live_events')) {
      return Promise.resolve([{ today: '2026-08-12', live_events: 11993, days: ['2026-08-12'] }]);
    }
    if (text.includes('INSERT INTO user_stats')) {
      return Promise.resolve([{ current_streak: 37, total_events: 11993, level: 6 }]);
    }
    if (text.includes('AS today_total')) return Promise.resolve([{ granted: 10, today_total: 120 }]);
    if (text.includes('AS newly_earned')) return Promise.resolve([{ newly_earned: [] }]);
    return Promise.resolve([]);
  };
  sql.calls = calls;
  sql.matching = (needle) => calls.filter((c) => c.text.includes(needle));
  return sql;
}

describe('batch side effects — the reward recompute excludes non-reward types', () => {
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

  const run = (sql) => applyBatchSideEffects({
    sql,
    userId: 'user_test',
    userTz: 'America/New_York',
    batchId: BATCH_ID,
    eventType: 'watering',
    events: [{ id: 'e1', plant_id: 'p1', created_at: '2026-08-12T12:00:00Z', metadata: {} }],
    itemCount: 1,
    tzOffsetMin: 0,
    dailyXpCap: 300,
    flatXpPerAction: 10,
  });

  it('binds the non-reward list into the total_events / activity-days recompute', async () => {
    // This is NOT redundant with the grant being skipped. total_events and the streak are
    // recomputed over the user's WHOLE history on every logging action — so without this filter a
    // moisture_check logged on the single path gets absorbed into total_events by the next batch,
    // and the two write paths disagree about the same number.
    const sql = makeSql();
    await run(sql);
    const [recompute] = sql.matching('live_events');
    expect(recompute).toBeTruthy();
    expect(recompute.params).toContainEqual(NON_REWARD_EVENT_TYPES);
    // Bound twice: once for the count, once for the activity-day list.
    expect(recompute.params.filter((p) => Array.isArray(p) && p.includes('moisture_check')))
      .toHaveLength(2);
  });

  it('binds it into the achievement evaluator counts too (multi_per_day)', async () => {
    const sql = makeSql();
    await run(sql);
    const [ach] = sql.matching('AS newly_earned');
    expect(ach).toBeTruthy();
    expect(ach.params).toContainEqual(NON_REWARD_EVENT_TYPES);
  });

  it('still grants normally for a rewarded batch type — the gate did not break the happy path', async () => {
    const sql = makeSql();
    const out = await run(sql);
    expect(sql.matching('AS today_total')).toHaveLength(1);
    expect(out.xp_gained).toBeGreaterThan(0);
  });
});
