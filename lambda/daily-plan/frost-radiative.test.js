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

  it('THE CORPUS FILLS FLAG-OFF — this is the whole reason the feature can ship dark', () => {
    // The stated purpose of the observability block is "the 2026 corpus for the 2027 learned offset".
    // Recording the conditions only when the flag is ON would fill it exclusively on nights the
    // feature was already enabled for — selected on its own outcome — and would leave it EMPTY for as
    // long as the flag stays off, which is correct-and-indefinite until there is site truth to justify
    // enabling it. Nothing here can be backfilled: weather_daily.tmin_f is Open-Meteo's model value
    // and the AWN API serves a rolling ~3-day window, so a night not recorded is gone.
    const off = run({}, { radiativeEnabled: false });
    expect(off.observability.radiativeEnabled).toBe(false);
    expect(off.observability.radiativeTripped).toBe(false);
    expect(off.alert).toBe(false);                       // and it still does not act
    // ...but every conditions value IS recorded.
    expect(off.observability.radiativeNightsAvailable).toBe(1);
    expect(off.observability.radiativeTonight).toEqual({
      date: '2026-10-09', minDewpointF: 33, meanCloudPct: 5, meanWindMph: 2,
      hours: undefined, radiative: true,
    });
  });

  it('records nothing rather than a placeholder when no night arrives', () => {
    const off = run({ radiativeNights: [] }, { radiativeEnabled: false });
    expect(off.observability.radiativeNightsAvailable).toBe(0);
    expect(off.observability.radiativeTonight).toBeNull();
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

describe('the advisory tier resolves the night that MAKES its minimum', () => {
  // These two cases previously ENCODED AN OFF-BY-ONE as expected behaviour, and actively defended it:
  // a mutation correcting the pairing was killed BY THEM. `advisory.date` is a CIVIL DAY and its
  // `temperature_2m_min` is set shortly after sunrise, so the night that produces it is keyed D-1.
  // Measured over 380 nights at the site: 77.6% of daily minima fall at hour <=08:00, and the two
  // keyings disagree on 36.1% of pairs.
  it('pairs advisory date D with the night keyed D-1', () => {
    // D1 = 2026-10-10 at 42F. The night that makes that minimum STARTS 2026-10-09.
    const on = run({
      tonightLow: 55,                                   // imminent tier out of the picture
      forecastLows: [42, 50, 51],
      radiativeNights: [{ ...RAD, date: '2026-10-09', minDewpointF: 34 }],
    });
    expect(on.tier).toBe('advisory');
    expect(on.advisoryCrops.tripped[0].trip).toBe('radiative');
    expect(on.advisoryCrops.tripped[0].level).toBe('advisory');
  });

  it('does NOT pair it with the night keyed D — the night that makes the NEXT day\'s minimum', () => {
    const on = run({
      tonightLow: 55,
      forecastLows: [42, 50, 51],
      radiativeNights: [{ ...RAD, date: '2026-10-10', minDewpointF: 34 }],
    });
    expect(on.alert).toBe(false);
  });

  it('resolves D3, which the wrong pairing could NEVER reach', () => {
    // Coldest is D3 = 2026-10-12, so the night needed is 2026-10-11 — key D2, which the real
    // past_days=2&forecast_days=4 window DOES produce. The old pairing asked for key D3, which that
    // window cannot produce at all, so one third of the advisory horizon was silently uncovered.
    const on = run({
      tonightLow: 55,
      forecastLows: [50, 51, 42],
      radiativeNights: [{ ...RAD, date: '2026-10-11', minDewpointF: 34 }],
    });
    expect(on.tier).toBe('advisory');
    expect(on.advisory.dayOffset).toBe(3);
    expect(on.advisoryCrops.tripped[0].trip).toBe('radiative');
  });

  it('a MIXED advisory still FIRES — losing it would lose the radiative crop entirely', () => {
    // MUTATION THIS CLOSES: `advisoryRadiative` `.some` -> `.every`. The global gate is SHUT here
    // (43 > 40), so the tier opens only via the radiative disjunct. Under `.every`, one
    // non-radiative crop in the tripped set flips it false and the whole tier goes silent — pepper's
    // genuine radiative alert is lost. Basil is correctly NOT named: its own band is met but the
    // global gate suppresses it, and a radiative night for a different crop must not resurrect it.
    const chill = { ADVISORY_LOW_F: 47, IMMINENT_LOW_F: 45, HARD_FREEZE_LOW_F: 36 };
    const on = run({
      tonightLow: 55,
      forecastLows: [43, 50, 51],
      radiativeNights: [{ ...RAD, date: '2026-10-09', minDewpointF: 34 }],
      exposure: { tender: 9, unknown: 0, atRisk: 9, byCropType: [
        tender(),
        tender({ slug: 'basil', label: 'basil', count: 4, thresholds: chill }),
      ] },
    });
    expect(on.tier).toBe('advisory');
    expect(on.advisoryCrops.tripped.map((c) => c.slug).sort()).toEqual(['basil', 'pepper']);
    expect(on.trippedCrops.map((c) => c.slug)).toEqual(['pepper']);   // named set is filtered
    expect(on.message).not.toMatch(/basil/);
  });

  it('when the GLOBAL gate is open, a mixed set is named in full and gets the PLAIN copy', () => {
    // MUTATION THIS CLOSES: advisoryMessage's `radOnly` `.every` -> `.some`. Here the gate is open
    // (39 <= 40) so nothing is filtered; the set is genuinely mixed, so the radiative wording would be
    // a lie about a night where a real threshold WAS crossed.
    const cold = { ADVISORY_LOW_F: 36, IMMINENT_LOW_F: 34, HARD_FREEZE_LOW_F: 30 };
    const on = run({
      tonightLow: 55,
      forecastLows: [39, 50, 51],
      radiativeNights: [{ ...RAD, date: '2026-10-09', minDewpointF: 34 }],
      exposure: { tender: 9, unknown: 0, atRisk: 9, byCropType: [
        tender(),                                                            // 39 <= 40 threshold
        tender({ slug: 'chard', label: 'chard', count: 4, thresholds: cold }), // 39 > 36, radiative
      ] },
    });
    expect(on.tier).toBe('advisory');
    expect(on.trippedCrops.map((c) => c.slug).sort()).toEqual(['chard', 'pepper']);
    expect(on.message).toMatch(/frost possible/);
    expect(on.message).not.toMatch(/looks clear and calm/);
  });

  it('a crop suppressed by the GLOBAL gate is not resurrected by an unrelated crop\'s clear night', () => {
    // The disjunct opens the tier on a radiative trip. Without the filter, a crop whose own band sits
    // above the global gate — suppressed flag-off — would be alerted purely because SOME OTHER crop
    // had a clear night. Whether the global gate should suppress it at all is a real pre-existing
    // question; it is not this feature's to settle by side effect.
    const chill = { ADVISORY_LOW_F: 47, IMMINENT_LOW_F: 45, HARD_FREEZE_LOW_F: 36 };
    const args = {
      tonightLow: 55,
      forecastLows: [43, 50, 51],                       // 43 > 40 global, <= 47 basil's own band
      radiativeNights: [{ ...RAD, date: '2026-10-09', minDewpointF: 34 }],
      exposure: { tender: 9, unknown: 0, atRisk: 9, byCropType: [
        tender({ slug: 'basil', label: 'basil', count: 4, thresholds: chill }),
      ] },
    };
    expect(run(args, { radiativeEnabled: false }).tier).toBeNull();   // suppressed flag-off
    const on = run(args);                                            // pepper absent, so nothing radiative
    expect(on.tier).toBeNull();                                      // still suppressed flag-on
  });
});


describe('MONOTONICITY — and count-monotonicity is NOT the property that matters', () => {
  // The original sweep asserted only that flag-on trips >= flag-off trips. That is structurally blind
  // to the failure a review found: a radiative IMMINENT trip — by construction the least certain trip
  // in the system, since it fires only when the forecast low is ABOVE the trip point — outranks the
  // advisory tier and would DELETE a hard-forecast advisory about a genuinely colder future night.
  // Count went UP, the operator's information went DOWN. The sweep also pinned forecastLows at
  // [45,46,47], so the advisory path was never inside it at all.
  it('never silences, never escalates, never drops a crop, never loses a colder night', () => {
    let strictlyMore = 0, displaced = 0, advisoryCases = 0;
    for (const tonightLow of [28, 33, 36, 38, 39, 41, 44, 50]) {
      for (const forecastLows of [[45, 46, 47], [36, 46, 47], [39, 42, 44], [30, 35, 50]]) {
        for (const minDewpointF of [20, 28, 33, 37, 41, 48]) {
          for (const radiative of [true, false]) {
            for (const byCropType of [[tender()], [tender(), hardy()], [hardy()], []]) {
              const args = {
                tonightLow, forecastLows,
                radiativeNights: [
                  { ...RAD, date: '2026-10-09', minDewpointF, radiative },
                  { ...RAD, date: '2026-10-10', minDewpointF, radiative },
                ],
                exposure: { tender: 5, unknown: 0, atRisk: 5, byCropType },
              };
              const on = run(args);
              const off = run(args, { radiativeEnabled: false });
              const ctx = `low=${tonightLow} fc=${forecastLows} dp=${minDewpointF} rad=${radiative}`;

              const nOn = (on.imminent.tripped || []).length;
              const nOff = (off.imminent.tripped || []).length;
              expect(nOn, ctx).toBeGreaterThanOrEqual(nOff);
              if (off.alert) expect(on.alert, ctx).toBe(true);
              if (off.alert && off.level === 'protect') expect(on.level, ctx).not.toBe('hard_freeze');

              // Every crop named flag-off is still named flag-on.
              const named = (d) => new Set((d.trippedCrops || []).map((c) => c.slug));
              for (const slug of named(off)) expect(named(on).has(slug), `${ctx} dropped ${slug}`).toBe(true);

              // INFORMATION-monotonicity: if the flag displaces an advisory, the colder night's
              // temperature must still appear in the outbound message.
              if (off.tier === 'advisory' && on.tier === 'imminent') {
                displaced++;
                expect(on.message, `${ctx} lost the advisory temperature`)
                  .toContain(String(off.advisory.minLowF));
              }
              if (off.tier === 'advisory' || on.tier === 'advisory') advisoryCases++;
              if (nOn > nOff) strictlyMore++;
            }
          }
        }
      }
    }
    // Non-vacuity: a sweep in which the flag never acts, never displaces, and never reaches the
    // advisory path proves nothing, and >= would hold trivially.
    expect(strictlyMore, 'sweep must contain cases where the flag adds an alert').toBeGreaterThan(0);
    expect(displaced, 'sweep must contain the tier-displacement case').toBeGreaterThan(0);
    expect(advisoryCases, 'sweep must exercise the advisory path').toBeGreaterThan(0);
  });
});
