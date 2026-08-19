// V4-DISMISSREFITSTATS-001 — the three method corrections owed to §4.4's refit plan, pinned.
//
// Each block below breaks if its correction is removed, and the "would have fitted" assertions state
// what §4.4-as-written would have produced from the same rows — so the test reads as the argument
// for the correction, not just as a boundary check.
import { describe, it, expect } from 'vitest';
import {
  REFIT_QUANTILE, REFIT_MIN_UNITS, REFIT_CENSORING_CEILING,
  reduceToPlantingUnits, kaplanMeierQuantile, fitPartition, fitSuppressionDays,
} from './dismissalRefit.js';

const DAY = 86400000;
const ymd = (base, offset) => new Date(Date.parse(`${base}T00:00:00Z`) + offset * DAY).toISOString().slice(0, 10);
const OBS = '2026-06-01';

// One dismissal row. observed_on defaults to a shared date so `days` reads directly as the interval.
function tap(over = {}) {
  return {
    plant_id: 'p1', observed_on: OBS, first_pick_date: null, censored_on: null,
    harvest_habit: 'single', crop_type_slug: 'melon', model_version: 'watch-v1', undone_at: null,
    ...over,
  };
}

// Plant ids are minted from a monotonic counter, never from the fixture's arguments: two cohorts
// built with the same `days` would otherwise collide, and correction 1 would silently merge them
// into one planting — a fixture bug that reads exactly like a passing test.
let seq = 0;
const nextId = (kind) => `${kind}-${(seq += 1)}`;

// n plantings picked `days` after the observation.
function picked(n, days, over = {}) {
  return Array.from({ length: n }, () => tap({
    plant_id: nextId('pick'), first_pick_date: ymd(OBS, days), ...over,
  }));
}

// n plantings never picked, still observed at `days`.
function censored(n, days, over = {}) {
  return Array.from({ length: n }, () => tap({
    plant_id: nextId('cens'), censored_on: ymd(OBS, days), ...over,
  }));
}

// §4.4 as written: drop the censored rows, take a nearest-rank percentile of what is left.
function naiveQuantile(samples, p = REFIT_QUANTILE) {
  const days = samples.filter((s) => s.first_pick_date != null)
    .map((s) => Math.round((Date.parse(`${s.first_pick_date}T00:00:00Z`) - Date.parse(`${s.observed_on}T00:00:00Z`)) / DAY))
    .sort((a, b) => a - b);
  return days[Math.max(0, Math.ceil(p * days.length) - 1)];
}

describe('V4-DISMISSREFITSTATS-001 correction 1 — repeated dismissals are one correlated series per planting', () => {
  it('collapses every tap on one planting to ONE unit and reports taps separately', () => {
    const samples = [
      tap({ observed_on: '2026-06-21', first_pick_date: '2026-07-01' }),
      tap({ observed_on: '2026-06-01', first_pick_date: '2026-07-01' }),
      tap({ observed_on: '2026-06-11', first_pick_date: '2026-07-01' }),
    ];
    const { units } = reduceToPlantingUnits(samples);
    expect(units).toHaveLength(1);
    expect(units[0].taps).toBe(3);
  });

  it('represents the planting by its EARLIEST tap — the one not selected by the suppression constant', () => {
    // The later taps only exist because WATCH_SUPPRESS_DAYS=10 brought the row back, so their
    // intervals (10 and 20) are bounded by the constant the refit is replacing. The first is 30.
    const samples = [
      tap({ observed_on: '2026-06-01', first_pick_date: '2026-07-01' }),
      tap({ observed_on: '2026-06-11', first_pick_date: '2026-07-01' }),
      tap({ observed_on: '2026-06-21', first_pick_date: '2026-07-01' }),
    ];
    const { units } = reduceToPlantingUnits(samples);
    expect(units[0].days).toBe(30);
  });

  it('input order cannot change which tap represents the planting', () => {
    const rows = [
      tap({ observed_on: '2026-06-21', first_pick_date: '2026-07-01' }),
      tap({ observed_on: '2026-06-01', first_pick_date: '2026-07-01' }),
    ];
    expect(reduceToPlantingUnits(rows).units[0].days).toBe(30);
    expect(reduceToPlantingUnits([...rows].reverse()).units[0].days).toBe(30);
  });

  it('refuses a partition that only clears n>=20 by counting taps — §4.4 would have fitted it', () => {
    // 8 plantings, 4 taps each = 32 rows. Tap-counting says n=32 and fits; plantings say n=8.
    const samples = [];
    for (let i = 0; i < 8; i += 1) {
      for (let t = 0; t < 4; t += 1) {
        samples.push(tap({ plant_id: `p${i}`, observed_on: ymd(OBS, t * 10), first_pick_date: ymd(OBS, 60) }));
      }
    }
    expect(samples).toHaveLength(32);
    const fit = fitPartition(reduceToPlantingUnits(samples).units);
    expect(fit.n_taps).toBe(32);
    expect(fit.n_units).toBe(8);
    expect(fit.fitted).toBe(false);
    expect(fit.reason).toBe('insufficient_units');
  });

  it('drops a retracted dismissal — an undone tap is not a label', () => {
    const { units, dropped } = reduceToPlantingUnits([
      tap({ plant_id: 'a', first_pick_date: ymd(OBS, 5) }),
      tap({ plant_id: 'b', first_pick_date: ymd(OBS, 5), undone_at: '2026-06-02T00:00:00Z' }),
    ]);
    expect(units).toHaveLength(1);
    expect(units[0].plant_id).toBe('a');
    expect(dropped.retracted).toBe(1);
  });

  it('drops a pick that PRECEDES the observation instead of fitting a negative interval', () => {
    const { units, dropped } = reduceToPlantingUnits([tap({ first_pick_date: ymd(OBS, -3) })]);
    expect(units).toHaveLength(0);
    expect(dropped.pick_before_observation).toBe(1);
  });
});

