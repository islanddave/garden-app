// V5-RADIATIVEFROST-001 — the WIRING, which is where this feature can do real harm.
//
// The module itself is arithmetic. These tests guard the four ways a radiative trigger can be
// count-monotone ("it only ever ADDS alerts") and still be wrong, all four traced against frostEval.js
// before the code was written:
//
//   1. SEVERITY ESCALATION. The rejected implementation was to lower the input `low` until it tripped.
//      `siteLevel` keys on `low <= HARD_FREEZE_LOW_F` (33F), so on a 39F night that rewrites the
//      headline to "HARD FREEZE TONIGHT — Harvest what you want to keep; cover will not save" — an
//      IRREVERSIBLE instruction on a night never forecast below 38F. Adds an alert, destroys a crop.
//   2. HARDY BYPASS. A radiative pass written outside the crop loop skips the `thresholds: null`
//      sentinel and pages about a bed of kale.
//   3. EMPTY-GARDEN FIRING. An empty byCropType is DELIBERATELY a suppression signal.
//   4. COPY THAT LIES. The threshold copy prints `lowF`, so it would read "FROST PROTECT TONIGHT —
//      low 39.8F" against a 38F trip point.
import { describe, it, expect } from 'vitest';
import fe from './frostEval.js';

const { frostEval } = fe;

const T = { ADVISORY_LOW_F: 40, IMMINENT_LOW_F: 38, HARD_FREEZE_LOW_F: 33 };
const tender = (over = {}) => ({ slug: 'pepper', label: 'peppers', band: 'tender', count: 5, containers: 1, thresholds: T, ...over });
const hardy = (over = {}) => ({ slug: 'kale', label: 'kale', band: 'hardy', count: 9, containers: 0, thresholds: null, ...over });

// A clear, calm night whose dewpoint floor sits below the tender trip point.
const RAD = { date: '2026-10-09', minDewpointF: 33, meanCloudPct: 5, meanWindMph: 2, radiative: true };

const run = (over = {}, opts = {}) => frostEval({
  tonightLow: 39,                 // ABOVE the 38F trip point — nothing trips on threshold alone
  highToday: 60,
  // Deliberately ALL above ADVISORY_LOW_F (40). An earlier draft used [39, ...], which fired the
  // advisory tier on THRESHOLD grounds and made `.alert` true in every case — three assertions
  // here were measuring the advisory while claiming to measure the radiative trigger.
  forecastLows: [45, 46, 47], forecastDates: ['2026-10-10', '2026-10-11', '2026-10-12'],
  lowSource: 'forecast',
  exposure: { tender: 5, unknown: 0, tenderContainers: 1, atRisk: 5, byCropType: [tender()] },
  spaceId: 'S1', eventDate: '2026-10-09',
  radiativeNights: [RAD],
  ...over,
}, { frostSeason: true, radiativeEnabled: true, ...opts });

describe('flag OFF is byte-identical — the feature ships dark', () => {
  it('produces exactly the same decision with the flag off, radiative data present or absent', () => {
    const off = run({}, { radiativeEnabled: false });
    const absent = run({ radiativeNights: [] }, { radiativeEnabled: false });
    // observability legitimately differs (it records the flag state), so compare the decision.
    const decision = ({ observability, ...rest }) => rest;
    expect(decision(off)).toEqual(decision(absent));
    expect(off.alert).toBe(false);
    expect(off.imminent.fires).toBe(false);
  });

  it('records the corpus row even when the flag is off — a row written only when the feature fires would be selected on its own outcome', () => {
    const off = run({}, { radiativeEnabled: false });
    expect(off.observability.radiativeEnabled).toBe(false);
    expect(off.observability).toHaveProperty('radiativeTripped', false);
  });
});

