// ledger.test.js — V4-WATERMATH-001 F2, the Water Ledger fold at unit level.
// Canon: watering-cadence-math-design-V100-20260812.md Part 2 (formulas), Part 5 (test families).
// Engine-level acceptance + parity goldens live in ledger-engine.test.js; run()-level reachability
// (zero-queries flag OFF) lives in ledger-run.test.js. Everything here is pure-function arithmetic
// against hand-computed expectations, so a red test names the exact op that moved.
import { describe, it, expect } from 'vitest';
import L from './ledger.js';
import LP from './ledgerParams.js';
import engine from './engine.js';
import handler from './handler.js';

const {
  foldLedger, buildLedgerOpts, computeConfidence, exposureClass, vesselProfile,
  parseContainerGal, etMidnightMs, addDays, rainDepthClass,
} = L;

const H = 3600000;
const TODAY = '2026-08-12';
const WSTART = addDays(TODAY, -30);            // 2026-07-13
const NOW = etMidnightMs(TODAY) + 2 * H;       // the 02:00 nightly slot
const at = (d, h, m = 0) => etMidnightMs(d) + h * H + m * 60000;

// Flat 30-day weather: every settled day's ET0 equals its month's fixed reference -> ratio exactly
// 1.0; with a trough (class 1.0) at 5 gal (mid bucket 1.0) demand is exactly 1.0 cadence-day per
// calendar day, so every expected D below is hand-computable calendar arithmetic.
function flatWeather({ et0ByMonth = { 7: LP.ET0_REF_MONTHLY[7], 8: LP.ET0_REF_MONTHLY[8] }, tmax = 75,
  precipOn = {}, from = WSTART, to = addDays(TODAY, -1), skip = [] } = {}) {
  const rows = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (skip.includes(d)) continue;
    rows.push({ date: d, et0_in: et0ByMonth[+d.slice(5, 7)], tmax_f: precipOn[d + '_tmax'] ?? tmax,
      tmin_f: 60, precip_in: precipOn[d] ?? 0 });
  }
  return rows;
}

function mk({ wi = 4, thr = wi, vessel = vesselProfile('trough', '5 gal'), rainTier = 'intermediate',
  events = [], weather = flatWeather(), today = TODAY, nowMs = NOW, exposure = 'outdoor',
  transplantAt = null, todayEt0 = null, todayTmax = null } = {}) {
  const lo = buildLedgerOpts({ weatherDaily: weather, eventsByPlant: {}, today, nowMs });
  return foldLedger({ wiEff: wi, thr, events, weatherByDate: lo.weatherByDate,
    weatherRowCount: lo.weatherRowCount, todayStr: today, effNowMs: lo.effNowMs,
    todayEt0, todayTmax, exposure, vessel, rainTier, transplantAt });
}
const W = (d, h, depth = null, id = 'w') => ({ id, t: at(d, h), type: 'watering', depth });
const PRIMER = W('2026-07-14', 12, null, 'primer');   // D0=4 +1.5d = 5.5 <= 1.5x4 -> clean reset to 0

// ── lockstep pins: constants mirrored across modules must be equal ────────────────────────────────
describe('params lockstep (mirrored constants cannot drift)', () => {
  it('RAIN_DAY ia/hold mirror engine.RAIN_TIER_IA/HOLD exactly', () => {
    expect(LP.RAIN_DAY.ia).toEqual(engine.RAIN_TIER_IA);
    expect(LP.RAIN_DAY.hold).toEqual(engine.RAIN_TIER_HOLD);
  });
  it('rainDepthTierFor mirrors rainTierFor on every KNOWN vessel, and diverges ONLY on unknown', () => {
    // Two resolvers exist because the two tables disagree on which row is strictest. They must stay
    // identical everywhere else, and rainTierFor's unknown answer must NOT drift: it keys the live
    // flag-OFF IA/hold path, where 'small_fast' is still the correct fail-safe.
    for (const ct of Object.keys(engine.RAIN_VESSEL_TIER)) {
      expect(engine.rainDepthTierFor(ct), ct).toBe(engine.rainTierFor(ct));
    }
    for (const ct of [null, undefined, '', 'mystery_pot']) {
      expect(engine.rainTierFor(ct), `${ct} (live)`).toBe('small_fast');
      expect(engine.rainDepthTierFor(ct), `${ct} (F2)`).toBe('unknown');
    }
  });
  it('transplant carve-out mirrors engine; fold window mirrors handler', () => {
    expect(LP.TRANSPLANT_CARVEOUT_DAYS).toBe(engine.TRANSPLANT_CARVEOUT_DAYS);
    expect(LP.WINDOW_DAYS).toBe(handler.WEATHER_DAILY_WINDOW_DAYS);
  });
});

