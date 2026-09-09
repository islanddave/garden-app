// V5-LEAFWETNESS-001 — behavioural tests for the foliar infection-window cue.
//
// Every assertion below is about BEHAVIOUR (what the function returns for given weather), never about
// source text. Mutation-confirmed at authoring: moving WET_HOURS_MIN 8->7, moving either band edge,
// or removing the `leaf_wetness` key from the payload each reddens a named case here.
//
// The fixture temperatures are chosen so mean temp sits UNAMBIGUOUSLY inside or outside the band —
// a fixture whose mean lands on an edge would pass under both the current rule and an off-by-one.

import { describe, it, expect } from 'vitest';
import engine from './engine.js';
import lw from './leafWetness.js';
import cad from './cadence-data-v2.json';
import fm from './fertilization-model.json';

const { assessLeafWetness, dayQualifies, WET_HOURS_MIN, INFECTION_MIN_F, INFECTION_MAX_F } = lw;
const { generatePlan } = engine;

const TODAY = '2026-09-08';
// mean 70F — mid-band, so neither edge can be the reason a case passes.
const IN_BAND = { tmax_f: 78, tmin_f: 62 };
const day = (date, precip_hours, t = IN_BAND) => ({ date, precip_hours, ...t });

describe('dayQualifies — both legs, or neither', () => {
  it('fires on a long wet day inside the infection band', () => {
    expect(dayQualifies(day('2026-09-05', 12))).toBe(true);
  });

  it('does NOT fire one hour under the wet threshold', () => {
    // LITERALS, DELIBERATELY. Writing this pair as WET_HOURS_MIN and WET_HOURS_MIN-1 makes the
    // fixture track the constant, so moving the constant moves the test with it and the case can
    // never fail — caught by mutation at authoring, when 8->7 left all 14 tests green. A threshold
    // test expressed in terms of its own threshold asserts nothing.
    expect(dayQualifies(day('2026-09-05', 8))).toBe(true);
    expect(dayQualifies(day('2026-09-05', 7))).toBe(false);
  });

  it('does NOT fire when it is too cold for the pathogens, however wet', () => {
    // mean 50F, well under the 59F floor, with 24 hours of wet. The 58/60 pair below pins the edge
    // itself with literals, so widening the band by one degree reddens this case.
    expect(dayQualifies(day('2026-09-05', 24, { tmax_f: 55, tmin_f: 45 }))).toBe(false);
    expect(dayQualifies(day('2026-09-05', 24, { tmax_f: 58, tmin_f: 58 }))).toBe(false); // mean 58
    expect(dayQualifies(day('2026-09-05', 24, { tmax_f: 60, tmin_f: 60 }))).toBe(true);  // mean 60
  });

  it('does NOT fire when it is hot enough to dry the leaves, however wet', () => {
    // mean 88F, over the 80F ceiling; the 81/79 pair pins that edge with literals.
    expect(dayQualifies(day('2026-09-05', 24, { tmax_f: 96, tmin_f: 80 }))).toBe(false);
    expect(dayQualifies(day('2026-09-05', 24, { tmax_f: 81, tmin_f: 81 }))).toBe(false); // mean 81
    expect(dayQualifies(day('2026-09-05', 24, { tmax_f: 79, tmin_f: 79 }))).toBe(true);  // mean 79
  });

  it('treats a missing hour count as UNKNOWN, never as dry', () => {
    // Guards the null discipline at the ingest: 0 hours is a real dry day, so coercing null->0 would
    // make an absent measurement indistinguishable from a measured one. Both must be non-qualifying,
    // but for different reasons, and neither may throw.
    expect(dayQualifies(day('2026-09-05', null))).toBe(false);
    expect(dayQualifies(day('2026-09-05', 0))).toBe(false);
    expect(dayQualifies({ date: '2026-09-05', precip_hours: 12 })).toBe(false); // no temps at all
  });
});