describe('the added trigger fires, and ONLY at protect level', () => {
  it('trips a tender crop on a clear calm night the threshold path misses', () => {
    const on = run();
    expect(on.alert).toBe(true);
    expect(on.tier).toBe('imminent');
    expect(on.imminent.fires).toBe(true);
    expect(on.imminent.reason).toBe('radiative_threshold');
    expect(on.imminent.tripped.map((c) => c.slug)).toEqual(['pepper']);
    expect(on.imminent.tripped[0].trip).toBe('radiative');
  });

  it('CANNOT escalate to hard_freeze — the severity guard (failure mode 1)', () => {
    // MUTATION THIS CLOSES: implement the trigger by passing a lowered `low` into evalImminentCrops
    // (e.g. Math.min(low, t.HARD_FREEZE_LOW_F)). Every count-monotonicity assertion in this file still
    // passes; this one does not.
    const on = run();
    expect(on.level).not.toBe('hard_freeze');
    expect(on.imminent.siteLevel).toBe('protect');
    expect(on.imminent.tripped.every((c) => c.level === 'protect')).toBe(true);
    expect(on.message).not.toMatch(/HARD FREEZE/);
    expect(on.message).not.toMatch(/cover will not save/);
    // and the record still reports the TRUE forecast low, not a doctored one
    expect(on.imminent.lowF).toBe(39);
    expect(on.observability.tonightLowF).toBe(39);
  });

  it('leaves a genuine hard freeze exactly as it was', () => {
    const cold = run({ tonightLow: 30 });
    expect(cold.level).toBe('hard_freeze');
    expect(cold.imminent.siteLevel).toBe('hard_freeze');
    expect(cold.message).toMatch(/HARD FREEZE/);
    expect(cold.imminent.reason).toBe('crop_threshold');   // threshold, not radiative
  });
});

describe('the two suppression paths the trigger must not bypass', () => {
  it('a hardy crop is NEVER tripped radiatively (failure mode 2)', () => {
    // MUTATION THIS CLOSES: evaluate the radiative condition in a pass over `rows` that does not
    // re-check cropThresholds -> kale pages Dave.
    const on = run({ exposure: { tender: 0, unknown: 0, atRisk: 0, byCropType: [hardy()] } });
    expect(on.alert).toBe(false);
    expect(on.imminent.fires).toBe(false);
    expect(on.imminent.tripped).toEqual([]);
    expect(on.imminent.untripped.map((c) => c.slug)).toEqual(['kale']);
  });

  it('trips the tender crop and leaves the hardy one alone in the same garden', () => {
    const on = run({ exposure: { tender: 5, unknown: 0, atRisk: 5, byCropType: [tender(), hardy()] } });
    expect(on.imminent.tripped.map((c) => c.slug)).toEqual(['pepper']);
    expect(on.imminent.untripped.map((c) => c.slug)).toEqual(['kale']);
    expect(on.message).not.toMatch(/kale/);
  });

  it('an EMPTY byCropType still suppresses — nothing at risk means no alert (failure mode 3)', () => {
    const on = run({ exposure: { tender: 0, unknown: 0, atRisk: 0, byCropType: [] } });
    expect(on.alert).toBe(false);
    expect(on.imminent.fires).toBe(false);
    expect(on.imminent.reason).toBe('no_crops_at_risk');
  });

  it('a night that is not radiative does not trip, however low the dewpoint', () => {
    const on = run({ radiativeNights: [{ ...RAD, radiative: false, minDewpointF: 20 }] });
    expect(on.alert).toBe(false);
  });

  it('a missing night for tonight does not trip', () => {
    const on = run({ radiativeNights: [{ ...RAD, date: '2026-10-11' }] });   // wrong date
    expect(on.alert).toBe(false);
  });
});