// ── ET civil time (epoch-ms based, DST pinned — canon "Fractional time") ─────────────────────────
describe('ET time helpers', () => {
  it('DST: fall-back day is 25h, spring-forward day is 23h', () => {
    expect((etMidnightMs('2026-11-02') - etMidnightMs('2026-11-01')) / H).toBe(25);
    expect((etMidnightMs('2026-03-09') - etMidnightMs('2026-03-08')) / H).toBe(23);
  });
  it('midnight round-trips through etParts as 00:00 of the same civil date', () => {
    for (const d of ['2026-08-12', '2026-11-01', '2026-03-08', '2026-01-01']) {
      expect(L.etParts(etMidnightMs(d))).toEqual({ date: d, msOfDay: 0 });
    }
  });
});

// ── container_size parse table (canon Part 5) ─────────────────────────────────────────────────────
describe('parseContainerGal', () => {
  it('parses the live vocabulary, including the "15 gall" typo', () => {
    expect(parseContainerGal('5 gal')).toBe(5);
    expect(parseContainerGal('15 gall')).toBe(15);
    expect(parseContainerGal('0.5qt')).toBe(0.125);
    expect(parseContainerGal('2 L')).toBeCloseTo(0.528, 2);
    expect(parseContainerGal('32 oz')).toBe(0.25);
    expect(parseContainerGal('10"')).toBe(3);          // nursery diameter -> volume lookup
    expect(parseContainerGal('3 in')).toBe(0.06);      // sub-4in = cell scale
    expect(parseContainerGal('6x2 ft')).toBe(LP.SIZE_BUCKETS.bedGal);
  });
  it('unparseable/ambiguous -> null (unsized bucket + LOW driver), never a guess', () => {
    for (const s of ['nonsense', '', null, undefined, 'gal', '0 gal', 'big']) {
      expect(parseContainerGal(s)).toBeNull();
    }
  });
});

describe('vesselProfile', () => {
  it('banking is in-ground class or >=15-gal ONLY (canon Decision 4)', () => {
    expect(vesselProfile('in_ground', null).banks).toBe(true);
    expect(vesselProfile('raised_bed', null).banks).toBe(true);
    expect(vesselProfile('fabric_bag', '20 gal').banks).toBe(true);
    expect(vesselProfile('fabric_bag', '7 gal').banks).toBe(false);
    expect(vesselProfile('pot', null).banks).toBe(false);
  });
  it('tray class is its own class; vessel-known needs type + (implied or parsed) size', () => {
    expect(vesselProfile('tray_cell', null).tray).toBe(true);
    expect(vesselProfile('trough', null).known).toBe(true);        // size implied by type
    expect(vesselProfile('pot', null).known).toBe(false);          // rigid pot needs a size
    expect(vesselProfile('pot', '2 gal').known).toBe(true);
    expect(vesselProfile(null, '5 gal').known).toBe(false);        // no type is never known
  });
});

describe('exposureClass (three-way split, resolved-flags only)', () => {
  it('maps the resolved tri-state; unknown -> covered (full demand, rain-exempt)', () => {
    expect(exposureClass({ rain_exposed_resolved: true })).toBe('outdoor');
    expect(exposureClass({ frost_covered_resolved: true })).toBe('indoor');
    expect(exposureClass({ loc_cover_state: true })).toBe('indoor');
    expect(exposureClass({})).toBe('covered');
    expect(exposureClass({ rain_exposed_resolved: false, frost_covered_resolved: false })).toBe('covered');
  });
  it('explicit rain_exposed override wins in both directions', () => {
    expect(exposureClass({ rain_exposed: true, frost_covered_resolved: true })).toBe('outdoor');
    expect(exposureClass({ rain_exposed: false, rain_exposed_resolved: true })).toBe('covered');
  });
});

