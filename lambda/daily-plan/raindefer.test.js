// Forecast-aware watering deferral — the 'incoming_dry' and 'soon' branches (Dave 2026-09-13).
//
// 'incoming_dry' answers the question he actually asked: "if we need 0.5+ right now, but tomorrow we
// expect an inch, should we really give a moderate soak today?" The pre-existing 'incoming' branch is that
// rule EXCEPT for a `soakBasis >= SOAK_WET_FLOOR_IN` already-wet prerequisite — and his scenario is by
// construction DRY, which is exactly when that branch declines.
//
// 'soon' answers "in the next few hours, is it going to give us another quarter inch?" — the rest-of-day
// sum cannot, because at 07:00 it reports seventeen hours of possibility.
//
// THE MOST IMPORTANT TESTS HERE ARE THE FLAG-OFF ONES. Both branches ship inert; if flag-off is not
// byte-identical the 25 committed parity goldens are the blast radius, and a suppression branch that
// silently arms itself decides whether a thirsty plant gets skipped.
import { describe, it, expect } from 'vitest';
import engine from './engine.js';
import THRESHOLDS from './wateringThresholds.json';

const { saturationSuppressed } = engine;
const { SOAK_FCST_QPF_IN, SOAK_FCST_POP_PCT, SOAK_CAP_IN, SOAK_WET_FLOOR_IN, SOON_QPF_IN } = THRESHOLDS;

// A DRY planting: nothing measured in the media. recent + observed = 0, well under SOAK_WET_FLOOR_IN.
const dry = (over) => ({
  recent_precip_in: 0, today_observed_in: 0, today_remaining_in: 0, today_precip_in: 0, today_pop: 0,
  tomorrow_precip_in: 0, tomorrow_pop: null, ...over,
});
const ON = { todayAware: true, deferDry: true, soonAware: true };

describe('flag-OFF inertness — the blast radius is 25 parity goldens', () => {
  const wouldFire = dry({ tomorrow_precip_in: 2.0, tomorrow_pop: 95, today_next_in: 1.0, today_pop: 95 });
  it('both branches OFF: a hydrology that would trip BOTH suppresses nothing', () => {
    expect(saturationSuppressed('outdoor', wouldFire, { todayAware: true })).toBeNull();
  });
  it('opts omitted entirely (an un-updated caller) is the same', () => {
    expect(saturationSuppressed('outdoor', wouldFire, {})).toBeNull();
    expect(saturationSuppressed('outdoor', wouldFire, { todayAware: true, deferDry: false, soonAware: false })).toBeNull();
  });
  it('each flag arms ONLY its own branch', () => {
    expect(saturationSuppressed('outdoor', wouldFire, { todayAware: true, deferDry: true })?.kind).toBe('incoming_dry');
    expect(saturationSuppressed('outdoor', wouldFire, { todayAware: true, soonAware: true })?.kind).toBe('soon');
  });
});

describe("'incoming_dry' — tomorrow's rain may defer a DRY planting", () => {
  it('fires on dry media at the SAME bars the wet-media branch uses', () => {
    const hy = dry({ tomorrow_precip_in: SOAK_FCST_QPF_IN, tomorrow_pop: SOAK_FCST_POP_PCT });
    const out = saturationSuppressed('outdoor', hy, ON);
    expect(out).toMatchObject({ kind: 'incoming_dry', fq: SOAK_FCST_QPF_IN, pop: SOAK_FCST_POP_PCT });
  });

  it('THE GAP IT EXISTS TO CLOSE: identical hydrology suppresses nothing with the flag off', () => {
    const hy = dry({ tomorrow_precip_in: 1.0, tomorrow_pop: 90 });
    expect(saturationSuppressed('outdoor', hy, { todayAware: true })).toBeNull();
    expect(saturationSuppressed('outdoor', hy, ON)?.kind).toBe('incoming_dry');
  });

  it('does not steal the wet-media case — that still reports as plain incoming', () => {
    // soakBasis >= SOAK_WET_FLOOR_IN, so 'incoming' is reached first and its kind must survive.
    const wet = dry({ recent_precip_in: SOAK_WET_FLOOR_IN, tomorrow_precip_in: 1.0, tomorrow_pop: 90 });
    expect(saturationSuppressed('outdoor', wet, ON)?.kind).toBe('incoming');
  });

  it('never outranks the measured soak cap', () => {
    const soaked = dry({ recent_precip_in: SOAK_CAP_IN, tomorrow_precip_in: 2.0, tomorrow_pop: 99 });
    expect(saturationSuppressed('outdoor', soaked, ON)?.kind).toBe('soak');
  });

  // FAIL CLOSED ON A NULL PoP — the one place this deliberately diverges from 'incoming', which accepts
  // pop==null. An already-wet planting can wait for the next evaluation; a dry one cannot be deferred on
  // an amount with no confidence attached.
  it('FAILS CLOSED on a null PoP, unlike the wet-media branch', () => {
    const noPop = dry({ tomorrow_precip_in: 3.0, tomorrow_pop: null });
    expect(saturationSuppressed('outdoor', noPop, ON)).toBeNull();
    // Same null PoP, but already wet -> the legacy branch still fires. Proves the divergence is real
    // and scoped, not a blanket tightening.
    const wetNoPop = dry({ recent_precip_in: SOAK_WET_FLOOR_IN, tomorrow_precip_in: 3.0, tomorrow_pop: null });
    expect(saturationSuppressed('outdoor', wetNoPop, ON)?.kind).toBe('incoming');
  });

  it('respects both bars independently', () => {
    expect(saturationSuppressed('outdoor', dry({ tomorrow_precip_in: SOAK_FCST_QPF_IN - 0.01, tomorrow_pop: 99 }), ON)).toBeNull();
    expect(saturationSuppressed('outdoor', dry({ tomorrow_precip_in: 5.0, tomorrow_pop: SOAK_FCST_POP_PCT - 1 }), ON)).toBeNull();
  });

  it('covered/indoor is never suppressed — it never got the rain', () => {
    const hy = dry({ tomorrow_precip_in: 2.0, tomorrow_pop: 95 });
    expect(saturationSuppressed('none', hy, ON)).toBeNull();
  });
});

