// DRG-WXWATER-001 coarse-v1 — 3-substrate-tier rain model tests (flag-gated: CARE_RAIN_CREDIT_ENABLED).
//
// TWO jobs, mirroring the parity harness philosophy:
//   (1) STANDING FLAG-OFF GUARD (spec §8 "Standing regression guard"): prove generatePlan(flag:off) is
//       byte-identical to the current engine across ALL 8 committed parity goldens. Combined with parity.test.js
//       (goldens are the pre-change engine output and are NOT regenerated), this pins that the new flag path
//       cannot move the DRG-BACKBONE shadow-parity signal. Also re-asserts the B2 byte-identity anchors.
//   (2) FLAG-ON COVERAGE: the intended tier behavior is a SEPARATE set (spec B3 "flag-ON gets a separate golden
//       set") — pinned here as deterministic assertions rather than regenerated goldens, plus a FALSIFIABILITY
//       check that the flag actually changes at least one golden scenario (L-146).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import engine from './engine.js';
import { scenarios } from '../../tests/parity/daily-plan/fixtures.mjs';

const {
  generatePlan, generatePlanForUser, RAIN_IA, RAIN_TIER_IA, RAIN_TIER_HOLD, RAIN_VESSEL_TIER,
  rainTierFor, rainStageFor, rainMaxDays, rainCreditDaysTiered,
} = engine;

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const cadence = JSON.parse(readFileSync(here('./cadence-data-v2.json'), 'utf8'));
const fertModel = JSON.parse(readFileSync(here('./fertilization-model.json'), 'utf8'));

const TODAY = '2026-06-21';
const ago = (d) => { const t = new Date('2026-06-21T00:00:00Z'); t.setUTCDate(t.getUTCDate() - d); return t.toISOString().slice(0, 10); };
const cad = { default: { crop: 'tomato', water_interval_days_inground: 5, water_interval_days_container: 3, water_method: 'soak', soil_moisture_target: 'moist' }, by_variety: {}, by_genus_fallback: {}, pest_watch: {} };
const fm = { amendments_in_inventory: { fruiting_feed: { item: 'a', apply: 'b' }, kelp: { item: 'k' }, veg_feed: { item: 'v', apply: 'w' }, castings: { item: 'c', apply: 'd' } }, water_quality: null };
const wx = { tonightLow: 60, highToday: 75 };
// seeded cadence with an explicit inground interval so container_type drives inGround selection deterministically.
const SEED = (o) => ({ _seeded: true, crop: 'tomato', water_interval_days_container: 3, water_interval_days_inground: 5, water_method: 'soak', soil_moisture_target: 'moist', drought_tolerance: 'medium', ...o });

// Run one planting through the engine at a given flag state; return DUE|SKIP|NOHIST|NONE + the plan.
function bucket(ov, hy, flag, weather = wx) {
  const p = { id: 't', name: 'X', variety: 'v', genus: 'g', status: 'active', project: 'P', project_id: 'pp',
    container_type: null, container_size: null, covered: false, last_water: null, substrate_start: ago(81),
    transplant_at: ago(400), db_cadence: SEED({}), ...ov };
  const out = generatePlanForUser([p], cad, fm, TODAY, weather, hy, flag);
  const b = out.tasks.water_due.some((w) => w.id === 't') ? 'DUE'
    : out.tasks.rain_skipped.some((w) => w.id === 't') ? 'SKIP'
    : out.tasks.no_history.some((w) => w.id === 't') ? 'NOHIST' : 'NONE';
  return { b, out };
}

// Hydrology fixtures keyed by window precip (recent + today).
const H = (recent) => ({ recent_precip_in: recent, today_precip_in: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 });

describe('WXWATER byte-identity anchors (B2) — untouched legacy symbols', () => {
  it('RAIN_IA.outdoor still 0.25; RAIN_IA.in_ground still undefined (watercredit.test.js:36-37 unbroken)', () => {
    expect(RAIN_IA.outdoor).toBe(0.25);
    expect(RAIN_IA.in_ground).toBeUndefined();
  });
});