// ── demand branches ───────────────────────────────────────────────────────────────────────────────
describe('demand (through the fold)', () => {
  it('flat ref weather + trough/5gal accrues exactly 1.0/day: no events -> D = wi + 30d + 2h', () => {
    const f = mk({ events: [] });
    expect(f.d).toBeCloseTo(4 + 30 + 2 / 24, 2);
    expect(f.due).toBe(true);
    expect(f.overdueBy).toBe(30);                       // floor((D-thr)/1.0) — integer calendar days
    expect(Number.isInteger(f.overdueBy)).toBe(true);
  });
  it('(e) fixed monthly reference: day 14 of a flat >=88F heat wave STILL reads demand > 1', () => {
    // The rolling-median failure mode this design killed: by day ~7-10 a rolling ref re-centers and
    // demand collapses to 1.0. The fixed ref keeps the whole wave elevated.
    const hot = flatWeather().map((r) => ({ ...r, et0_in: 0.30, tmax_f: 92 }));
    const f = mk({ weather: hot, todayEt0: 0.30, todayTmax: 92 });
    const ratio = f.drivers.find((d) => d.factor === 'et0_ratio').value;
    expect(ratio).toBeCloseTo(0.30 / LP.ET0_REF_MONTHLY[8], 2);
    expect(ratio).toBeGreaterThan(1.5);
    expect(f.demandToday).toBeGreaterThan(1);
  });
  it('ratio clamps at 2.0 however extreme the ET0', () => {
    const f = mk({ weather: flatWeather(), todayEt0: 0.9 });
    expect(f.drivers.find((d) => d.factor === 'et0_ratio').value).toBe(LP.DEMAND_CLAMP.max);
  });
  it('(f) missing weather days -> demand exactly 1.0 for those days, never NaN', () => {
    // All present days at ratio 2.0; three days missing. The gap days must contribute 1.0/day,
    // so D differs from the no-gap fold by exactly 3 x (2.0 - 1.0).
    const hot = { et0ByMonth: { 7: LP.ET0_REF_MONTHLY[7] * 2, 8: LP.ET0_REF_MONTHLY[8] * 2 } };
    const full = mk({ weather: flatWeather(hot), todayEt0: LP.ET0_REF_MONTHLY[8] * 2 });
    const gappy = mk({ weather: flatWeather({ ...hot, skip: ['2026-08-05', '2026-08-06', '2026-08-07'] }),
      todayEt0: LP.ET0_REF_MONTHLY[8] * 2 });
    expect(full.d - gappy.d).toBeCloseTo(3, 2);
    expect(Number.isFinite(gappy.d)).toBe(true);
    expect(gappy.drivers.find((d) => d.factor === 'weather_missing_days').value).toBe(3);
  });
  it('space-degenerate (<7 rows): demand pinned flat 1.0 — even for a hot fabric bag — + LOW driver', () => {
    const f = mk({ vessel: vesselProfile('fabric_bag', '2 gal'), rainTier: 'small_fast',
      weather: flatWeather({ from: addDays(TODAY, -5) }).map((r) => ({ ...r, et0_in: 0.30, tmax_f: 95 })),
      todayEt0: 0.30, todayTmax: 95 });
    expect(f.spaceDegenerate).toBe(true);
    expect(f.demandToday).toBe(1.0);
    expect(f.drivers.some((d) => d.factor === 'weather_degraded')).toBe(true);
  });
  it('winter mode: ref below 0.04 pins the ratio at the clamp floor instead of dividing', () => {
    const dec = [];
    for (let d = '2026-11-15'; d <= '2026-12-14'; d = addDays(d, 1)) {
      dec.push({ date: d, et0_in: 0.01, tmax_f: 35, tmin_f: 20, precip_in: 0 });
    }
    const f = mk({ today: '2026-12-15', nowMs: etMidnightMs('2026-12-15') + 2 * H, weather: dec, todayEt0: 0.01 });
    expect(f.drivers.find((d) => d.factor === 'et0_ratio').value).toBe(LP.DEMAND_CLAMP.min);
    expect(f.d).toBeCloseTo(4 + (30 + 2 / 24) * 0.5, 1);
  });
  it('indoor is flat 1.0 (demand modeling deferred); covered gets FULL ET demand', () => {
    const hot = flatWeather().map((r) => ({ ...r, et0_in: 0.30 }));
    const indoor = mk({ weather: hot, exposure: 'indoor', todayEt0: 0.30 });
    const covered = mk({ weather: hot, exposure: 'covered', todayEt0: 0.30 });
    expect(indoor.demandToday).toBe(1.0);
    expect(covered.demandToday).toBeGreaterThan(1.5);   // the most under-warned class if modeled flat
  });
  it('establishment x1.3 for 14 days after a real transplant', () => {
    const f = mk({ events: [], transplantAt: addDays(TODAY, -5), todayEt0: LP.ET0_REF_MONTHLY[8] });
    expect(f.drivers.find((d) => d.factor === 'stage').value).toBe(LP.STAGE.establishmentFactor);
    const done = mk({ events: [], transplantAt: addDays(TODAY, -20), todayEt0: LP.ET0_REF_MONTHLY[8] });
    expect(done.drivers.find((d) => d.factor === 'stage')).toBeUndefined();
  });
});