describe("'soon' — the next few hours", () => {
  it('fires on a concentrated near-term shower the rest-of-day bar would miss', () => {
    // today_remaining_in is BELOW the today bar, so only 'soon' can catch this.
    const hy = dry({ today_next_in: SOON_QPF_IN, today_remaining_in: SOAK_FCST_QPF_IN - 0.1, today_pop: SOAK_FCST_POP_PCT });
    expect(saturationSuppressed('outdoor', hy, ON)).toMatchObject({ kind: 'soon', fq: SOON_QPF_IN });
  });

  it('a quarter inch clears every per-tier initial abstraction, which is why 0.25 is the bar', () => {
    for (const ia of Object.values(engine.RAIN_TIER_IA ?? {})) expect(SOON_QPF_IN).toBeGreaterThanOrEqual(ia);
  });

  it('respects its amount bar and needs a PoP floor', () => {
    expect(saturationSuppressed('outdoor', dry({ today_next_in: SOON_QPF_IN - 0.01, today_pop: 99 }), ON)).toBeNull();
    expect(saturationSuppressed('outdoor', dry({ today_next_in: 1.0, today_pop: SOAK_FCST_POP_PCT - 1 }), ON)).toBeNull();
  });

  it('A MISSING near-term figure is not "no rain soon" — it suppresses nothing', () => {
    // station.js returns null (never 0) when the hourly grid cannot support an answer. Reading that as
    // zero would be harmless here, but reading it as a FIRE would skip a thirsty plant on absent data.
    expect(saturationSuppressed('outdoor', dry({ today_next_in: null, today_pop: 99 }), ON)).toBeNull();
    expect(saturationSuppressed('outdoor', dry({ today_pop: 99 }), ON)).toBeNull();
  });

  it('is ordered last — it never pre-empts a branch acting on measured water', () => {
    const soaked = dry({ recent_precip_in: SOAK_CAP_IN, today_next_in: 1.0, today_pop: 99 });
    expect(saturationSuppressed('outdoor', soaked, ON)?.kind).toBe('soak');
  });
});

describe('reason strings — the user\'s only explanation for a skipped plant', () => {
  const { satReason } = engine;
  it('each kind gets its OWN sentence', () => {
    expect(satReason({ kind: 'incoming_dry', fq: 1.0, pop: 90 })).toMatch(/expected tomorrow.*90%/);
    expect(satReason({ kind: 'soon', fq: 0.3, pop: 80 })).toMatch(/within a few hours.*80%/);
    expect(satReason({ kind: 'incoming', fq: 1.0, pop: 90 })).toMatch(/already-wet media/);
    expect(satReason({ kind: 'today', fq: 0.6, pop: 70 })).toMatch(/falling today/);
    expect(satReason({ kind: 'soak', wp: 1.4 })).toMatch(/saturated/);
  });
  // The regression this helper was extracted to prevent: the old inline ternary's trailing `else`
  // assumed 'incoming', so a new kind printed "already-wet media" over a DRY deferral — asserting the
  // exact opposite of the reason the plant was skipped.
  it('a dry deferral NEVER claims the media is already wet', () => {
    expect(satReason({ kind: 'incoming_dry', fq: 1.0, pop: 90 })).not.toMatch(/already-wet/);
    expect(satReason({ kind: 'soon', fq: 0.3, pop: 80 })).not.toMatch(/already-wet/);
  });
  it('an unknown kind degrades to a truthful generic, not a confident wrong one', () => {
    const r = satReason({ kind: 'something_new', pop: 55 });
    expect(r).toMatch(/rain expected/);
    expect(r).not.toMatch(/already-wet|falling today|saturated/);
  });
});

describe('subordination — a forecast busts, measured water does not', () => {
  it('both new kinds are enrolled as FORECAST kinds alongside today', () => {
    // Membership is what makes them yield to freshTransplant / bagHeatGate in generatePlanForUser. A new
    // forecast branch that forgets to enrol silently gains the right to starve a fresh transplant.
    for (const k of ['today', 'incoming_dry', 'soon']) expect(engine.FORECAST_SAT_KINDS.has(k)).toBe(true);
  });
  it("'soak' and 'incoming' are NOT subordinate — they rest on measured water", () => {
    for (const k of ['soak', 'incoming']) expect(engine.FORECAST_SAT_KINDS.has(k)).toBe(false);
  });
});
