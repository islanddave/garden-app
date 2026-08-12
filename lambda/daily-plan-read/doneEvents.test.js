// V3-TODAYDONE-001 / V4-WATERMATH-001 F0 — the read-time check-off fold, EXECUTED.
//
// Every other guard on this Lambda is source-text (index.js imports @neondatabase/serverless +
// @clerk/backend + @aws-sdk/*, and ci.yml runs one root `npm ci` with no per-Lambda install, so
// nothing can import it). doneEvents.js is dependency-free precisely so the logic that decides
// whether a plan item is done runs for real here rather than being regex-asserted.
import { describe, it, expect } from 'vitest';
import { DONE_EVENTS, applyDone, planItemIds } from './doneEvents.js';

const sat = (...pairs) => new Set(pairs);
const plan = (overrides = {}) => ({
  generated_at: '2026-08-12T06:00:00Z',
  water_due:  [{ id: 'p1', name: 'Habanero' }],
  no_history: [{ id: 'p2', name: 'Sage' }],
  pest:       [{ id: 'p3', name: 'Basil' }],
  fertilize:  [{ id: 'p4', name: 'Dill' }],
  cold:       [{ id: 'p5', name: 'Fittonia' }],
  ...overrides,
});

describe('V4-WATERMATH-001 F0 — moisture_check checks off Water', () => {
  it("a moisture_check on the planting marks its water_due item done", () => {
    const out = applyDone(plan(), sat('p1|moisture_check'));
    expect(out.water_due[0].done).toBe(true);
  });

  it('watering and rain still check off Water (no regression on the existing vocabulary)', () => {
    expect(applyDone(plan(), sat('p1|watering')).water_due[0].done).toBe(true);
    expect(applyDone(plan(), sat('p1|rain')).water_due[0].done).toBe(true);
  });

  it('an unrelated event type does NOT check off Water', () => {
    expect(applyDone(plan(), sat('p1|fertilizing')).water_due[0].done).toBe(false);
  });

  it('a moisture_check on a DIFFERENT planting does not check this one off', () => {
    expect(applyDone(plan(), sat('p9|moisture_check')).water_due[0].done).toBe(false);
  });
});

describe('V4-WATERMATH-001 F0 — moisture_check is scoped to Water only', () => {
  // "Never watered" is a history claim. Declaring the soil damp establishes no watering history,
  // so a snooze must not retire the no_history prompt — it would strand a planting that genuinely
  // has never been watered in a permanently-satisfied state.
  it('does NOT check off no_history', () => {
    const out = applyDone(plan(), sat('p2|moisture_check'));
    expect(out.no_history[0].done).toBe(false);
  });

  // The landmine this event type exists to avoid: had moisture_check been modelled as an
  // 'observation' (the obvious shortcut), one "Not thirsty" tap would silently check off PEST
  // tasks, because 'observation' satisfies pest. Its own type is what keeps the sets disjoint.
  it('does NOT check off pest, and pest still keys on observation/pest_treatment', () => {
    expect(applyDone(plan(), sat('p3|moisture_check')).pest[0].done).toBe(false);
    expect(applyDone(plan(), sat('p3|observation')).pest[0].done).toBe(true);
    expect(DONE_EVENTS.pest).not.toContain('moisture_check');
    expect(DONE_EVENTS.no_history).not.toContain('moisture_check');
  });

  it('water_due is the ONLY bucket moisture_check satisfies', () => {
    const buckets = Object.entries(DONE_EVENTS)
      .filter(([, types]) => types.includes('moisture_check'))
      .map(([k]) => k);
    expect(buckets).toEqual(['water_due']);
  });
});

describe('applyDone / planItemIds — fold mechanics', () => {
  it('collects ids across every actionable bucket and skips id-less items', () => {
    const ids = planItemIds(plan({ water_due: [{ id: 'p1' }, { name: 'no id' }, null] }));
    expect(ids).toContain('p1');
    expect(ids).toEqual(expect.arrayContaining(['p1', 'p2', 'p3', 'p4', 'p5']));
    expect(ids).toHaveLength(5);
  });

  it('returns [] for an empty/absent plan so the caller can skip the query entirely', () => {
    expect(planItemIds(null)).toEqual([]);
    expect(planItemIds({})).toEqual([]);
  });

  it('leaves non-bucket envelope keys and non-array buckets untouched', () => {
    const out = applyDone(plan({ water_due: 'not-an-array' }), sat());
    expect(out.generated_at).toBe('2026-08-12T06:00:00Z');
    expect(out.water_due).toBe('not-an-array');
  });

  it('stamps done=false (never undefined) on unsatisfied items, and does not mutate the input', () => {
    const input = plan();
    const out = applyDone(input, sat());
    expect(out.water_due[0].done).toBe(false);
    expect(input.water_due[0]).not.toHaveProperty('done');
  });
});