// ── credit ops (the fold walk) ────────────────────────────────────────────────────────────────────
describe('fold ops', () => {
  it('Normal resets to 0; final D is pure fractional accrual since the watering', () => {
    // primer Jul 14 12:00 -> Aug 12 02:00 = 28d14h = 28.583
    expect(mk({ events: [PRIMER] }).d).toBeCloseTo(28.583, 2);
    // second Normal Aug 10 12:00: D=27 > 1.5x4 -> container partial-rewet hedge 0.25xwi=1, +1.583
    expect(mk({ events: [PRIMER, W('2026-08-10', 12, null, 'n2')] }).d).toBeCloseTo(2.583, 2);
  });
  it('(a) fractional time alone: a 19:00 Normal on wi=1 is NOT due at the 02:00 run', () => {
    const f = mk({ wi: 1, thr: 1, events: [W('2026-08-11', 19)] });
    expect(f.due).toBe(false);                          // legacy dW>=wi would say due (dW=1)
  });
  it('in-ground Normal on a long-dry profile hedges to min(D-wi, 0.5wi) — top-wetting, not root zone', () => {
    const f = mk({ vessel: vesselProfile('in_ground', null), rainTier: 'in_ground',
      events: [PRIMER, W('2026-08-10', 12, null, 'n2')] });
    // demand 0.85/day; hedge cap 0.5x4=2; final 2 + 1.583x0.85
    expect(f.d).toBeCloseTo(2 + 1.583 * 0.85, 2);
  });
  it('(b) Deep banks in-ground (-0.15wi, floored -0.25wi) and diverges from Normal by hedge+bank', () => {
    const ig = { vessel: vesselProfile('in_ground', null), rainTier: 'in_ground' };
    const deep = mk({ ...ig, events: [PRIMER, W('2026-08-10', 12, 'deep', 'd2')] });
    const norm = mk({ ...ig, events: [PRIMER, W('2026-08-10', 12, null, 'n2')] });
    expect(deep.d).toBeCloseTo(-0.6 + 1.583 * 0.85, 2); // min(D,0)-0.6, floor -1.0
    expect(norm.d - deep.d).toBeCloseTo(2.6, 2);        // hedge cap 2 + bank 0.6
  });
  it('container Deep is a FULL RESET to 0, never a bank (drained-vessel physics; BER trigger)', () => {
    const f = mk({ events: [PRIMER, W('2026-08-10', 12, 'deep', 'd2')] });  // trough 5 gal: banks=false
    expect(f.d).toBeCloseTo(1.583, 2);                  // 0 + accrual — identical to a logged rain reset
    expect(f.d).toBeGreaterThanOrEqual(0);
  });
  it('(c) Light credits 0.5wi and re-dues far earlier than Normal', () => {
    const light = mk({ events: [PRIMER, W('2026-08-10', 12, 'light', 'l2')] });
    expect(light.d).toBeCloseTo(27 - 2 + 1.583, 2);     // max(0, 27-0.5x4) + accrual
    const norm = mk({ events: [PRIMER, W('2026-08-10', 12, null, 'n2')] });
    expect(light.d).toBeGreaterThan(norm.d + 20);
  });
  it('a logged rain event keeps FULL-reset semantics (canon Decision 12)', () => {
    const f = mk({ events: [PRIMER, { id: 'r1', t: at('2026-08-10', 12), type: 'rain', depth: null }] });
    expect(f.d).toBeCloseTo(1.583, 2);
  });
  it('unknown depth strings fold as Normal (absent/historical = normal)', () => {
    const a = mk({ events: [PRIMER, W('2026-08-10', 12, 'torrential', 'x')] });
    const b = mk({ events: [PRIMER, W('2026-08-10', 12, null, 'x')] });
    expect(a.d).toBeCloseTo(b.d, 6);
  });
});

