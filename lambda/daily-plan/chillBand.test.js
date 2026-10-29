// V5-CHILLBAND-001 — the 45-50F cool-night band, and the season words on it and on the cold band below it.
//
// Every boundary below is a LITERAL, never the constant it tests. A threshold case written as
// `THRESHOLD` and `THRESHOLD - 1` makes the fixture track the constant, so moving the constant moves
// the test with it and the case can never fail — a mistake made and caught by mutation elsewhere in
// this same change set. The same goes for the words: each expected sentence is typed out here, not
// built by a helper that could drift with the engine.
//
// The real nights are used as fixtures on purpose: 2026-09-07 (45.6F) and 2026-09-08 (49.7F) are the
// two that passed in silence and are the reason this rule exists.
//
// HISTORY: the first version of this rule (7b43773d, 2026-09-09) was reverted 46 minutes later because
// the engine returned icon `cool` and the client could not render it, so Today went silent on such a
// night. src/__tests__/weatherCue.test.js drives the REAL client reader and the REAL server vocabulary
// with the engine's own output, so that failure reds a test. (It lives there, not here: a test under
// lambda/ that loads src/ has to run in the dom project, scripts/vitest/vitest-node-project.mjs.)

import { describe, it, expect } from 'vitest';
import engine from './engine.js';

const { computeCallout, generatePlan, calloutSeason } = engine;
const DRY = { recent_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 };
const wx = (tonightLow, highToday = 74) => ({ tonightLow, highToday });
// computeCallout(weather, hydrology, bedsWait, planDate)
const on = (date, low, high, hy = DRY) => computeCallout(wx(low, high), hy, false, date);

const SPRING = '2026-06-01', FALL = '2026-09-08', WINTER = '2026-01-15';

describe('the 45-50F cool-night band', () => {
  it('speaks on the two real September nights that used to pass in silence', () => {
    // Before this rule both returned null. These are the actual stored tmin values and plan dates.
    expect(on('2026-09-07', 45.6)).toEqual({ icon: 'cool', text: 'Cool night (45.6°F) — pick coloring peppers & tomatoes' });
    expect(on('2026-09-08', 49.7)).toEqual({ icon: 'cool', text: 'Cool night (49.7°F) — pick coloring peppers & tomatoes' });
  });

  it('stops at 50 — the band is a floor, not an open-ended cool warning', () => {
    for (const date of [SPRING, FALL]) {
      expect(on(date, 49.9)).not.toBeNull();
      expect(on(date, 50)).toBeNull();
      expect(on(date, 55)).toBeNull();
    }
  });

  it('starts at 45 — 44.9 is still the cold line', () => {
    for (const date of [SPRING, FALL]) {
      expect(on(date, 44.9).icon).toBe('cold');
      expect(on(date, 45).icon).toBe('cool');
    }
  });

  it('does NOT steal the colder bands — priority order is preserved', () => {
    // A 38F night is a freeze and must keep saying so; a 43F night stays the cold-night rule.
    // Placing the new band above either of these in the chain would silently downgrade them.
    for (const date of [SPRING, FALL]) {
      expect(on(date, 38).icon).toBe('freeze');
      expect(on(date, 43).icon).toBe('cold');
      expect(on(date, 47).icon).toBe('cool');
    }
  });

  it('outranks heat, rain and wet on such a night; they speak when no cold-side band applies', () => {
    const RAIN = { recent_precip_in: 0, tomorrow_precip_in: 0.6, tomorrow_pop: 80 };
    const WET = { recent_precip_in: 0.6, tomorrow_precip_in: 0, tomorrow_pop: 0 };
    expect(on(FALL, 47, 90).icon).toBe('cool');
    expect(on(FALL, 47, 74, RAIN).icon).toBe('cool');
    expect(on(FALL, 47, 74, WET).icon).toBe('cool');
    expect(on(FALL, 60, 90).icon).toBe('heat');
    expect(on(FALL, 60, 74, RAIN).icon).toBe('rain');
    expect(on(FALL, 60, 74, WET).icon).toBe('wet');
  });

  it('says nothing when the low is unknown, rather than guessing', () => {
    for (const date of [SPRING, FALL, WINTER]) {
      expect(on(date, null)).toBeNull();
      expect(computeCallout({}, DRY, false, date)).toBeNull();
    }
  });
});

