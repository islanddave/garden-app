// BUG-WATERAUTUMNDEMAND-001 — the Water Ledger's late-season crop factor (ledgerParams LATE_SEASON,
// ledger.lateSeasonFactor / lateSeasonEligible, applied in foldLedger's demandFor after the ET0 clamp).
// Dave, 2026-09-28: the app over-asked for water once autumn cooled; the replay and the physics that set these
// numbers live in gardening-docs project-state/_waterdemand-20260928/.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ledger from './ledger.js';
import P from './ledgerParams.js';
import engine from './engine.js';
import cf from './_coverFlags.js';

const { lateSeasonFactor, lateSeasonEligible, foldLedger, vesselProfile, etMidnightMs, addDays } = ledger;
const L = P.LATE_SEASON;
const H = 3600000;

// Seven settled days before (and, for a settled day, including) `day`, every low = tmin.
function lows(day, tmin, { n = 8, et0 = 0.12, tmax = 62 } = {}) {
  const out = {};
  for (let i = 0; i < n; i++) out[addDays(day, -i)] = { et0_in: et0, tmax_f: tmax, tmin_f: tmin, precip_in: 0 };
  return out;
}

describe('lateSeasonFactor — the week\'s lows set it, a warm day lifts it, spring never sees it', () => {
  const D = '2026-09-26';
  it('ramps linearly from 1.0 at a 56F weekly mean low to factorMin at 50F, and holds below', () => {
    expect(lateSeasonFactor(lows(D, 60), D, false, 60)).toBe(1);
    expect(lateSeasonFactor(lows(D, 56), D, false, 60)).toBe(1);
    expect(lateSeasonFactor(lows(D, 53), D, false, 60)).toBeCloseTo(1 - (1 - L.factorMin) * 0.5, 10);   // 0.7
    expect(lateSeasonFactor(lows(D, 50), D, false, 60)).toBeCloseTo(L.factorMin, 10);
    expect(lateSeasonFactor(lows(D, 42), D, false, 60)).toBeCloseTo(L.factorMin, 10);
  });

  it('a warm day restores demand: halfway across 75-85F is halfway back, 85F is all the way', () => {
    expect(lateSeasonFactor(lows(D, 50), D, false, 70)).toBeCloseTo(0.4, 10);
    expect(lateSeasonFactor(lows(D, 50), D, false, 80)).toBeCloseTo(0.4 + 0.6 * 0.5, 10);
    expect(lateSeasonFactor(lows(D, 50), D, false, 85)).toBe(1);
    expect(lateSeasonFactor(lows(D, 50), D, false, null)).toBeCloseTo(0.4, 10);   // unknown high: no lift
  });

  it('cold nights before the June solstice do not trigger it (spring growth, not season\'s end)', () => {
    expect(lateSeasonFactor(lows('2026-06-10', 42), '2026-06-10', false, 60)).toBe(1);
    expect(lateSeasonFactor(lows('2026-06-20', 42), '2026-06-20', false, 60)).toBe(1);   // day 171
    expect(lateSeasonFactor(lows('2026-06-21', 42), '2026-06-21', false, 60)).toBeCloseTo(0.4, 10);   // day 172
  });

  it('needs at least minRows known lows in the trailing week, else 1.0 (fail toward watering)', () => {
    const three = lows(D, 45, { n: 3 });
    expect(lateSeasonFactor(three, D, false, 60)).toBe(1);
    const holes = lows(D, 45);
    for (const k of Object.keys(holes).slice(0, 5)) holes[k].tmin_f = null;
    expect(lateSeasonFactor(holes, D, false, 60)).toBe(1);   // only 3 known of the trailing 7
    expect(lateSeasonFactor(lows(D, 45, { n: 4 }), D, false, 60)).toBeCloseTo(0.4, 10);
  });

  it('a settled day includes its own low; today, which has no row yet, uses the seven days before it', () => {
    const w = lows('2026-09-25', 50, { n: 7 });           // Sep 19..25
    w['2026-09-26'] = { et0_in: 0.12, tmax_f: 60, tmin_f: 62, precip_in: 0 };
    // as TODAY (Sep 26): reads Sep 19..25 only -> mean 50 -> floor
    expect(lateSeasonFactor(w, '2026-09-26', true, 60)).toBeCloseTo(0.4, 10);
    // as a SETTLED day: Sep 20..26 -> (6*50 + 62)/7 = 51.71 -> 1 - 0.6*(56-51.71)/6
    expect(lateSeasonFactor(w, '2026-09-26', false, 60)).toBeCloseTo(1 - 0.6 * ((56 - (6 * 50 + 62) / 7) / 6), 10);
  });
});