describe('rainDepthClass — measured precip -> depth class (DRG-RAINDEPTH-001)', () => {
  it('reads thresholds as LOWER BOUNDS, strongest class wins', () => {
    const t = LP.RAIN_DEPTH.intermediate;                 // light .10 / normal .30 / deep .75
    expect(rainDepthClass('intermediate', t.deep)).toBe('deep');
    expect(rainDepthClass('intermediate', t.deep - 0.001)).toBe('normal');
    expect(rainDepthClass('intermediate', t.normal)).toBe('normal');
    expect(rainDepthClass('intermediate', t.normal - 0.001)).toBe('light');
    expect(rainDepthClass('intermediate', t.light)).toBe('light');
    expect(rainDepthClass('intermediate', t.light - 0.001)).toBe(null);
  });
  it('small_fast mirrors in_ground exactly; intermediate still needs at least as much', () => {
    // 2026-08-17 field revision (Dave's own observation, overriding the estimate): his fabric bags
    // sit ON SOIL, mulched and clustered, so they retain like a bed — not like a shedding container.
    // Pinned as EQUALITY plus literals, so drifting EITHER row (or both together) fails here.
    expect(LP.RAIN_DEPTH.small_fast).toEqual({ light: 0.10, normal: 0.25, deep: 0.60 });
    for (const cls of ['light', 'normal', 'deep']) {
      expect(LP.RAIN_DEPTH.small_fast[cls], cls).toBe(LP.RAIN_DEPTH.in_ground[cls]);
      // intermediate = rigid troughs/large pots: no ground wicking, so still >= the bed row
      expect(LP.RAIN_DEPTH.intermediate[cls], cls).toBeGreaterThanOrEqual(LP.RAIN_DEPTH.in_ground[cls]);
    }
  });
  it('every tier table is strictly ordered light < normal < deep', () => {
    for (const [tier, t] of Object.entries(LP.RAIN_DEPTH)) {
      expect(t.light, tier).toBeLessThan(t.normal);
      expect(t.normal, tier).toBeLessThan(t.deep);
    }
  });
  // THE INVARIANT, not the value. The unknown row was an alias of small_fast until 2026-08-17; that
  // alias was silently falsified the moment small_fast was retuned down, and nothing failed, because
  // every guard pinned the NAME rather than the property. This asserts the property directly, so any
  // future threshold edit that inverts the fail-safe fails here regardless of which row wins.
  it('INVARIANT: the unknown-vessel row demands AT LEAST as much rain as every named tier', () => {
    for (const [tier, t] of Object.entries(LP.RAIN_DEPTH_TIERS)) {
      for (const cls of ['light', 'normal', 'deep']) {
        expect(LP.RAIN_DEPTH.unknown[cls], `${tier}.${cls}`).toBeGreaterThanOrEqual(t[cls]);
      }
    }
    // and it must be reachable: a real unknown/NULL container_type has to resolve to that row
    expect(LP.RAIN_DEPTH[engine.rainDepthTierFor(null)]).toBe(LP.RAIN_DEPTH.unknown);
    expect(LP.RAIN_DEPTH[engine.rainDepthTierFor('mystery_pot')]).toBe(LP.RAIN_DEPTH.unknown);
  });
  it('an unknown vessel gets STRICTLY less credit than a bag at the same rain (err toward watering)', () => {
    // The behavioural face of the invariant, and the case that was broken: 0.27" measured. A NULL
    // container_type must not quietly ride the bed-equivalent bag row into a Normal rewet.
    expect(rainDepthClass(engine.rainDepthTierFor(null), 0.27)).toBe('light');
    expect(rainDepthClass(engine.rainDepthTierFor('fabric_bag'), 0.27)).toBe('normal');
  });
  it('unknown tier falls back to the unknown row; zero/negative/NaN earn nothing', () => {
    // an unrecognized tier NAME (not just an unrecognized vessel) must also land on the strict row
    expect(rainDepthClass('bogus', 0.27)).toBe(rainDepthClass('unknown', 0.27));
    expect(rainDepthClass('bogus', 0.27)).not.toBe(rainDepthClass('small_fast', 0.27));
    expect(rainDepthClass('in_ground', 0.3)).toBe('normal');
    for (const bad of [0, -1, NaN, null, undefined]) expect(rainDepthClass('in_ground', bad)).toBe(null);
  });
});

