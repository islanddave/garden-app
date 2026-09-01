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

// Flat 30-day weather: every settled day's ET0 equals the ONE site reference -> ratio exactly 1.0;
// with a trough (class 1.0) at 5 gal (mid bucket 1.0) demand is exactly 1.0 cadence-day per calendar
// day, so every expected D below is hand-computable calendar arithmetic. `et0` is a scalar, not a
// per-month map — BUG-ETNOAMPLITUDE-001 retired the per-month denominator, and a per-month fixture
// knob would let the same defect back in through the test data.
function flatWeather({ et0 = LP.ET0_REF_PEAK, tmax = 75,
  precipOn = {}, from = WSTART, to = addDays(TODAY, -1), skip = [] } = {}) {
  const rows = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (skip.includes(d)) continue;
    rows.push({ date: d, et0_in: et0, tmax_f: precipOn[d + '_tmax'] ?? tmax,
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
  it('rainDepthTierFor mirrors rainTierFor except on the ONE declared divergence (the fallback)', () => {
    // Two resolvers still exist because the two tables disagree on which row is the FAIL-SAFE:
    // RAIN_DEPTH has an explicit 'unknown' row, RAIN_TIER_IA/HOLD does not and uses 'small_fast'.
    // REWRITTEN by BUG-RAINCREDITLIVEPATH-001. This block previously pinned the OPPOSITE of the
    // shipped behaviour: it asserted the legacy resolver must NOT learn 'fabric_ground' and that the
    // three engine tables must NOT carry that key. Its stated reason was that the name "would read as
    // undefined on the live path" — that hazard is what the patch removes by ADDING the row to all
    // three tables, so the guard is re-pointed at the same hazard rather than weakened: the size-gated
    // fabric_bag answer is now pinned IDENTICAL across both resolvers, and every tier name either
    // resolver can return is pinned to exist in every table that gets keyed by it.
    for (const ct of Object.keys(engine.RAIN_VESSEL_TIER)) {
      expect(engine.rainDepthTierFor(ct, 10), ct).toBe(engine.rainTierFor(ct, 10));
      expect(engine.rainDepthTierFor(ct, null), `${ct} unsized`).toBe(engine.rainTierFor(ct, null));
      expect(engine.rainDepthTierFor(ct, 0.06), `${ct} tiny`).toBe(engine.rainTierFor(ct, 0.06));
    }
    // The one surviving divergence: the fallback for an unrecognized/NULL container_type.
    for (const ct of [null, undefined, '', 'mystery_pot']) {
      expect(engine.rainTierFor(ct), `${ct} (live)`).toBe('small_fast');
      expect(engine.rainTierFor(ct, 20), `${ct} (live, sized)`).toBe('small_fast');  // size cannot rescue an unknown type
      expect(engine.rainDepthTierFor(ct), `${ct} (F2)`).toBe('unknown');
    }
    // The size gate itself, on the live resolver, at the shared threshold.
    expect(engine.rainTierFor('fabric_bag', 5)).toBe('fabric_ground');
    expect(engine.rainTierFor('fabric_bag', engine.FABRIC_GROUND_MIN_GAL)).toBe('fabric_ground');
    expect(engine.rainTierFor('fabric_bag', 0.06)).toBe('small_fast');
    expect(engine.rainTierFor('fabric_bag')).toBe('small_fast');
    // REPLACES the toBeUndefined trio: every name the live resolver can return MUST key all three
    // live tables, which is the actual invariant those assertions were protecting.
    for (const ct of [...Object.keys(engine.RAIN_VESSEL_TIER), null, 'mystery_pot']) {
      for (const gal of [null, 0.06, 5, 100]) {
        const tier = engine.rainTierFor(ct, gal);
        expect(engine.RAIN_TIER_IA[tier], `IA[${tier}] (${ct}/${gal})`).toBeTypeOf('number');
        expect(engine.RAIN_TIER_HOLD[tier], `HOLD[${tier}] (${ct}/${gal})`).toBeTypeOf('number');
        expect(engine.RAIN_MAX_DAYS[tier], `MAX_DAYS[${tier}] (${ct}/${gal})`).toBeTypeOf('object');
      }
    }
  });
  // D1 RESCOPE GUARD (crucible 2026-08-17). The morning edit merged these two rows; the panel found
  // it applied a fabric-bag field observation to 87 plantings that are rigid pots, tray cells,
  // hanging baskets and solo cups. This pins them APART so a future "tidy-up" cannot silently
  // re-merge them, and pins the direction (a rigid pot needs MORE rain, never less).
  it('INVARIANT: fabric_ground and small_fast are DISTINCT rows, and small_fast is the stricter one', () => {
    expect(LP.RAIN_DEPTH.fabric_ground).not.toEqual(LP.RAIN_DEPTH.small_fast);
    expect(LP.RAIN_DEPTH.fabric_ground).toEqual({ light: 0.10, normal: 0.25, deep: 0.60 });
    expect(LP.RAIN_DEPTH.small_fast).toEqual({ light: 0.15, normal: 0.40, deep: 0.90 });
    for (const cls of LP.RAIN_DEPTH_CLASSES) {
      expect(LP.RAIN_DEPTH.small_fast[cls], cls).toBeGreaterThan(LP.RAIN_DEPTH.fabric_ground[cls]);
    }
    // and they must be separately REACHABLE from a real container_type, not just distinct in the table
    expect(engine.rainDepthTierFor('fabric_bag', 5)).toBe('fabric_ground');
    expect(engine.rainDepthTierFor('plastic_pot', 5)).toBe('small_fast');
    // behavioural face: 0.30" is a rewet for a 5-gal bag and a sprinkle for a 5-gal plastic pot
    expect(rainDepthClass(engine.rainDepthTierFor('fabric_bag', 5), 0.30)).toBe('normal');
    expect(rainDepthClass(engine.rainDepthTierFor('plastic_pot', 5), 0.30)).toBe('light');
  });
  it('bed-equivalence is size-gated: a small or unsized fabric_bag stays on the strict row', () => {
    // One live fabric_bag is recorded as "3 in" -> 0.06 gal. Fabric alone is not the mechanism;
    // fabric + soil contact + mulch + volume is, and only the volume is machine-readable.
    expect(parseContainerGal('3 in')).toBeLessThan(engine.FABRIC_GROUND_MIN_GAL);
    expect(engine.rainDepthTierFor('fabric_bag', parseContainerGal('3 in'))).toBe('small_fast');
    expect(engine.rainDepthTierFor('fabric_bag', null)).toBe('small_fast');       // unparseable size
    expect(engine.rainDepthTierFor('fabric_bag')).toBe('small_fast');             // caller passed none
    expect(engine.rainDepthTierFor('fabric_bag', engine.FABRIC_GROUND_MIN_GAL)).toBe('fabric_ground');
    for (const sz of ['5 gal', '7 gal', '10 gal', '20 gal']) {                    // the live vocabulary
      expect(engine.rainDepthTierFor('fabric_bag', parseContainerGal(sz)), sz).toBe('fabric_ground');
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
  it('(e) fixed site reference: day 14 of a flat >=88F heat wave STILL reads demand > 1', () => {
    // The rolling-median failure mode this design killed: by day ~7-10 a rolling ref re-centers and
    // demand collapses to 1.0. The fixed ref keeps the whole wave elevated.
    const hot = flatWeather().map((r) => ({ ...r, et0_in: 0.30, tmax_f: 92 }));
    const f = mk({ weather: hot, todayEt0: 0.30, todayTmax: 92 });
    const ratio = f.drivers.find((d) => d.factor === 'et0_ratio').value;
    expect(ratio).toBeCloseTo(0.30 / LP.ET0_REF_PEAK, 2);
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
    const hot = { et0: LP.ET0_REF_PEAK * 2 };
    const full = mk({ weather: flatWeather(hot), todayEt0: LP.ET0_REF_PEAK * 2 });
    const gappy = mk({ weather: flatWeather({ ...hot, skip: ['2026-08-05', '2026-08-06', '2026-08-07'] }),
      todayEt0: LP.ET0_REF_PEAK * 2 });
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
  it('winter: a real December ET0 reaches the clamp floor from the physics, no special-case branch', () => {
    // Was "winter mode: ref below 0.04 pins the ratio". BUG-ETNOAMPLITUDE-001 deleted that branch
    // along with the per-month table it keyed on; under ONE reference a December day divides like
    // any other and lands on the floor by itself (0.01/0.1775 = 0.056 -> 0.5). Same observable
    // outcome, one fewer special case — and a freak-warm winter day is no longer pinned.
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
    const f = mk({ events: [], transplantAt: addDays(TODAY, -5), todayEt0: LP.ET0_REF_PEAK });
    expect(f.drivers.find((d) => d.factor === 'stage').value).toBe(LP.STAGE.establishmentFactor);
    const done = mk({ events: [], transplantAt: addDays(TODAY, -20), todayEt0: LP.ET0_REF_PEAK });
    expect(done.drivers.find((d) => d.factor === 'stage')).toBeUndefined();
  });
});

// ── SEASONAL AMPLITUDE — the F2 flip-gate criterion that did not exist ────────────────────────────
// BUG-ETNOAMPLITUDE-001. The pre-fix denominator was a per-MONTH table whose May-Aug entries were
// that month's own measured mean, so every month re-centered on 1.0 and the model carried no
// seasonal signal at all. Nothing caught it: every demand test above feeds ET0 == the reference
// (ratio 1.0 by construction), the engine acceptance tests all sit on 2026-08-12, and the shadow
// soak diffs a 30-day window — none of them can see a curve that is only wrong ACROSS months. These
// four are that missing criterion. They are deliberately expressed as relations BETWEEN dates, not
// as pinned values, so they survive a retune of the reference and fail only if the seasonal shape
// dies again.
describe('seasonal amplitude (BUG-ETNOAMPLITUDE-001)', () => {
  // Observed site climatology for the one live Space ([site lat],[site lon]): mean ET0_FAO in/day for
  // the named half-month, Open-Meteo ERA5 archive 2015-01-01..2025-12-31 (n=4018 days), same
  // endpoint/fields/units as scripts/backfill-weather-daily.mjs. TEST INPUT ONLY — deliberately not
  // exported from ledgerParams, because a per-period ET0 table reachable from the fold is precisely
  // the defect these tests exist to prevent.
  const CLIM = [
    ['2026-06-15', 0.1678], ['2026-07-15', 0.1770], ['2026-08-25', 0.1460],
    ['2026-09-05', 0.1238], ['2026-09-25', 0.1049], ['2026-10-15', 0.0625],
  ];
  // demand for one day at a given ET0, through the real fold. mk()'s trough/5gal is class 1.0 x size
  // 1.0 and there is no transplant, so demandToday IS the ET multiplier.
  function demandAt(day, et0) {
    const rows = [];
    for (let d = addDays(day, -30); d < day; d = addDays(d, 1)) {
      rows.push({ date: d, et0_in: et0, tmax_f: 70, tmin_f: 55, precip_in: 0 });
    }
    return mk({ today: day, nowMs: etMidnightMs(day) + 2 * H, weather: rows, todayEt0: et0, events: [] }).demandToday;
  }

  it('ONE site-wide reference: the SAME ET0 yields the SAME multiplier in July and in October', () => {
    // The defect stated at its root. A per-month denominator makes the multiplier a function of the
    // calendar as well as the weather; a site reference makes it a function of the weather alone.
    expect(demandAt('2026-10-15', 0.15)).toBeCloseTo(demandAt('2026-07-15', 0.15), 6);
  });

  it('midsummer demands at least 1.8x mid-autumn on real site climatology', () => {
    const jul = demandAt('2026-07-15', 0.1770);   // 11y mean 0.1770 in/day
    const oct = demandAt('2026-10-15', 0.0625);   // 11y mean 0.0625 in/day — 35% of July
    expect(jul / oct).toBeGreaterThanOrEqual(1.8);
  });

  it('crossing into September LENGTHENS intervals — it must never shorten them', () => {
    // The pre-fix model raised the multiplier from late-Aug 0.853 to early-Sep 1.054 in 11 of 11
    // archive years, i.e. it watered MORE often as evapotranspiration fell. Fall watering advice
    // was actively inverted, and the flip would have shipped it.
    expect(demandAt('2026-09-05', 0.1238)).toBeLessThan(demandAt('2026-08-25', 0.1460));
  });

  it('the multiplier never rises from one climatological period to a drier later one', () => {
    const seq = CLIM.map(([d, et0]) => [d, demandAt(d, et0)]);
    for (let i = 1; i < seq.length; i++) {
      if (CLIM[i][1] >= CLIM[i - 1][1]) continue;                 // only assert on a genuine ET0 drop
      expect(seq[i][1], `${seq[i - 1][0]} -> ${seq[i][0]}`).toBeLessThanOrEqual(seq[i - 1][1]);
    }
  });

  it('reference canary: ET0_REF_PEAK is a scalar pinned to its measured provenance', () => {
    // Fires on any retune. Moving it is legitimate — a fresh archive pull, or a level correction the
    // shadow soak asked for — but it is a decision, not a drive-by: re-derive from the query in
    // ledgerParams and re-run the soak. Also pins the SHAPE: a table here is the defect returning.
    expect(typeof LP.ET0_REF_PEAK).toBe('number');
    expect(LP.ET0_REF_PEAK).toBe(0.1775);
    expect(LP.ET0_REF_MONTHLY).toBeUndefined();
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

  // ── BUG-RAINEVENTNEUTRALIZES-001 ────────────────────────────────────────────────────────────────
  // A GAUGE-written rain event carries no water_depth (the writer never emits one), so before this
  // fix it was indistinguishable from the manual log above and took the same full reset -- on every
  // logged rain day, at any amount. Because the day_credit for that day lands later (23:59, PRIO 2)
  // onto an already-zeroed D, every depth class became a no-op and the whole DRG-RAINDEPTH-001
  // model was dead. These two tests pin the discrimination in BOTH directions; either one alone
  // could be satisfied by deleting the feature.
  it('a GAUGE rain event does NOT full-reset — the day_credit prices that day', () => {
    const rainDay = '2026-08-10';
    const weather = flatWeather({ precipOn: { [rainDay]: 0.12 } });   // intermediate: light (>=0.10, <0.25)
    const gauge = mk({ events: [PRIMER, { id: 'r1', t: at(rainDay, 12), type: 'rain', depth: null,
      gaugeSourced: true }], weather });
    const creditOnly = mk({ events: [PRIMER], weather });             // same day, no event at all
    // The event contributes NOTHING of its own: the fold is identical to the day_credit acting alone.
    expect(gauge.d).toBeCloseTo(creditOnly.d, 6);
    // And that shared value is a LIGHT credit, not a reset — the discrimination is real, not vacuous.
    expect(gauge.d).toBeGreaterThan(2);
  });

  it('gauge rain at 0.12" and at 2.84" fold DIFFERENTLY (the amount-blindness is gone)', () => {
    const rainDay = '2026-08-10';
    const mkAt = (inches) => mk({
      events: [PRIMER, { id: 'r1', t: at(rainDay, 12), type: 'rain', depth: null, gaugeSourced: true }],
      weather: flatWeather({ precipOn: { [rainDay]: inches } }),
    });
    const drizzle = mkAt(0.12);                                       // light
    const downpour = mkAt(2.84);                                      // deep
    // The exact failure signature of the bug was these two being byte-identical.
    expect(drizzle.d).not.toBeCloseTo(downpour.d, 3);
    expect(drizzle.d).toBeGreaterThan(downpour.d);                    // less rain => drier => due sooner
  });
  it('unknown depth strings fold as Normal (absent/historical = normal)', () => {
    const a = mk({ events: [PRIMER, W('2026-08-10', 12, 'torrential', 'x')] });
    const b = mk({ events: [PRIMER, W('2026-08-10', 12, null, 'x')] });
    expect(a.d).toBeCloseTo(b.d, 6);
  });
});

describe('rainDepthClass — measured precip -> depth class (DRG-RAINDEPTH-001)', () => {
  it('reads thresholds as LOWER BOUNDS, strongest class wins', () => {
    const t = LP.RAIN_DEPTH.small_fast;                   // light .15 / normal .40 / deep .90
    expect(rainDepthClass('small_fast', t.deep)).toBe('deep');
    expect(rainDepthClass('small_fast', t.deep - 0.001)).toBe('normal');
    expect(rainDepthClass('small_fast', t.normal)).toBe('normal');
    expect(rainDepthClass('small_fast', t.normal - 0.001)).toBe('light');
    expect(rainDepthClass('small_fast', t.light)).toBe('light');
    expect(rainDepthClass('small_fast', t.light - 0.001)).toBe(null);
  });
  it('the bed-equivalent rows mirror in_ground exactly; small_fast is the only stricter one', () => {
    // 2026-08-17 crucible D1 RESCOPE. Dave's field observation (bags on soil, mulched, clustered ->
    // they retain like a bed) is real but SCOPED to fabric bags; it was applied to all of small_fast
    // for part of a day. Bed-equivalence now belongs to fabric_ground, and to intermediate — raised
    // beds, troughs, whiskey barrels and window boxes are the highest-buffer vessels in the table
    // and had ended up needing MORE rain than a solo cup, which is backwards on both arms.
    // Pinned as literals PLUS equality, so drifting any row (or several together) fails here.
    expect(LP.RAIN_DEPTH.in_ground).toEqual({ light: 0.10, normal: 0.25, deep: 0.60 });
    for (const tier of ['intermediate', 'fabric_ground']) {
      for (const cls of LP.RAIN_DEPTH_CLASSES) {
        expect(LP.RAIN_DEPTH[tier][cls], `${tier}.${cls}`).toBe(LP.RAIN_DEPTH.in_ground[cls]);
      }
    }
    // small_fast = rigid pots / trays / hanging baskets: no wicking contact, no mulch, tablespoons
    // of buffer. STRICTLY more rain than the bed row at every class.
    for (const cls of LP.RAIN_DEPTH_CLASSES) {
      expect(LP.RAIN_DEPTH.small_fast[cls], cls).toBeGreaterThan(LP.RAIN_DEPTH.in_ground[cls]);
    }
  });
  // MONOTONICITY. The crucible found the table non-monotone: intermediate {0.10/0.30/0.75} demanded
  // more rain than small_fast {0.10/0.25/0.60}, i.e. the app under-credited the vessels that hold
  // water best and over-credited the ones that hold it worst, in the same table. Nothing failed,
  // because every guard asserted rows against themselves. This asserts the ORDERING across rows.
  it('INVARIANT: buffer order holds across rows — bed-equivalent <= small_fast <= unknown', () => {
    const bedEquivalent = ['in_ground', 'intermediate', 'fabric_ground'];
    for (const cls of LP.RAIN_DEPTH_CLASSES) {
      for (const tier of bedEquivalent) {
        expect(LP.RAIN_DEPTH[tier][cls], `${tier}.${cls} vs small_fast`)
          .toBeLessThanOrEqual(LP.RAIN_DEPTH.small_fast[cls]);
      }
      expect(LP.RAIN_DEPTH.small_fast[cls], `small_fast.${cls} vs unknown`)
        .toBeLessThanOrEqual(LP.RAIN_DEPTH.unknown[cls]);
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
  // every guard pinned the NAME rather than the property. A hardcoded row is the same bug wearing a
  // different hat, so ledgerParams keeps unknown DERIVED as the per-class max. Four legs, and they
  // do NOT all do the same amount of work — read the notes before "simplifying" any of them.
  it('INVARIANT: the unknown-vessel row demands the MOST rain of any row, by construction', () => {
    // (a) CANARY on the derived value. Not the invariant — just a tripwire so a retune that moves
    // the fail-safe cannot do it unnoticed. If a legitimate retune moves it, update this line.
    expect(LP.RAIN_DEPTH.unknown).toEqual({ light: 0.15, normal: 0.40, deep: 0.90 });
    // (b) CONTRACT leg: >= every named tier at every class. Against the derived form this is
    // tautological — max(xs) >= x is true by construction and this leg cannot fail today. That is
    // intentional and it is not the same thing as vacuous: its job is to go RED the moment someone
    // replaces the derivation with a literal that has stopped being the strictest row. Proven in
    // exactly that configuration (unknown pinned to a literal + one tier raised above it), which is
    // the only mutation that can violate it. Do not delete it for "always passing".
    for (const [tier, t] of Object.entries(LP.RAIN_DEPTH_TIERS)) {
      for (const cls of LP.RAIN_DEPTH_CLASSES) {
        expect(LP.RAIN_DEPTH.unknown[cls], `${tier}.${cls}`).toBeGreaterThanOrEqual(t[cls]);
      }
    }
    // (c) NON-VACUITY leg, and the one that still bites under derivation: it is not enough for the
    // unknown row to TIE the loosest tier — an unknown vessel must be discriminated against at every
    // class. This fails if the tiers are ever flattened into each other, which is the D1 defect.
    // (The pre-rescope version of this guard used toBeGreaterThanOrEqual against rows that all
    // shared light: 0.10, so it passed on equality and could not fail at the light class.)
    for (const cls of LP.RAIN_DEPTH_CLASSES) {
      expect(LP.RAIN_DEPTH.unknown[cls], `unknown.${cls} vs in_ground`)
        .toBeGreaterThan(LP.RAIN_DEPTH.in_ground[cls]);
    }
    // (d) reachable, and not an alias: a real unknown/NULL container_type has to resolve to that row
    expect(LP.RAIN_DEPTH[engine.rainDepthTierFor(null)]).toBe(LP.RAIN_DEPTH.unknown);
    expect(LP.RAIN_DEPTH[engine.rainDepthTierFor('mystery_pot')]).toBe(LP.RAIN_DEPTH.unknown);
    for (const tier of Object.keys(LP.RAIN_DEPTH_TIERS)) {
      expect(LP.RAIN_DEPTH.unknown, tier).not.toBe(LP.RAIN_DEPTH[tier]);
    }
  });
  it('an unknown vessel gets STRICTLY less credit than a bag at the same rain (err toward watering)', () => {
    // The behavioural face of the invariant, and the case that was broken: 0.27" measured. A NULL
    // container_type must not quietly ride the bed-equivalent bag row into a Normal rewet.
    expect(rainDepthClass(engine.rainDepthTierFor(null), 0.27)).toBe('light');
    expect(rainDepthClass(engine.rainDepthTierFor('fabric_bag', 5), 0.27)).toBe('normal');
    // 0.12" is the light-floor face of the same thing: a bed-equivalent vessel earns a Light credit,
    // an unknown vessel earns NOTHING. Under the pre-rescope derived-max row both were Light.
    expect(rainDepthClass(engine.rainDepthTierFor(null), 0.12)).toBe(null);
    expect(rainDepthClass(engine.rainDepthTierFor('fabric_bag', 5), 0.12)).toBe('light');
  });
  it('unknown tier falls back to the unknown row; zero/negative/NaN earn nothing', () => {
    // an unrecognized tier NAME (not just an unrecognized vessel) must also land on the strict row
    expect(rainDepthClass('bogus', 0.27)).toBe(rainDepthClass('unknown', 0.27));
    // discriminated against the MOST-credited row, not against whichever row currently shares the
    // unknown values — small_fast and unknown are equal today and this leg was vacuous at 0.27".
    expect(rainDepthClass('bogus', 0.27)).not.toBe(rainDepthClass('in_ground', 0.27));
    expect(rainDepthClass('in_ground', 0.3)).toBe('normal');
    for (const bad of [0, -1, NaN, null, undefined]) expect(rainDepthClass('in_ground', bad)).toBe(null);
  });
});

describe('gauge-rain day-credits', () => {
  // THE D1 RESCOPE, AT THE FOLD (crucible 2026-08-17). The golden corpus exercises a bag at 0.21"
  // only, which is Light under every version of this table and is therefore structurally blind to a
  // threshold edit — a full silent revert of the rescope leaves parity 30/30 green. This test is the
  // one that is not blind. 0.30" is chosen because it straddles the two rows: Normal for a bag
  // (fabric_ground normal 0.25), Light for a rigid pot (small_fast normal 0.40).
  it('0.30" rewets a 5-gal fabric bag but only sprinkles a 5-gal plastic pot', () => {
    const bag = vesselProfile('fabric_bag', '5 gal');
    const pot = vesselProfile('plastic_pot', '5 gal');
    const bagTier = engine.rainDepthTierFor('fabric_bag', bag.sizeGal);
    const potTier = engine.rainDepthTierFor('plastic_pot', pot.sizeGal);
    expect([bagTier, potTier]).toEqual(['fabric_ground', 'small_fast']);
    const wet = flatWeather({ precipOn: { '2026-08-09': 0.30 } });     // tmax 75: heat ramp is 0
    const run = (vessel, rainTier, weather) => mk({ vessel, rainTier, weather, events: [PRIMER] });
    const bagDry = run(bag, bagTier, flatWeather()), bagWet = run(bag, bagTier, wet);
    const potDry = run(pot, potTier, flatWeather()), potWet = run(pot, potTier, wet);
    // ISOLATION: at tmax 75 the fabric ramp contributes 0, so both vessels carry vf 1.1 x size 1.0.
    // Identical demand means the rain tier is the ONLY thing that can move D between these two.
    expect(bagDry.d).toBeCloseTo(potDry.d, 9);
    expect(potDry.d - potWet.d).toBeCloseTo(LP.LIGHT_CREDIT_WI * 4, 6);      // Light: subtractive
    expect(bagDry.d - bagWet.d).toBeGreaterThan(LP.LIGHT_CREDIT_WI * 4);     // Normal: rewets
    expect(bagWet.d).toBeLessThan(potWet.d);
  });
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
      ['fabric_ground', vesselProfile('fabric_bag', '5 gal')],
      ['small_fast', vesselProfile('plastic_pot', '2 gal')],
    ]) {
      expect(rainDepthClass(tier, 0.21)).toBe('light');
      const bare = mk({ events: [PRIMER], rainTier: tier, vessel });
      const wet = mk({ events: [PRIMER], rainTier: tier, vessel,
        weather: flatWeather({ precipOn: { '2026-08-09': 0.21 } }) });
      expect(bare.d - wet.d).toBeCloseTo(LP.LIGHT_CREDIT_WI * 4, 6);
    }
  });
  it('2026-08-17 revision: 0.30" now earns a BAG the full Normal rewet, not a Light nudge', () => {
    // Dave's field observation moved the BAG's normal threshold 0.40 -> 0.25. 0.30" measured used to
    // land as Light on a bag (a subtractive nudge) and now lands as Normal — the same class the
    // in-ground row has always given it. This is the under-crediting he reported as driving
    // over-watering. Pinned against a MANUAL Normal watering at the same instant: rain folds through
    // the same depth arithmetic, and Normal carries no bank, so the two must land identically.
    // RESCOPED 2026-08-17 pm: the row is fabric_ground, not small_fast. This test originally read
    // rainTier 'small_fast' — the tier a rigid nursery pot keys — which is precisely the over-application
    // the crucible found. It now resolves the tier the way the engine does, from type AND size.
    const bagVessel = vesselProfile('fabric_bag', '5 gal');
    const bag = { vessel: bagVessel, rainTier: engine.rainDepthTierFor('fabric_bag', bagVessel.sizeGal) };
    expect(bag.rainTier).toBe('fabric_ground');
    expect(rainDepthClass(bag.rainTier, 0.30)).toBe('normal');
    expect(rainDepthClass(bag.rainTier, 0.30)).toBe(rainDepthClass('in_ground', 0.30));
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
