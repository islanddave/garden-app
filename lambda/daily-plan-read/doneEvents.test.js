// V3-TODAYDONE-001 / V4-WATERMATH-001 F0 — the read-time check-off fold, EXECUTED.
//
// Every other guard on this Lambda is source-text (index.js imports @neondatabase/serverless +
// @clerk/backend + @aws-sdk/*, and ci.yml runs one root `npm ci` with no per-Lambda install, so
// nothing can import it). doneEvents.js is dependency-free precisely so the logic that decides
// whether a plan item is done runs for real here rather than being regex-asserted.
import { describe, it, expect } from 'vitest';
import { DONE_EVENTS, applyDone, planItemIds, fedWithinInterval, daysBetweenISO } from './doneEvents.js';

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

  // V4-OVERWINTER-001 widened this from "water_due ONLY" to "the two watering-clock buckets ONLY".
  // The overwintering row IS a soil check — moisture_check is its PRIMARY satisfying event, not a
  // borrowed one — so the guard's real content was never the single name, it was that the type stays
  // out of pest and out of no_history. Both of those remain asserted, above and here, and the
  // allow-list is exact: add moisture_check to any third bucket and this goes red.
  it('only the watering-clock buckets are satisfied by moisture_check', () => {
    const buckets = Object.entries(DONE_EVENTS)
      .filter(([, types]) => types.includes('moisture_check'))
      .map(([k]) => k);
    expect(buckets).toEqual(['water_due', 'overwintering']);
  });

  // The overwintering card must be retirable by the honest winter answer ("felt it, still damp").
  // Without this the reduced-cadence check re-cards every night once the interval passes.
  it('a moisture_check retires an overwintering item', () => {
    const p = { ...plan(), overwintering: [{ id: 'p8', name: 'Winterbor Kale' }] };
    expect(applyDone(p, sat('p8|moisture_check')).overwintering[0].done).toBe(true);
    expect(applyDone(p, sat('p8|watering')).overwintering[0].done).toBe(true);
    expect(applyDone(p, sat('p8|observation')).overwintering[0].done).toBe(false);
  });
});

describe('pest — `doctored` is the live treatment vocabulary', () => {
  // The regression this locks: DONE_EVENTS.pest was written before `doctored` shipped (2026-06-08)
  // and never followed it. `doctored` then completely displaced `pest_treatment` (510 events / 239
  // in 30 days vs 405 lifetime and zero since 2026-07-17), so the only treatment type still in use
  // could not check off the task it satisfies.
  it('a doctored event marks its pest item done', () => {
    expect(applyDone(plan(), sat('p3|doctored')).pest[0].done).toBe(true);
  });

  it('observation and pest_treatment still satisfy pest (both retained, nothing displaced)', () => {
    expect(applyDone(plan(), sat('p3|observation')).pest[0].done).toBe(true);
    expect(applyDone(plan(), sat('p3|pest_treatment')).pest[0].done).toBe(true);
    expect(DONE_EVENTS.pest).toEqual(['observation', 'pest_treatment', 'doctored']);
  });

  // Scoping, in the same shape as the moisture_check guard above: a treatment is a pest answer and
  // nothing else. Doctoring a plant establishes no watering history and is not a feeding.
  it('doctored satisfies pest ONLY', () => {
    const out = applyDone(plan(), sat('p1|doctored', 'p2|doctored', 'p4|doctored', 'p5|doctored'));
    expect(out.water_due[0].done).toBe(false);
    expect(out.no_history[0].done).toBe(false);
    expect(out.fertilize[0].done).toBe(false);
    expect(out.cold[0].done).toBe(false);
    const buckets = Object.entries(DONE_EVENTS)
      .filter(([, types]) => types.includes('doctored'))
      .map(([k]) => k);
    expect(buckets).toEqual(['pest']);
  });
});