describe('gauge-rain day-credits', () => {
  it('a Light-class day credits exactly LIGHT_CREDIT_WI x wi at 23:59 ET — once, not per re-test', () => {
    // 0.15" on intermediate (light 0.10, normal 0.30) -> Light. Light is SUBTRACTIVE, so a second
    // application would show as a 4-day delta: this is what pins once-per-day idempotency.
    const bare = mk({ events: [PRIMER] });
    const wet = mk({ events: [PRIMER], weather: flatWeather({ precipOn: { '2026-08-09': 0.15 } }) });
    expect(bare.d - wet.d).toBeCloseTo(LP.LIGHT_CREDIT_WI * 4, 6);   // 0.5 x wi 4 = 2, exactly once
  });
  it('a Normal-class day rewets through the SAME long-dry hedge as a Normal watering', () => {
    // 0.5" on intermediate -> Normal. D at 08-09 23:59 is ~26.5 (>> 1.5x wi), so the container
    // hedge applies: D := containerResetWi x wi = 1.0, then 2.084d of accrual.
    const wet = mk({ events: [PRIMER], weather: flatWeather({ precipOn: { '2026-08-09': 0.5 } }) });
    expect(wet.d).toBeCloseTo(LP.HEDGE.containerResetWi * 4 + 2 + 2 / 24, 2);
  });
  it('a trace under the tier light floor earns nothing', () => {
    const bare = mk({ events: [PRIMER] });
    const trace = mk({ events: [PRIMER], weather: flatWeather({ precipOn: { '2026-08-09': 0.05 } }) });
    expect(trace.d).toBeCloseTo(bare.d, 6);
  });
  it('DRG-RAINDEPTH-001: 0.21" is no longer discarded — it lands as Light on EVERY tier', () => {
    // The originating case (2026-08-17, 0.21" measured). Under the retired IA cliff this earned
    // in_ground a full 3-day hold and intermediate/small_fast exactly nothing.
    for (const [tier, vessel] of [
      ['in_ground', vesselProfile('in_ground', null)],
      ['intermediate', vesselProfile('trough', '5 gal')],
      ['small_fast', vesselProfile('fabric_bag', '5 gal')],
    ]) {
      expect(rainDepthClass(tier, 0.21)).toBe('light');
      const bare = mk({ events: [PRIMER], rainTier: tier, vessel });
      const wet = mk({ events: [PRIMER], rainTier: tier, vessel,
        weather: flatWeather({ precipOn: { '2026-08-09': 0.21 } }) });
      expect(bare.d - wet.d).toBeCloseTo(LP.LIGHT_CREDIT_WI * 4, 6);
    }
  });
  it('2026-08-17 revision: 0.30" now earns a BAG the full Normal rewet, not a Light nudge', () => {
    // Dave's field observation moved small_fast normal 0.40 -> 0.25. 0.30" measured used to land as
    // Light on a bag (a subtractive nudge) and now lands as Normal — the same class the in-ground
    // row has always given it. This is the under-crediting he reported as driving over-watering.
    // Pinned against a MANUAL Normal watering at the same instant: rain folds through the same depth
    // arithmetic, and Normal carries no bank, so the two must land identically.
    const bag = { vessel: vesselProfile('fabric_bag', '5 gal'), rainTier: 'small_fast' };
    expect(rainDepthClass('small_fast', 0.30)).toBe('normal');
    expect(rainDepthClass('small_fast', 0.30)).toBe(rainDepthClass('in_ground', 0.30));
    const t2359 = etMidnightMs('2026-08-09') + 24 * H - 60000;
    const light = mk({ ...bag, events: [PRIMER],
      weather: flatWeather({ precipOn: { '2026-08-09': 0.21 } }) });
    const normalRain = mk({ ...bag, events: [PRIMER],
      weather: flatWeather({ precipOn: { '2026-08-09': 0.30 } }) });
    const normalWater = mk({ ...bag,
      events: [PRIMER, { id: 'n1', t: t2359, type: 'watering', depth: 'normal' }] });
    expect(normalRain.d).toBeLessThan(light.d);                 // Normal beats Light: strictly more credit
    expect(normalRain.d).toBeCloseTo(normalWater.d, 6);
  });
  it('deep RAIN resets flat to 0 but NEVER banks, where a manual Deep on the same vessel does', () => {
    // The one deliberate asymmetry in applyDepth. in_ground banks; both ops land at 23:59 ET of the
    // same day, so the whole difference is the forfeited bank (deepBankWi x wi = 0.6).
    const ig = { vessel: vesselProfile('in_ground', null), rainTier: 'in_ground' };
    const deepWater = mk({ ...ig,
      events: [PRIMER, { id: 'd1', t: at('2026-08-09', 23, 59), type: 'watering', depth: 'deep' }] });
    const deepRain = mk({ ...ig, events: [PRIMER],
      weather: flatWeather({ precipOn: { '2026-08-09': 1.0 } }) });
    expect(deepRain.d - deepWater.d).toBeCloseTo(LP.BANK.deepBankWi * 4, 6);
    expect(deepRain.d).toBeGreaterThan(0);
  });
  it('(d) consecutive qualifying rain days floor D at 0 — and the planting RESURFACES after', () => {
    const soaked = {};
    for (let d = WSTART; d <= addDays(TODAY, -1); d = addDays(d, 1)) soaked[d] = 1.0;
    const rainedOut = mk({ events: [], weather: flatWeather({ precipOn: soaked }) });
    expect(rainedOut.d).toBeGreaterThanOrEqual(0);      // rain never banks negative
    expect(rainedOut.d).toBeLessThan(0.1);
    expect(rainedOut.due).toBe(false);
    const stopped = {};
    for (let d = WSTART; d <= '2026-08-05'; d = addDays(d, 1)) stopped[d] = 1.0;
    const after = mk({ events: [], weather: flatWeather({ precipOn: stopped }) });
    expect(after.d).toBeCloseTo(6.084, 1);              // Aug 5 23:59 -> Aug 12 02:00 of accrual
    expect(after.due).toBe(true);                        // structural resurfacing retires the maxdays ceiling
  });
  it('covered and indoor exposures get NO day-credits (rain-exempt)', () => {
    const soak = flatWeather({ precipOn: { '2026-08-09': 1.0 } });
    for (const exposure of ['covered', 'indoor']) {
      const bare = mk({ events: [PRIMER], exposure });
      const wet = mk({ events: [PRIMER], weather: soak, exposure });
      expect(wet.d).toBeCloseTo(bare.d, 6);
    }
  });
  it('bag >=85F DEMOTES one class (Deep -> Normal), keyed to the day\'s tmax_f', () => {
    const bag = { vessel: vesselProfile('fabric_bag', '7 gal'), rainTier: 'small_fast' };
    const cool = mk({ ...bag, events: [PRIMER],
      weather: flatWeather({ precipOn: { '2026-08-09': 1.0, '2026-08-09_tmax': 84.9 } }) });
    const hot = mk({ ...bag, events: [PRIMER],
      weather: flatWeather({ precipOn: { '2026-08-09': 1.0, '2026-08-09_tmax': 85 } }) });
    // 1.0" > small_fast deep 0.60. Cool: Deep -> 0 (a 7-gal bag does not bank). Hot: demoted to
    // Normal -> the container hedge, 0.25 x wi = 1.0. The 0.1F demand-ramp delta is noise here.
    expect(hot.d - cool.d).toBeCloseTo(LP.HEDGE.containerResetWi * 4, 1);
  });
  it('a Light-class day on a hot bag demotes off the bottom to nothing', () => {
    const bag = { vessel: vesselProfile('fabric_bag', '7 gal'), rainTier: 'small_fast' };
    const bare = mk({ ...bag, events: [PRIMER], weather: flatWeather({ precipOn: { '2026-08-09_tmax': 85 } }) });
    const hot = mk({ ...bag, events: [PRIMER],
      weather: flatWeather({ precipOn: { '2026-08-09': 0.2, '2026-08-09_tmax': 85 } }) });
    expect(hot.d).toBeCloseTo(bare.d, 6);
  });
  it('fresh small-vessel transplant keeps the carve-out: no credit inside 21 days', () => {
    const cup = { vessel: vesselProfile('solo_cup', '0.5 qt'), rainTier: 'small_fast', wi: 1, thr: 1 };
    const bare = mk({ ...cup, events: [PRIMER], transplantAt: '2026-08-01' });
    const wet = mk({ ...cup, events: [PRIMER], transplantAt: '2026-08-01',
      weather: flatWeather({ precipOn: { '2026-08-09': 1.0 } }) });
    expect(wet.d).toBeCloseTo(bare.d, 6);
  });
});

