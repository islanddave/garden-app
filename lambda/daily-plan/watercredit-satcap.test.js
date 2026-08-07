// DRG-WXSATCAP-001 — heavy-soak saturation cap golden fixture. FLAG-INDEPENDENT.
// Root cause (verified live in engine.js): RAIN_TIER_HOLD.small_fast=1 -> a fabric bag re-surfaces "water"
// the day after a soak while still saturated. Over-watering saturated media (no drying window) = anoxia /
// root rot = NON-recoverable, so in the heavy-soak regime the safe error inverts to "skip".
// Cap constants Dave-approved 2026-07-30: >=1.0"/72h window (windowPrecip = recent+today) OR
// already-wet(>=0.5") + incoming(>=0.5" @ >=60% PoP) -> suppress ALL outdoor vessels UNIFORMLY
// (container_type is ~unpopulated so a vessel-agnostic gate is the only design robust to the dominant
// NULL case; NULL is outdoor -> suppressed -> fails safe). covered/indoor never got the rain -> exempt.
// Expectations are ORACLE-derived (hand-computed), NOT snapshots. Each case runs under CARE_RAIN_CREDIT_ENABLED
// both OFF and ON (boss-Add-1: a cap living only in the flag-OFF branch would be silently deleted when F2
// flips the flag). A "way overdue" planting (10d) would be DUE absent the cap, isolating the cap from the
// normal 1-day credit path.
import { describe, it, expect } from 'vitest';
import engine from './engine.js';
import _cf from './_coverFlags.js';
const { withCoverFlags } = _cf;  // BUG-NOLOCOUTDOOR-001 fixture bridge
const { generatePlanForUser } = engine;

const TODAY = '2026-06-21';
const ago = (d) => { const t = new Date('2026-06-21T00:00:00Z'); t.setUTCDate(t.getUTCDate() - d); return t.toISOString().slice(0, 10); };
const cad = { default: { crop: 'tomato', water_interval_days_inground: 5, water_interval_days_container: 3, water_method: 'soak', soil_moisture_target: 'moist' }, by_variety: {}, by_genus_fallback: {}, pest_watch: {} };
const fm = { amendments_in_inventory: { fruiting_feed: { item: 'a', apply: 'b' }, kelp: { item: 'k' }, veg_feed: { item: 'v', apply: 'w' }, castings: { item: 'c', apply: 'd' } }, water_quality: null };
const wx = { tonightLow: 60, highToday: 75 };

// windowPrecip = recent_precip_in + today_precip_in. Approved: SOAK_CAP_IN=1.0, WET_FLOOR=0.5, FCST_QPF=0.5, POP=60.
const HS = {
  soak4:    { recent_precip_in: 3.0, today_precip_in: 1.0, upcoming_precip_in: 0.8, tomorrow_precip_in: 0.8, tomorrow_pop: 80 }, // wp=4.0 (Dave's 4"/2d)
  capEdge:  { recent_precip_in: 1.0, today_precip_in: 0,   upcoming_precip_in: 0,   tomorrow_precip_in: 0,   tomorrow_pop: 0  }, // wp=1.0 exactly
  belowCap: { recent_precip_in: 0.9, today_precip_in: 0,   upcoming_precip_in: 0,   tomorrow_precip_in: 0,   tomorrow_pop: 0  }, // wp=0.9
  incWet:   { recent_precip_in: 0.6, today_precip_in: 0,   upcoming_precip_in: 0.6, tomorrow_precip_in: 0.6, tomorrow_pop: 70 }, // wet 0.6 + incoming 0.6@70
  incDry:   { recent_precip_in: 0.3, today_precip_in: 0,   upcoming_precip_in: 0.6, tomorrow_precip_in: 0.6, tomorrow_pop: 70 }, // wp 0.3 < 0.5 floor
  incLowPop:{ recent_precip_in: 0.6, today_precip_in: 0,   upcoming_precip_in: 0.6, tomorrow_precip_in: 0.6, tomorrow_pop: 50 }, // pop 50 < 60
};

function bucket(ov, hy, flag = false) {
  const p = withCoverFlags({ id: 't', name: 'X', variety: 'v', genus: 'g', status: 'active', project: 'P', project_id: 'pp', container_type: null, container_size: null, covered: false, last_water: null, substrate_start: ago(81), transplant_at: null, ...ov });
  const out = generatePlanForUser([p], cad, fm, TODAY, wx, hy, flag);
  const b = out.tasks.water_due.some(w => w.id === 't') ? 'DUE'
    : out.tasks.rain_skipped.some(w => w.id === 't') ? 'SKIP'
    : out.tasks.no_history.some(w => w.id === 't') ? 'NOHIST' : 'NONE';
  return { b, out };
}

const OVERDUE = { covered: false, last_water: ago(10) };  // would be DUE absent the cap

describe('DRG-WXSATCAP-001: heavy-soak saturation cap (flag-independent)', () => {
  const G = [
    ['4"/2d soak, way-overdue bag => SKIP (saturated)',        { ...OVERDUE, container_type: 'fabric_bag' }, HS.soak4,    'SKIP'],
    ['cap edge exactly 1.0" => SKIP',                          { ...OVERDUE, container_type: 'fabric_bag' }, HS.capEdge,  'SKIP'],
    ['just below cap 0.9" => DUE (both-direction boundary)',   { ...OVERDUE, container_type: 'fabric_bag' }, HS.belowCap, 'DUE'],
    ['incoming-on-wet (0.6 wet + 0.6"@70%) => SKIP',           { ...OVERDUE, container_type: 'fabric_bag' }, HS.incWet,   'SKIP'],
    ['incoming on DRY media (0.3 < 0.5 floor) => DUE',         { ...OVERDUE, container_type: 'fabric_bag' }, HS.incDry,   'DUE'],
    ['incoming low PoP (50 < 60) => DUE',                      { ...OVERDUE, container_type: 'fabric_bag' }, HS.incLowPop,'DUE'],
    ['in_ground soak => SKIP (uniform across vessels)',        { ...OVERDUE, container_type: 'in_ground' },  HS.soak4,    'SKIP'],
    ['raised_bed soak => SKIP',                                { ...OVERDUE, container_type: 'raised_bed' }, HS.soak4,    'SKIP'],
    ['NULL container_type soak => SKIP (fails safe)',          { ...OVERDUE, container_type: null },         HS.soak4,    'SKIP'],
    ['covered + soak => DUE (cap is outdoor-only)',            { ...OVERDUE, container_type: 'fabric_bag', covered: true }, HS.soak4, 'DUE'],
  ];
  for (const [desc, ov, hy, exp] of G) {
    it('flagOFF: ' + desc, () => { expect(bucket(ov, hy, false).b).toBe(exp); });
    it('flagON : ' + desc, () => { expect(bucket(ov, hy, true).b).toBe(exp); });
  }

  it('skip reason names the cause (saturated / incoming)', () => {
    expect(bucket({ ...OVERDUE, container_type: 'fabric_bag' }, HS.soak4).out.tasks.rain_skipped.find(w => w.id === 't').reason).toMatch(/saturat/i);
    expect(bucket({ ...OVERDUE, container_type: 'fabric_bag' }, HS.incWet).out.tasks.rain_skipped.find(w => w.id === 't').reason).toMatch(/incoming/i);
  });

  it('a saturated planting is NOT counted in water_due', () => {
    const { out } = bucket({ ...OVERDUE, container_type: 'fabric_bag' }, HS.soak4);
    expect(out.tasks.water_due.some(w => w.id === 't')).toBe(false);
  });
});