describe('the copy explains itself (failure mode 4)', () => {
  it('names the reason and the dewpoint, and does not present itself as a threshold trip', () => {
    const on = run();
    expect(on.message).toMatch(/FROST WATCH TONIGHT/);
    expect(on.message).toMatch(/clear and calm/);
    expect(on.message).toMatch(/dewpoint is 33°F/);
    expect(on.message).toMatch(/forecast low 39°F/);
    expect(on.message).toMatch(/peppers \(5\)/);
    expect(on.message).not.toMatch(/FROST PROTECT TONIGHT — low/);
  });

  it('a MIXED night (one crop on threshold, one radiative) keeps the threshold copy', () => {
    // radiativeOnly is false here, so the D6 coalesced message stands — the alert is not "merely"
    // radiative and should not be described as one.
    const chilly = { ...T, IMMINENT_LOW_F: 40 };
    const on = run({ exposure: { tender: 9, unknown: 0, atRisk: 9, byCropType: [tender(), tender({ slug: 'basil', label: 'basil', count: 4, thresholds: chilly })] } });
    expect(on.imminent.radiativeOnly).toBe(false);
    expect(on.imminent.reason).toBe('crop_threshold');
    expect(on.message).toMatch(/FROST PROTECT TONIGHT/);
  });
});

describe('the advisory tier gets the same treatment, on its own night', () => {
  it('trips the advisory radiatively when a FUTURE night is clear, calm and dewpoint-floored', () => {
    // D1 is 2026-10-10 at 42F — above the 40F advisory point, so threshold alone is silent.
    const on = run({
      tonightLow: 55,                                   // imminent tier out of the picture entirely
      forecastLows: [42, 50, 51],
      radiativeNights: [{ ...RAD, date: '2026-10-10', minDewpointF: 34 }],
    });
    expect(on.tier).toBe('advisory');
    expect(on.advisoryCrops.fires).toBe(true);
    expect(on.advisoryCrops.tripped[0].trip).toBe('radiative');
    expect(on.advisoryCrops.tripped[0].level).toBe('advisory');
  });

  it('does not trip the advisory on a night that is not the coldest one', () => {
    // The radiative night is D2, but evalAdvisory picks D1 as the coldest. Resolving the night
    // caller-side instead of from advisory.date is how these two would drift apart.
    const on = run({
      tonightLow: 55,
      forecastLows: [42, 50, 51],
      radiativeNights: [{ ...RAD, date: '2026-10-11', minDewpointF: 34 }],
    });
    expect(on.alert).toBe(false);
  });
});

describe('MONOTONICITY — flag-on never produces fewer alerts than flag-off', () => {
  it('holds across a sweep of lows, dewpoints and sky states', () => {
    let strictlyMore = 0;
    for (const tonightLow of [28, 33, 36, 38, 39, 41, 44, 50]) {
      for (const minDewpointF of [20, 28, 33, 37, 41, 48]) {
        for (const radiative of [true, false]) {
          for (const byCropType of [[tender()], [tender(), hardy()], [hardy()], []]) {
            const args = {
              tonightLow,
              radiativeNights: [{ ...RAD, minDewpointF, radiative }],
              exposure: { tender: 5, unknown: 0, atRisk: 5, byCropType },
            };
            const on = run(args);
            const off = run(args, { radiativeEnabled: false });
            const nOn = (on.imminent.tripped || []).length;
            const nOff = (off.imminent.tripped || []).length;
            expect(nOn, `low=${tonightLow} dp=${minDewpointF} rad=${radiative}`).toBeGreaterThanOrEqual(nOff);
            if (off.alert) expect(on.alert).toBe(true);     // never silences
            // and never escalates an alert that already fired
            if (off.alert && off.level === 'protect') expect(on.level).not.toBe('hard_freeze');
            if (nOn > nOff) strictlyMore++;
          }
        }
      }
    }
    // Guard against a vacuous pass: if the flag changed nothing anywhere, >= is trivially true and
    // this whole sweep proves nothing.
    expect(strictlyMore, 'the sweep must contain cases where the flag actually adds an alert')
      .toBeGreaterThan(0);
  });
});