describe('the season is the PLAN DATE\'s month and day', () => {
  const SPRING_COOL = 'Cool night (47°F) — cover young peppers, basil & cukes';
  const FALL_COOL = 'Cool night (47°F) — pick coloring peppers & tomatoes';
  const ALLYEAR_COLD = 'Cold night (43°F) — protect flowering peppers/tomatoes';
  const FALL_COLD = 'Cold night (43°F) — pick coloring peppers & tomatoes';

  // date, the cool line at 47 (null = no cool line), the cold line at 43
  const TABLE = [
    ['2026-01-01', null, ALLYEAR_COLD],
    ['2026-04-30', null, ALLYEAR_COLD],
    ['2026-05-01', SPRING_COOL, ALLYEAR_COLD],
    ['2026-07-04', SPRING_COOL, ALLYEAR_COLD],
    ['2026-08-14', SPRING_COOL, ALLYEAR_COLD],
    ['2026-08-15', FALL_COOL, FALL_COLD],
    ['2026-09-30', FALL_COOL, FALL_COLD],
    ['2026-10-31', FALL_COOL, FALL_COLD],
    ['2026-11-01', null, ALLYEAR_COLD],
    ['2026-12-31', null, ALLYEAR_COLD],
  ];

  it.each(TABLE)('%s', (date, cool, cold) => {
    expect(on(date, 47)).toEqual(cool ? { icon: 'cool', text: cool } : null);
    expect(on(date, 43)).toEqual({ icon: 'cold', text: cold });
    // The freeze line has no season: byte for byte what it always was.
    expect(on(date, 38)).toEqual({ icon: 'freeze', text: 'Freeze tonight (38°F) — cover or bring peppers & tomatoes in' });
  });

  it('out of season the 45-50 night falls through to heat, rain and wet exactly as before', () => {
    const RAIN = { recent_precip_in: 0, tomorrow_precip_in: 0.6, tomorrow_pop: 80 };
    const WET = { recent_precip_in: 0.6, tomorrow_precip_in: 0, tomorrow_pop: 0 };
    for (const date of ['2026-11-01', '2026-04-30', WINTER]) {
      expect(on(date, 47, 90).icon).toBe('heat');
      expect(on(date, 47, 74, RAIN).icon).toBe('rain');
      expect(on(date, 47, 74, WET).icon).toBe('wet');
      expect(on(date, 47)).toBeNull();
    }
  });

  it('no usable date: no cool line, and the cold line keeps its all-year words', () => {
    for (const date of [undefined, null, '', 'yesterday', '2026-13-40', 20260908, new Date('2026-09-08T12:00:00Z'), {}]) {
      expect(computeCallout(wx(47), DRY, false, date)).toBeNull();
      expect(computeCallout(wx(47, 90), DRY, false, date).icon).toBe('heat');
      expect(computeCallout(wx(43), DRY, false, date)).toEqual({ icon: 'cold', text: ALLYEAR_COLD });
    }
    // The three-argument call every older caller makes.
    expect(computeCallout(wx(47), DRY)).toBeNull();
    expect(computeCallout(wx(43), DRY)).toEqual({ icon: 'cold', text: ALLYEAR_COLD });
  });

  it('calloutSeason reads the date as text — the year does not matter and no clock is consulted', () => {
    expect(['2024-08-14', '2031-08-14'].map(calloutSeason)).toEqual(['spring', 'spring']);
    expect(['2024-08-15', '2031-08-15'].map(calloutSeason)).toEqual(['fall', 'fall']);
    expect(['2026-04-30', '2026-11-01'].map(calloutSeason)).toEqual([null, null]);
    expect(calloutSeason.toString()).not.toMatch(/new Date|Date\.|now\(/);
  });

  it('N prints as the engine holds it: no rounding is added', () => {
    expect(on(FALL, 45.6).text).toMatch(/^Cool night \(45\.6°F\) — /);
    expect(on(SPRING, 49).text).toMatch(/^Cool night \(49°F\) — /);
    expect(on(FALL, 44.4).text).toMatch(/^Cold night \(44\.4°F\) — /);
  });
});

describe('generatePlan hands the rule the plan\'s own date', () => {
  const plan = (today, tonightLow) => generatePlan({
    plantings: [], cadence: { default: { crop: 'unknown' }, by_variety: {}, by_genus_fallback: {} }, fertModel: {},
    today, weather: { tonightLow, highToday: 74, code: 1, short: 'Clear', unit: 'F' }, hydrology: DRY, ownerFallback: 'u1',
  });

  it('the stored callout follows `today`, which is also the plan\'s `date`', () => {
    const fall = plan('2026-09-08', 49.7);
    expect(fall.date).toBe('2026-09-08');
    expect(fall.weather.callout).toEqual({ icon: 'cool', text: 'Cool night (49.7°F) — pick coloring peppers & tomatoes' });
    expect(plan('2026-08-14', 47).weather.callout).toEqual({ icon: 'cool', text: 'Cool night (47°F) — cover young peppers, basil & cukes' });
    expect(plan('2026-08-15', 47).weather.callout.text).toBe('Cool night (47°F) — pick coloring peppers & tomatoes');
    expect(plan('2026-11-01', 47).weather.callout).toBeNull();
    expect(plan('2026-10-31', 43).weather.callout.text).toBe('Cold night (43°F) — pick coloring peppers & tomatoes');
    expect(plan('2026-11-01', 43).weather.callout.text).toBe('Cold night (43°F) — protect flowering peppers/tomatoes');
  });
});