describe('WXWATER STANDING FLAG-OFF GUARD — generatePlan(flag:off) == default across all 8 parity goldens', () => {
  for (const s of scenarios) {
    it(`flag:false deep-equals default for "${s.name}"`, () => {
      const off = generatePlan({ ...s.input, cadence, fertModel, rainCreditEnabled: false });
      const def = generatePlan({ ...s.input, cadence, fertModel });
      expect(off).toEqual(def);
    });
  }
});

describe('WXWATER FALSIFIABILITY — the flag actually changes behavior on >=1 golden scenario', () => {
  it('at least one parity scenario diverges flag-ON vs flag-OFF (else the flag is a no-op)', () => {
    const diverged = scenarios.some((s) => {
      const off = JSON.stringify(generatePlan({ ...s.input, cadence, fertModel, rainCreditEnabled: false }));
      const on = JSON.stringify(generatePlan({ ...s.input, cadence, fertModel, rainCreditEnabled: true }));
      return off !== on;
    });
    expect(diverged).toBe(true);
  });
});

describe('WXWATER tier lookup — every DB container_type maps; unknown fails safe to small_fast', () => {
  it('vessel -> tier assignment (14 DB values + generic pot)', () => {
    expect(rainTierFor('in_ground')).toBe('in_ground');
    for (const t of ['raised_bed', 'trough', 'whiskey_barrel', 'window_box']) expect(rainTierFor(t)).toBe('intermediate');
    for (const t of ['fabric_bag', 'hanging_basket', 'tray_cell', 'soil_block', 'solo_cup', 'plastic_pot', 'terracotta', 'ceramic', 'pot', 'other']) expect(rainTierFor(t)).toBe('small_fast');
  });
  it('null / unknown container_type -> small_fast (least credit, err toward watering)', () => {
    expect(rainTierFor(null)).toBe('small_fast');
    expect(rainTierFor(undefined)).toBe('small_fast');
    expect(rainTierFor('mystery_pot')).toBe('small_fast');
  });
  it('tier constants are the coarse-v1 values (IA spreads around the legacy 0.25; holds 3/2/1)', () => {
    expect(RAIN_TIER_IA).toEqual({ in_ground: 0.20, intermediate: 0.25, small_fast: 0.35 });
    expect(RAIN_TIER_HOLD).toEqual({ in_ground: 3, intermediate: 2, small_fast: 1 });
  });
});

describe('WXWATER rainStageFor + rainMaxDays (ceiling matrix + crop modifier + floor)', () => {
  it('status -> stage mapping', () => {
    expect(rainStageFor('vegetative')).toBe('vegetative');
    expect(rainStageFor('flowering')).toBe('flowering');
    expect(rainStageFor('fruiting')).toBe('fruiting');
    expect(rainStageFor('fruit_set')).toBe('fruiting');
    expect(rainStageFor('active')).toBe('mature');   // unknown -> loosest, still capped
    expect(rainStageFor(null)).toBe('mature');
  });
  it('base ceilings per tier x stage', () => {
    expect(rainMaxDays('in_ground', 'mature', 'radish')).toBe(5);
    expect(rainMaxDays('intermediate', 'vegetative', 'radish')).toBe(3);
    expect(rainMaxDays('small_fast', 'fruiting', 'radish')).toBe(1);
  });
  it('crop modifier: +1 for Mediterranean herbs, -1 for leafy/Solanaceae at flowering/fruiting, floor 1', () => {
    expect(rainMaxDays('in_ground', 'mature', 'rosemary')).toBe(6);        // 5 +1
    expect(rainMaxDays('intermediate', 'fruiting', 'tomato')).toBe(1);     // 2 -1
    expect(rainMaxDays('small_fast', 'fruiting', 'pepper')).toBe(1);       // 1 -1 -> floor 1
    expect(rainMaxDays('intermediate', 'flowering', 'lettuce')).toBe(2);   // 3 -1
    expect(rainMaxDays('in_ground', 'vegetative', 'lettuce')).toBe(4);     // no mod (not flower/fruit)
  });
});