describe('lateSeasonEligible — full demand stays wherever the buffer is small or unproven', () => {
  const v = (ct, size) => vesselProfile(ct, size);
  const ok = (o) => lateSeasonEligible({ status: 'fruiting', vessel: v('fabric_bag', '5 gal'), exposure: 'outdoor', ...o });
  it('fruiting, flowering and harvested plantings in bags, beds and larger vessels qualify, outdoors or covered', () => {
    expect(ok({})).toBe(true);
    expect(ok({ status: 'Flowering' })).toBe(true);
    expect(ok({ status: 'harvested' })).toBe(true);
    expect(ok({ exposure: 'covered' })).toBe(true);
    expect(ok({ vessel: v('in_ground', null) })).toBe(true);
    expect(ok({ vessel: v('raised_bed', null) })).toBe(true);
    expect(ok({ vessel: v('fabric_bag', '10 gal') })).toBe(true);
    expect(ok({ vessel: v('trough', '6x2 ft') })).toBe(true);
  });
  it('growing, seedling and dormant plantings do not', () => {
    for (const s of ['vegetative', 'seedling', 'dormant', 'active', null]) expect(ok({ status: s })).toBe(false);
  });
  it('indoor plantings, trays, hanging baskets, 1 gal or less and unknown sizes keep full demand', () => {
    expect(ok({ exposure: 'indoor' })).toBe(false);
    expect(ok({ vessel: v('tray_cell', '1.5 in') })).toBe(false);
    expect(ok({ vessel: v('hanging_basket', '10 in') })).toBe(false);
    expect(ok({ vessel: v('plastic_pot', '1 gal') })).toBe(false);
    expect(ok({ vessel: v('plastic_pot', '6 in') })).toBe(false);
    expect(ok({ vessel: v('plastic_pot', null) })).toBe(false);
    expect(ok({ vessel: v('plastic_pot', '3 gal') })).toBe(true);
  });
});