describe('moisture check ("Not thirsty") — the snooze', () => {
  it('caps D at thr - max(0.5wi, demand): survives to at least tomorrow\'s run', () => {
    const chk = { id: 'c1', t: at('2026-08-11', 15), type: 'moisture_check' };
    const f = mk({ events: [PRIMER, chk] });
    expect(f.d).toBeCloseTo(2 + 11 / 24, 2);            // capped at 4-max(2,1)=2, +11h accrual
    expect(f.due).toBe(false);
    // tomorrow's 02:00 run: still under threshold
    const tomorrow = mk({ events: [PRIMER, chk], today: addDays(TODAY, 1),
      nowMs: etMidnightMs(addDays(TODAY, 1)) + 2 * H,
      weather: flatWeather({ to: TODAY }) });
    expect(tomorrow.due).toBe(false);
    expect(tomorrow.d).toBeCloseTo(2 + (24 + 11) / 24, 2);
  });
  it('is idempotent within a day: a second tap is a no-op, not a second credit', () => {
    const one = mk({ events: [PRIMER, { id: 'c1', t: at('2026-08-11', 15), type: 'moisture_check' }] });
    const two = mk({ events: [PRIMER, { id: 'c1', t: at('2026-08-11', 15), type: 'moisture_check' },
      { id: 'c2', t: at('2026-08-11', 15, 5), type: 'moisture_check' }] });
    expect(two.d).toBeCloseTo(one.d, 2);
  });
  it('never banks negative: wi=1 in a 2x-demand heat wave floors the snooze target at 0', () => {
    const hot = flatWeather().map((r) => ({ ...r, et0_in: 0.40, tmax_f: 95 }));
    const f = mk({ wi: 1, thr: 1, vessel: vesselProfile('fabric_bag', '2 gal'), rainTier: 'small_fast',
      weather: hot, todayEt0: 0.40, todayTmax: 95,
      events: [PRIMER, { id: 'c1', t: at('2026-08-11', 15), type: 'moisture_check' }] });
    expect(f.d).toBeGreaterThanOrEqual(0);
  });
  it('FOLD DETERMINISM: at the same instant, moisture_check applies BEFORE the rain day-credit', () => {
    // check at exactly 23:59 ET of a qualifying rain day. Ordered check->credit: cap to 2, then -2
    // -> 0 (+2.08 accrual = not due). Ordered credit->check the same inputs land at 4.08 = DUE.
    // This pins the canon (timestamp, type-priority, id) ordering with a verdict-flipping case.
    const t2359 = etMidnightMs('2026-08-09') + 24 * H - 60000;
    const f = mk({ events: [PRIMER, { id: 'c1', t: t2359, type: 'moisture_check' }],
      weather: flatWeather({ precipOn: { '2026-08-09': 0.5 } }) });
    expect(f.d).toBeCloseTo(2.084, 2);
    expect(f.due).toBe(false);
  });
});

