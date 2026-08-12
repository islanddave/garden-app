// V4-WATERMATH-001 F0 — the dashboard is the THIRD reader of the reward partition.
//
// The events Lambda filters NON_REWARD_EVENT_TYPES out of its grant path, both of its recomputes and
// its achievement counts. handlers.queryActivityDays is a separate reader that no lane had touched,
// and it is the one the user actually SEES: handleDashboard discards the stored streak and overwrites
// it with computeStreak() over whatever this query returns. Unfiltered, a daily "I checked the soil"
// tap would sustain a streak forever — a rewarded farmable loop.
//
// ON WHAT THESE TESTS CAN AND CANNOT PROVE. The predicate itself executes in Postgres, so no DB-free
// test can prove the SQL filters correctly — that belongs to the CI integration job. What is provable
// here, and what is asserted below, is (a) the real parameter binding the driver would send, (b) that
// the local constant matches the canonical one, and (c) the actual JS-side consequence via the same
// computeStreak the handler calls. Deliberately NOT a regex over the query text: this suite has a lot
// of source-text assertions that pass without executing anything, and one more would prove nothing
// about behaviour.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { queryActivityDays, handleDashboard } from './handlers.js';
import { NON_REWARD_EVENT_TYPES, isRewardedEventType } from './eventTypes.rewards.js';
import { computeStreak, STREAK_GRACE_DAYS } from './streak.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');

// Mock sql tagged-template, same shape as index.test.js: records the values the driver would bind.
const sqlCalls = [];
function makeSql(results = []) {
  const queue = [...results];
  return function sqlTag(strings, ...values) {
    let resolved = '';
    strings.forEach((s, i) => { resolved += s; if (i < values.length) resolved += `$${i + 1}`; });
    sqlCalls.push({ resolved, values });
    return Promise.resolve(queue.length ? queue.shift() : []);
  };
}
beforeEach(() => { sqlCalls.length = 0; });

describe('queryActivityDays binds the reward partition', () => {
  it('sends the non-reward list as a real bound parameter', () => {
    queryActivityDays(makeSql(), 'user_alpha');
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0].values).toContainEqual(NON_REWARD_EVENT_TYPES);
  });

  it('binds it exactly once — the activity-day subquery, not the `today` clock reading', () => {
    // `today` is NOW() in the user's timezone; it aggregates no events, so a predicate there would be
    // meaningless. Two binds would mean someone applied a blanket filter without reading the query.
    queryActivityDays(makeSql(), 'user_alpha');
    const arrayBinds = sqlCalls[0].values.filter(
      (v) => Array.isArray(v) && v.includes('moisture_check'),
    );
    expect(arrayBinds).toHaveLength(1);
  });

  it('still binds the user id — the filter did not displace the ownership scope', () => {
    queryActivityDays(makeSql(), 'user_alpha');
    expect(sqlCalls[0].values).toContain('user_alpha');
  });

  it('carries through the composed dashboard handler, not just the builder in isolation', async () => {
    // handleDashboard fires eleven tile queries via allSettled; the tenth is activity_days. Asserting
    // through the composition catches a future refactor that swaps in an unfiltered inline query.
    // Same result queue shape index.test.js uses for the composed handler: the assembly indexes into
    // counts[0] / favCount[0] / inactiveCountRows[0], so those three need real rows.
    const sql = makeSql([
      [],                                                          // recentEvents
      [{ project_count: 0, plant_count: 0, location_count: 0 }],   // counts
      [{ count: 0 }],                                              // favCount
      [], [], [], [], [],                                          // active, stats, water, harvest, heads
      [{ count: 0 }],                                              // inactiveCount
      [{ today: '2026-08-12', days: [] }],                         // activityDays
      [],                                                          // giveAttention
    ]);
    await handleDashboard(sql, 'user_alpha');
    const activityDayCalls = sqlCalls.filter(
      (c) => c.values.some((v) => Array.isArray(v) && v.includes('moisture_check')),
    );
    expect(activityDayCalls).toHaveLength(1);
  });
});

describe('the behavioural consequence — what the filter is worth', () => {
  // The real payoff, computed with the SAME helper the handler uses. If the SQL predicate is dropped,
  // moisture_check days rejoin `days` and the streak below becomes the unbroken one.
  const today = '2026-08-12';
  const realActivity = ['2026-08-12', '2026-08-11'];                    // watered two days running
  const moistureOnlyDays = ['2026-08-10', '2026-08-09', '2026-08-08'];  // three taps, nothing logged

  it('a gap papered over by moisture_check taps still breaks the streak', () => {
    const filtered = computeStreak(realActivity, today, STREAK_GRACE_DAYS);
    const unfiltered = computeStreak(
      [...realActivity, ...moistureOnlyDays].sort().reverse(), today, STREAK_GRACE_DAYS,
    );
    expect(filtered.current).toBe(2);
    expect(unfiltered.current).toBe(5);
    // The gap is the defect: 5 is a streak the user did not earn.
    expect(unfiltered.current).toBeGreaterThan(filtered.current);
  });

  it('isRewardedEventType agrees with the list, and ordinary care is still rewarded', () => {
    expect(isRewardedEventType('moisture_check')).toBe(false);
    for (const t of ['watering', 'fertilizing', 'observation', 'harvest']) {
      expect(isRewardedEventType(t)).toBe(true);
    }
    for (const t of NON_REWARD_EVENT_TYPES) expect(isRewardedEventType(t)).toBe(false);
  });
});

describe('drift guard — the copy cannot silently diverge from the canonical list', () => {
  // This directory holds a COPY because the deploy zips each Lambda alone (L-089), the same reason
  // streak.js is duplicated. The guard turns strict the moment the canonical constant exists.
  const CANON = join(repoRoot, 'src', 'lib', 'eventTypes.js');

  it('matches src/lib/eventTypes.js once that module exports the partition', async () => {
    expect(existsSync(CANON)).toBe(true);
    const canon = await import('file://' + CANON);

    if (canon.NON_REWARD_EVENT_TYPES === undefined) {
      // PRE-MERGE STATE, asserted rather than skipped. The canonical constant lands with the
      // V4-WATERMATH-001 F0 events work; until then the contract is pinned to the value that work
      // defines, so this copy is already correct when the two branches meet.
      expect(NON_REWARD_EVENT_TYPES).toEqual(['moisture_check']);
      return;
    }
    expect(NON_REWARD_EVENT_TYPES).toEqual(canon.NON_REWARD_EVENT_TYPES);
  });

  it('is never empty — an emptied list would make the filter vacuous and green', () => {
    // The failure mode this exists for: someone "cleans up" the constant, every test that asserts a
    // binding still passes because an empty array still binds, and the farmable loop comes back.
    expect(NON_REWARD_EVENT_TYPES.length).toBeGreaterThan(0);
    expect(NON_REWARD_EVENT_TYPES).toContain('moisture_check');
  });

  it('stays in the codegen follow-up: the generator does not yet emit this directory', () => {
    // Documents the known gap so it is discoverable rather than folklore. When
    // scripts/gen-lambda-event-types.mjs learns to emit lambda/dashboard/, this file should be
    // replaced by the generated artifact and this test deleted with it.
    const gen = readFileSync(join(repoRoot, 'scripts', 'gen-lambda-event-types.mjs'), 'utf8');
    expect(gen.includes("'dashboard'")).toBe(false);
  });
});