describe('foldLedger — the factor slows a finishing bag in autumn and leaves summer alone', () => {
  const TODAY = '2026-09-26';
  const now = etMidnightMs(TODAY) + 6 * H;
  const water = (daysAgo) => [{ id: 'w', t: etMidnightMs(addDays(TODAY, -daysAgo)) + 9 * H, type: 'watering' }];
  const base = (o) => ({
    wiEff: 1, thr: 1, events: water(2), weatherRowCount: 30,
    todayStr: TODAY, effNowMs: now, todayEt0: 0.12, todayTmax: 62,
    exposure: 'outdoor', vessel: vesselProfile('fabric_bag', '5 gal'), rainTier: 'fabric_ground', ...o,
  });
  const wx = (tmin) => lows(addDays(TODAY, -1), tmin, { n: 30 });

  it('late September: a 1-day bag watered two days ago is not due with the factor, and is due without it', () => {
    const on = foldLedger(base({ weatherByDate: wx(48), lateSeason: true }));
    const off = foldLedger(base({ weatherByDate: wx(48), lateSeason: false }));
    expect(off.due).toBe(true);
    expect(on.due).toBe(false);
    // The watering lands on a long-dry profile (no history in the window), so both folds restart from the
    // container partial-rewet level; everything accrued AFTER it is scaled by the factor.
    const rewet = P.HEDGE.containerResetWi * 1;
    expect(on.d - rewet).toBeCloseTo((off.d - rewet) * L.factorMin, 6);
    expect(on.drivers).toContainEqual({ factor: 'late_season', value: L.factorMin });
    expect(off.drivers.some((x) => x.factor === 'late_season')).toBe(false);
  });

  it('warm nights leave the fold byte-identical — eligibility alone changes nothing', () => {
    const on = foldLedger(base({ weatherByDate: wx(62), lateSeason: true }));
    const off = foldLedger(base({ weatherByDate: wx(62), lateSeason: false }));
    expect(on).toEqual(off);
  });

  it('a planting transplanted inside the last three weeks keeps full demand', () => {
    const fresh = foldLedger(base({ weatherByDate: wx(48), lateSeason: true, transplantAt: addDays(TODAY, -10) }));
    const off = foldLedger(base({ weatherByDate: wx(48), lateSeason: false, transplantAt: addDays(TODAY, -10) }));
    expect(fresh.d).toBeCloseTo(off.d, 10);
  });

  it('indoor stays flat at 1.0 whatever the flag says', () => {
    const a = foldLedger(base({ weatherByDate: wx(48), lateSeason: true, exposure: 'indoor' }));
    const b = foldLedger(base({ weatherByDate: wx(48), lateSeason: false, exposure: 'indoor' }));
    expect(a).toEqual(b);
  });
});

describe('engine — the flag-ON water list reads eligibility off the planting', () => {
  const here = (p) => fileURLToPath(new URL(p, import.meta.url));
  const cadence = JSON.parse(readFileSync(here('./cadence-data-v2.json'), 'utf8'));
  const fertModel = JSON.parse(readFileSync(here('./fertilization-model.json'), 'utf8'));
  const TODAY = '2026-09-26';
  const SEED = { _seeded: true, crop: 'tomato', water_interval_days_container: 1, water_interval_days_inground: 1,
    water_method: 'soak', soil_moisture_target: 'moist', drought_tolerance: 'medium' };
  const P0 = (o) => cf.withCoverFlags({ id: 'p', name: 'Bag', variety: 'v', genus: 'Solanum', project: 'P', project_id: 'pp',
    container_type: 'fabric_bag', container_size: '5 gal', covered: false, rain_exposed: true, last_water: addDays(TODAY, -2),
    substrate_start: addDays(TODAY, -120), transplant_at: addDays(TODAY, -100), db_cadence: SEED, ...o });
  const weatherDaily = [];
  for (let d = addDays(TODAY, -30); d < TODAY; d = addDays(d, 1)) weatherDaily.push({ date: d, et0_in: 0.12, tmax_f: 62, tmin_f: 47, precip_in: 0 });
  const plan = engine.generatePlan({
    today: TODAY, nowMs: etMidnightMs(TODAY) + 6 * H, weather: { tonightLow: 45, highToday: 62 },
    hydrology: { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0, today_et0_in: 0.12, today_tmax_f: 62 },
    ownerFallback: 'dave', cadence, fertModel, rainCreditEnabled: true, rainMaxDaysEnabled: false, todayAwareEnabled: true,
    waterLedgerEnabled: true, weatherDaily,
    eventsByPlant: {
      fr: [{ id: 'a', t: etMidnightMs(addDays(TODAY, -2)) + 9 * H, type: 'watering' }],
      vg: [{ id: 'b', t: etMidnightMs(addDays(TODAY, -2)) + 9 * H, type: 'watering' }],
    },
    plantings: [P0({ id: 'fr', status: 'fruiting' }), P0({ id: 'vg', status: 'vegetative' })],
  });
  const dueIds = Object.values(plan.users).flatMap((u) => u.tasks.water_due).map((x) => x.id);
  it('a growing (vegetative) bag stays on the list; the same bag in fruit is slowed off it', () => {
    expect(dueIds).toContain('vg');
    expect(dueIds).not.toContain('fr');
  });
});