describe('timeline placement', () => {
  it('date-only (exact-ET-midnight) events reposition to 12:00 ET', () => {
    const dateOnly = mk({ events: [PRIMER, { id: 'n2', t: etMidnightMs('2026-08-10'), type: 'watering', depth: null }] });
    const noon = mk({ events: [PRIMER, W('2026-08-10', 12, null, 'n2')] });
    expect(dateOnly.d).toBeCloseTo(noon.d, 6);
  });
  it('events outside [window start, effNow] are ignored', () => {
    const f = mk({ events: [
      { id: 'old', t: at('2026-06-01', 12), type: 'watering', depth: null },      // pre-window
      { id: 'future', t: at('2026-08-12', 9), type: 'watering', depth: null },    // after the 02:00 run
    ] });
    expect(f.d).toBeCloseTo(4 + 30 + 2 / 24, 2);        // identical to the no-events fold
  });
});

describe('computeConfidence (canon tier table)', () => {
  const base = { via: 'db', vesselKnown: true, weatherOk: true, snoozeCount: 0, trayUnprofiled: false };
  it('researched + known vessel + weather -> HIGH; one missing input -> MEDIUM; two -> LOW', () => {
    expect(computeConfidence(base)).toBe('HIGH');
    expect(computeConfidence({ ...base, vesselKnown: false })).toBe('MEDIUM');
    expect(computeConfidence({ ...base, weatherOk: false })).toBe('MEDIUM');
    expect(computeConfidence({ ...base, vesselKnown: false, weatherOk: false })).toBe('LOW');
  });
  it('bundled per-variety needs a known vessel for MEDIUM; genus/default are LOW (never confident guesses)', () => {
    expect(computeConfidence({ ...base, via: 'variety:Cayenne' })).toBe('MEDIUM');
    expect(computeConfidence({ ...base, via: 'variety:Cayenne', vesselKnown: false })).toBe('LOW');
    expect(computeConfidence({ ...base, via: 'genus:Capsicum' })).toBe('LOW');
    expect(computeConfidence({ ...base, via: 'default' })).toBe('LOW');
  });
  it('unprofiled tray class is LOW outright; >=2 snoozes demote a tier regardless of provenance', () => {
    expect(computeConfidence({ ...base, trayUnprofiled: true })).toBe('LOW');
    expect(computeConfidence({ ...base, snoozeCount: 2 })).toBe('MEDIUM');
    expect(computeConfidence({ ...base, via: 'variety:X', snoozeCount: 2 })).toBe('LOW');
  });
});