describe('V4-DISMISSREFITSTATS-001 correction 2 — right-censoring', () => {
  it('keeps never-picked plantings in the risk set instead of deleting them', () => {
    const { units } = reduceToPlantingUnits(censored(6, 40), { asOf: null });
    expect(units).toHaveLength(6);
    expect(units.every((u) => u.event === false)).toBe(true);
  });

  it('the censored units change the fitted quantile — deleting them shortens it', () => {
    // 14 picked, clustered; 6 never picked but observed 60 days. §4.4 drops the 6.
    const all = [...picked(4, 5), ...picked(4, 6), ...picked(4, 7), ...picked(2, 8), ...censored(6, 60)];
    const withCensored = reduceToPlantingUnits(all).units;
    const pickedOnly = withCensored.filter((u) => u.event);

    expect(kaplanMeierQuantile(pickedOnly, REFIT_QUANTILE).days).toBe(5);
    expect(kaplanMeierQuantile(withCensored, REFIT_QUANTILE).days).toBe(6);
    // The direction the panel named: dropping censored units biases the estimate SHORT.
    expect(naiveQuantile(all)).toBe(5);
  });

  it('refuses above the ~30% ceiling and still reports the fraction that caused the refusal', () => {
    const fit = fitPartition(reduceToPlantingUnits([...picked(13, 5), ...censored(7, 40)]).units);
    expect(fit.n_units).toBe(20);
    expect(fit.censoring_fraction).toBeCloseTo(0.35, 10);
    expect(fit.censoring_fraction).toBeGreaterThan(REFIT_CENSORING_CEILING);
    expect(fit.fitted).toBe(false);
    expect(fit.reason).toBe('censoring_above_ceiling');
    expect(fit.days).toBeNull();
  });

  it('fits at exactly the ceiling — the bound is "above ~30%", not "at"', () => {
    const fit = fitPartition(reduceToPlantingUnits([...picked(14, 5), ...censored(6, 40)]).units);
    expect(fit.censoring_fraction).toBeCloseTo(0.30, 10);
    expect(fit.fitted).toBe(true);
    expect(fit.days).toBe(5);
  });

  it('reports the censoring fraction on a successful fit too, not only on refusals', () => {
    const fit = fitPartition(reduceToPlantingUnits([...picked(18, 5), ...censored(2, 40)]).units);
    expect(fit.fitted).toBe(true);
    expect(fit.censoring_fraction).toBeCloseTo(0.10, 10);
  });

  it('refuses when the survival curve never reaches the quantile rather than returning a number', () => {
    // 3 picks at day 5, 17 never picked. S plateaus at 0.85, which never falls to 0.75. Raising the
    // ceiling gets past correction 2's first gate; the KM refusal is the backstop behind it.
    const units = reduceToPlantingUnits([...picked(3, 5), ...censored(17, 40)]).units;
    expect(kaplanMeierQuantile(units, REFIT_QUANTILE)).toMatchObject({ reached: false, days: null });
    const fit = fitPartition(units, { censoringCeiling: 1 });
    expect(fit.fitted).toBe(false);
    expect(fit.reason).toBe('quantile_not_reached');
    expect(fit.days).toBeNull();
  });

  it('a censoring on the same day as an event stays in that day risk set', () => {
    // 4 events and 1 censoring at day 5, over 20 units: risk 20, not 19. S = 1 - 4/20 = 0.80.
    const units = reduceToPlantingUnits([...picked(4, 5), ...censored(1, 5), ...censored(15, 60)]).units;
    const km = kaplanMeierQuantile(units, REFIT_QUANTILE);
    expect(km.points[0]).toMatchObject({ days: 5, at_risk: 20, events: 4 });
    expect(km.points[0].survival).toBeCloseTo(0.8, 10);
  });

  it('drops a censored unit with no horizon rather than inventing one', () => {
    const { units, dropped } = reduceToPlantingUnits([tap({ censored_on: null })]);
    expect(units).toHaveLength(0);
    expect(dropped.no_censor_date).toBe(1);
    // asOf supplies the horizon the extraction query would normally carry.
    expect(reduceToPlantingUnits([tap({ censored_on: null })], { asOf: ymd(OBS, 12) }).units[0].days).toBe(12);
  });
});