describe('BUG-BACKDATEDFEED-001 — a back-dated feeding still checks off Feed', () => {
  // The live incident this reproduces: 2026-08-25, 173 fertilizing events written at 07:07 ET and all
  // dated 08-24. `sat` (events dated TODAY) was empty for every one of them, so both feed cards on
  // that morning's plan stayed up. Interval 14, fed 1 day ago => not due => done.
  const feedPlan = (interval) => plan({ fertilize: [{ id: 'p4', name: 'Dill', interval }] });
  const ctx = (last, today = '2026-08-25') => ({ today, lastFert: new Map([['p4', last]]) });

  it('a feeding DATED YESTERDAY, inside the interval, retires the card', () => {
    expect(applyDone(feedPlan(14), sat(), ctx('2026-08-24')).fertilize[0].done).toBe(true);
  });

  it('a feeding OLDER than the interval does NOT retire it (the card is genuinely due)', () => {
    expect(applyDone(feedPlan(7), sat(), ctx('2026-08-16')).fertilize[0].done).toBe(false);
    // ...and the boundary is exclusive: dF === interval means due, matching the engine's `dF>=iv`.
    expect(applyDone(feedPlan(7), sat(), ctx('2026-08-18')).fertilize[0].done).toBe(false);
    expect(applyDone(feedPlan(7), sat(), ctx('2026-08-19')).fertilize[0].done).toBe(true);
  });

  it('falls back to the day rule when the item carries no interval (plans stored pre-upgrade)', () => {
    // Never guess a cadence: an un-priced card must not be retired by an arbitrarily old feeding.
    expect(applyDone(feedPlan(undefined), sat(), ctx('2026-08-24')).fertilize[0].done).toBe(false);
    // The day rule still works on that same item — this is a fallback, not a regression.
    expect(applyDone(feedPlan(undefined), sat('p4|fertilizing'), ctx('2026-08-24')).fertilize[0].done).toBe(true);
  });

  it('a FUTURE-dated feeding is not evidence the plant has been fed', () => {
    expect(applyDone(feedPlan(14), sat(), ctx('2026-08-26')).fertilize[0].done).toBe(false);
  });

  // The scoping guard, in the same shape as the moisture_check and doctored ones above. A watering
  // dated three days ago does NOT mean the planting got water today; widening the water arm would
  // check off a task nobody performed.
  it('the cadence signal is FEED-ONLY — no other bucket can be retired by it', () => {
    const full = {
      ...plan(),
      fertilize: [{ id: 'p4', name: 'Dill', interval: 14 }],
      water_due: [{ id: 'p1', name: 'Habanero', interval: 14 }],
      no_history: [{ id: 'p2', name: 'Sage', interval: 14 }],
      pest: [{ id: 'p3', name: 'Basil', interval: 14 }],
      cold: [{ id: 'p5', name: 'Fittonia', interval: 14 }],
      overwintering: [{ id: 'p8', name: 'Kale', interval: 14 }],
    };
    const everyId = new Map(['p1', 'p2', 'p3', 'p4', 'p5', 'p8'].map((k) => [k, '2026-08-24']));
    const out = applyDone(full, sat(), { today: '2026-08-25', lastFert: everyId });
    expect(out.fertilize[0].done).toBe(true);
    for (const b of ['water_due', 'no_history', 'pest', 'cold', 'overwintering']) {
      expect(out[b][0].done).toBe(false);
    }
    const buckets = Object.keys(DONE_EVENTS).filter((k) => fedWithinInterval(k, { id: 'p4', interval: 14 }, ctx('2026-08-24')));
    expect(buckets).toEqual(['fertilize']);
  });

  it('omitting ctx reproduces the pre-fix behaviour exactly (widening only ever ADDS done-ness)', () => {
    expect(applyDone(feedPlan(14), sat()).fertilize[0].done).toBe(false);
    expect(applyDone(feedPlan(14), sat('p4|fertilizing')).fertilize[0].done).toBe(true);
  });

  it('daysBetweenISO counts calendar days and rejects junk', () => {
    expect(daysBetweenISO('2026-08-25', '2026-08-24')).toBe(1);
    expect(daysBetweenISO('2026-08-25', '2026-08-25')).toBe(0);
    // Spring-forward: 03-08 is a 23-hour ET day, so an hours-based diff would round to 0 here.
    expect(daysBetweenISO('2026-03-09', '2026-03-08')).toBe(1);
    expect(daysBetweenISO('2026-08-25', null)).toBeNull();
    expect(daysBetweenISO('nope', '2026-08-24')).toBeNull();
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