describe('WXWATER rainCreditDaysTiered — per-tier IA threshold + hold cap', () => {
  it('in_ground clears a lighter rain (IA 0.20) and holds up to 3 days', () => {
    expect(rainCreditDaysTiered('in_ground', 5, H(0.22))).not.toBeNull();  // 0.22 > 0.20
    expect(rainCreditDaysTiered('in_ground', 5, H(0.22)).credit_days).toBe(3);
    expect(rainCreditDaysTiered('in_ground', 2, H(0.5)).credit_days).toBe(2); // capped at wi
  });
  it('small_fast needs a heavier rain (IA 0.35) and holds only 1 day', () => {
    expect(rainCreditDaysTiered('small_fast', 5, H(0.30))).toBeNull();     // 0.30 < 0.35
    expect(rainCreditDaysTiered('small_fast', 5, H(0.40)).credit_days).toBe(1);
  });
  it('missing precip -> null', () => {
    expect(rainCreditDaysTiered('in_ground', 5, { recent_precip_in: null, today_precip_in: null })).toBeNull();
  });
});

describe('WXWATER flag-ON behavior — directional divergence from flag-OFF', () => {
  it('in_ground light rain (0.22"): flag-OFF waters (under 0.25), flag-ON credits it (in_ground IA 0.20, 3d hold) -> SKIP', () => {
    const ov = { container_type: 'in_ground', status: 'vegetative', last_water: ago(5), db_cadence: SEED({ crop: 'chard' }) };
    expect(bucket(ov, H(0.22), false).b).toBe('DUE');
    expect(bucket(ov, H(0.22), true).b).toBe('SKIP');
  });
  it('small_fast fruiting pepper, moderate rain: flag-ON is stricter (IA 0.35 + ceiling 1) -> DUE where flag-OFF SKIPs', () => {
    const ov = { container_type: 'fabric_bag', container_size: '5 gal', status: 'fruiting', last_water: ago(3), db_cadence: SEED({ crop: 'pepper' }) };
    // flag-OFF: outdoor IA 0.25, 0.5" clears, dW==wi(3) -> SKIP
    expect(bucket(ov, H(0.5), false, wx).b).toBe('SKIP');
    // flag-ON: small_fast ceiling for fruiting Solanaceae = 1 -> wi clamps to 1, dW=3 -> DUE
    expect(bucket(ov, H(0.5), true, wx).b).toBe('DUE');
  });
  it('max-days ceiling clamps a long cadence so the plant re-surfaces (anti suppression-inversion)', () => {
    // in_ground, mature, cadence 5, big rain: flag-OFF holds 1 day (SKIP at dW==5). flag-ON ceiling(mature in_ground)=5,
    // hold 3 -> still credits, but a plant last watered 9d ago (> ceiling+hold) is DUE.
    const ov = { container_type: 'in_ground', status: 'active', last_water: ago(9), db_cadence: SEED({ crop: 'kale' }) };
    expect(bucket(ov, H(0.8), true).b).toBe('DUE');
  });
});

describe('WXWATER rain_exposed override (flag-ON only)', () => {
  it('covered planting with rain_exposed=true IS credited under flag-ON (override wins)', () => {
    const ov = { container_type: 'in_ground', status: 'vegetative', covered: true, rain_exposed: true, last_water: ago(5), db_cadence: SEED({ crop: 'chard' }) };
    expect(bucket(ov, H(0.5), false).b).toBe('DUE');   // flag-OFF: covered -> never credited
    expect(bucket(ov, H(0.5), true).b).toBe('SKIP');   // flag-ON: explicit exposure override credits it
  });
  it('outdoor planting with rain_exposed=false is DENIED credit under flag-ON', () => {
    const ov = { container_type: 'in_ground', status: 'vegetative', covered: false, rain_exposed: false, last_water: ago(5), db_cadence: SEED({ crop: 'chard' }) };
    expect(bucket(ov, H(0.5), true).b).toBe('DUE');    // override says sheltered -> no credit -> water
  });
  it('rain_exposed NULL falls back to !covered under flag-ON', () => {
    const ovOutdoor = { container_type: 'in_ground', status: 'vegetative', covered: false, rain_exposed: null, last_water: ago(5), db_cadence: SEED({ crop: 'chard' }) };
    const ovCovered = { container_type: 'in_ground', status: 'vegetative', covered: true, rain_exposed: null, last_water: ago(5), db_cadence: SEED({ crop: 'chard' }) };
    expect(bucket(ovOutdoor, H(0.5), true).b).toBe('SKIP'); // derived exposed
    expect(bucket(ovCovered, H(0.5), true).b).toBe('DUE');  // derived sheltered
  });
});