describe('V4-DISMISSREFITSTATS-001 correction 3 — gate at habit level, crop only where n permits', () => {
  it('fits the habit that §4.4 per-crop gate would have left permanently unfittable', () => {
    // 20 single-habit plantings spread over 4 crops of 5. No crop ever reaches 20; the habit does.
    const samples = [];
    ['melon', 'watermelon', 'winter_squash', 'cabbage'].forEach((crop, c) => {
      for (let i = 0; i < 5; i += 1) {
        samples.push(tap({ plant_id: `${crop}-${i}`, crop_type_slug: crop, harvest_habit: 'single', first_pick_date: ymd(OBS, 8 + c) }));
      }
    });
    const fit = fitSuppressionDays(samples);
    expect(fit.ok).toBe(true);
    expect(fit.habits.single).toMatchObject({ fitted: true, n_units: 20 });
    for (const crop of ['melon', 'watermelon', 'winter_squash', 'cabbage']) {
      expect(fit.crops[crop]).toMatchObject({ fitted: false, reason: 'insufficient_units', n_units: 5 });
    }
  });

  it('emits a crop-level override where that crop alone clears the bar', () => {
    const samples = [...picked(20, 9, { crop_type_slug: 'tomato', harvest_habit: 'repeat' })];
    const fit = fitSuppressionDays(samples);
    expect(fit.crops.tomato).toMatchObject({ fitted: true, n_units: 20, days: 9 });
    expect(fit.habits.repeat).toMatchObject({ fitted: true, n_units: 20 });
  });

  it('partitions habits independently — one refusal does not suppress the other habit fit', () => {
    const samples = [
      ...picked(20, 7, { harvest_habit: 'single', crop_type_slug: 'melon' }),
      ...picked(5, 3, { harvest_habit: 'repeat', crop_type_slug: 'tomato' }),
    ];
    const fit = fitSuppressionDays(samples);
    expect(fit.habits.single.fitted).toBe(true);
    expect(fit.habits.repeat).toMatchObject({ fitted: false, reason: 'insufficient_units', n_units: 5 });
  });

  it('never pools an unlabelled habit into a partition', () => {
    const fit = fitSuppressionDays([
      ...picked(20, 7, { harvest_habit: null }),
      ...picked(3, 7, { harvest_habit: 'single' }),
    ]);
    expect(fit.habits.single.n_units).toBe(3);
    expect(Object.keys(fit.habits)).toEqual(['single']);
  });

  it('the bar is the shared REFIT_MIN_UNITS constant, read in plantings', () => {
    expect(REFIT_MIN_UNITS).toBe(20);
    const below = fitPartition(reduceToPlantingUnits(picked(REFIT_MIN_UNITS - 1, 5)).units);
    const at = fitPartition(reduceToPlantingUnits(picked(REFIT_MIN_UNITS, 5)).units);
    expect(below.fitted).toBe(false);
    expect(at.fitted).toBe(true);
  });
});

describe('V4-DISMISSREFITSTATS-001 — whole-fit guards', () => {
  it('refuses to pool samples spanning two model generations', () => {
    const fit = fitSuppressionDays([
      ...picked(20, 5, { model_version: 'watch-v1' }),
      ...picked(20, 30, { model_version: 'watch-v2' }),
    ]);
    expect(fit.ok).toBe(false);
    expect(fit.reason).toBe('mixed_model_version');
    expect(fit.model_versions).toEqual(['watch-v1', 'watch-v2']);
    expect(fit.habits).toEqual({});
  });

  it('carries the single model_version through on a clean fit', () => {
    const fit = fitSuppressionDays(picked(20, 5));
    expect(fit.ok).toBe(true);
    expect(fit.model_version).toBe('watch-v1');
  });

  it('the fitted quantile is §4.4 p25', () => {
    expect(REFIT_QUANTILE).toBe(0.25);
    expect(fitSuppressionDays(picked(20, 5)).quantile).toBe(0.25);
  });

  it('handles empty and null input without throwing', () => {
    expect(reduceToPlantingUnits(null)).toEqual({ units: [], dropped: {} });
    expect(fitSuppressionDays([])).toMatchObject({ ok: true, habits: {}, crops: {}, n_units: 0 });
    expect(kaplanMeierQuantile([])).toMatchObject({ reached: false, days: null });
  });
});