describe('assessLeafWetness — splits what already happened from what is coming', () => {
  const WINDOW = [
    day('2026-09-06', 12),          // behind, qualifies
    day('2026-09-07', 0),           // behind, dry
    day(TODAY, 10),                 // today counts as observed
    day('2026-09-09', 9),           // ahead, qualifies
    day('2026-09-10', 2),           // ahead, dry
    day('2026-09-11', 11),          // ahead, qualifies
  ];

  it('counts past and future separately, because they ask different things of Dave', () => {
    const r = assessLeafWetness(WINDOW, TODAY);
    expect(r.recent_wet_days).toBe(2);            // 09-06 + today
    expect(r.ahead_wet_days).toBe(2);             // 09-09 + 09-11
    expect(r.recent_dates).toEqual(['2026-09-06', TODAY]);
    expect(r.ahead_dates).toEqual(['2026-09-09', '2026-09-11']);
  });

  it('puts TODAY on the observed side, not the forecast side', () => {
    const r = assessLeafWetness([day(TODAY, 12)], TODAY);
    expect(r.recent_wet_days).toBe(1);
    expect(r.ahead_wet_days).toBe(0);
  });

  it('reads the forecast half at all — which no weather_daily-sourced cue could', () => {
    // weather_daily stores completed days only and has no future rows, so this case is the
    // justification for sourcing the window from the live fetch instead of the table.
    const r = assessLeafWetness([day('2026-09-11', 11)], TODAY);
    expect(r.ahead_wet_days).toBe(1);
  });

  it('returns null — not an empty object — when nothing qualifies', () => {
    // "no wet days" and "the cue did not run" must stay distinguishable downstream.
    expect(assessLeafWetness([day('2026-09-06', 1), day('2026-09-07', 0)], TODAY)).toBeNull();
    expect(assessLeafWetness([], TODAY)).toBeNull();
    expect(assessLeafWetness(null, TODAY)).toBeNull();
  });

  it('labels its own basis as modelled, so the UI cannot imply it is gauged', () => {
    // precip_hours is Open-Meteo grid; precip_in is the on-site station. They contradict on real
    // days (2026-09-02: 1.12 in over 0 modelled hours). The label is what stops a consumer pairing
    // them into "1.12 in of rain over 0 hours".
    expect(assessLeafWetness(WINDOW, TODAY).basis).toBe('modelled_precip_hours');
  });

  it('reports the thresholds it used, so the number on screen is explainable', () => {
    // Literals again: asserting r.wet_hours_min === WET_HOURS_MIN only proves the value was copied,
    // not that it is the value we intend to ship. Both claims are worth making, so make both.
    const r = assessLeafWetness(WINDOW, TODAY);
    expect(r.wet_hours_min).toBe(8);
    expect(r.band_f).toEqual([59, 80]);
    expect(r.wet_hours_min).toBe(WET_HOURS_MIN);
    expect(r.band_f).toEqual([INFECTION_MIN_F, INFECTION_MAX_F]);
  });
});

describe('the plan payload actually carries it', () => {
  const planWith = (hydrology) => generatePlan({
    plantings: [{
      id: 'x1', name: 'Tomato', status: 'fruiting', project: 'Bed', project_id: 'pb',
      substrate_start: '2026-05-01', last_water: TODAY,
      db_cadence: { crop: 'tomato', water_interval_days_inground: 3 },
    }],
    cadence: cad, fertModel: fm, today: TODAY,
    weather: { tonightLow: 62, highToday: 78, unit: 'F' },
    hydrology,
    ownerFallback: 'dave',
  });

  const BASE_HY = {
    recent_precip_in: 0, today_precip_in: 0, today_pop: 0,
    upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0,
  };

  it('emits leaf_wetness when the window shows an infection run', () => {
    const plan = planWith({ ...BASE_HY, wetness_window: [day('2026-09-06', 12), day(TODAY, 10)] });
    expect(plan.leaf_wetness).not.toBeNull();
    expect(plan.leaf_wetness.recent_wet_days).toBe(2);
  });

  it('OMITS the key entirely when no window was supplied — byte-identical to the old payload', () => {
    // The pre-existing hydrology shape. The key must be ABSENT, not null: an always-present key
    // changes every stored payload and reddens all 26 G-PARITY goldens at once, which is how the
    // first cut of this failed. Same conditional-spread rule as today_observed_in.
    const plan = planWith(BASE_HY);
    expect(Object.prototype.hasOwnProperty.call(plan, 'leaf_wetness')).toBe(false);
  });

  it('omits the key when a window exists but no day qualifies', () => {
    const plan = planWith({ ...BASE_HY, wetness_window: [day('2026-09-06', 1), day(TODAY, 0)] });
    expect(Object.prototype.hasOwnProperty.call(plan, 'leaf_wetness')).toBe(false);
  });
});
