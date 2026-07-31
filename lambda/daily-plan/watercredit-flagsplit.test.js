// DRG-WXFLAGSPLIT-001 F1 — CARE_RAIN_CREDIT_ENABLED (tiered credit) vs CARE_RAIN_MAXDAYS_ENABLED (interval
// ceiling) are now independent flags. F1 ships the split INERT: both default OFF, plan byte-identical.
// F2 (flip credit ON) is a separate, Dave-gated behaviour change and is NOT part of this ship.
//
// Why the split matters: the max-days ceiling clamps the watering interval so a rain-credited planting still
// re-surfaces for a moisture check. Fused to one flag, flipping credit ON also silently shortened every
// interval. Split, F2 can turn credit on with the ceiling still off and observe one change at a time.
//
// Expectations are ORACLE-derived (hand-computed from the constants), not snapshots:
//   cad container interval = 3d. container_type null -> rainTierFor -> 'small_fast'.
//   status 'active' -> rainStageFor -> 'mature'. RAIN_MAX_DAYS.small_fast.mature = 2.
//   crop 'tomato' at stage 'mature' -> no +/-1 modifier -> ceiling = 2.
// A planting last watered 2d ago therefore sits EXACTLY on the seam: due at wi=2 (ceiling on),
// not due at wi=3 (ceiling off). hydrology=null keeps rain credit and the saturation cap out of it.

import { describe, it, expect } from 'vitest';
import engine from './engine.js';
const { generatePlanForUser } = engine;

const TODAY = '2026-06-21';
const ago = (d) => { const t = new Date('2026-06-21T00:00:00Z'); t.setUTCDate(t.getUTCDate() - d); return t.toISOString().slice(0, 10); };
const cad = { default: { crop: 'tomato', water_interval_days_inground: 5, water_interval_days_container: 3, water_method: 'soak', soil_moisture_target: 'moist' }, by_variety: {}, by_genus_fallback: {}, pest_watch: {} };
const fm = { amendments_in_inventory: { fruiting_feed: { item: 'a', apply: 'b' }, kelp: { item: 'k' }, veg_feed: { item: 'v', apply: 'w' }, castings: { item: 'c', apply: 'd' } }, water_quality: null };
const wx = { tonightLow: 60, highToday: 75 };

const base = (ov = {}) => ({ id: 't', name: 'X', variety: 'v', genus: 'g', status: 'active', project: 'P', project_id: 'pp', container_type: null, container_size: null, covered: false, last_water: ago(2), substrate_start: ago(81), transplant_at: null, ...ov });

function bucket(ov, hy, credit = false, maxdays = false) {
  const out = generatePlanForUser([base(ov)], cad, fm, TODAY, wx, hy, credit, maxdays);
  const b = out.tasks.water_due.some(w => w.id === 't') ? 'DUE'
    : out.tasks.rain_skipped.some(w => w.id === 't') ? 'SKIP'
      : out.tasks.no_history.some(w => w.id === 't') ? 'NOHIST' : 'NONE';
  return { b, out };
}

describe('DRG-WXFLAGSPLIT-001 F1: the ceiling flag is independent of the credit flag', () => {
  // The 4-way matrix. The ceiling column is what decides this planting's bucket; the credit column must not.
  const MATRIX = [
    ['credit OFF / maxdays OFF (today\'s prod state)', false, false, 'NONE'],
    ['credit ON  / maxdays OFF (what F2 will flip to)', true, false, 'NONE'],
    ['credit OFF / maxdays ON', false, true, 'DUE'],
    ['credit ON  / maxdays ON  (fully on)', true, true, 'DUE'],
  ];
  for (const [desc, credit, maxdays, exp] of MATRIX) {
    it(`${desc} => ${exp}`, () => {
      expect(bucket({}, null, credit, maxdays).b).toBe(exp);
    });
  }

  it('the ceiling is driven by maxdays ALONE — flipping credit does not move it either way', () => {
    expect(bucket({}, null, false, true).b).toBe(bucket({}, null, true, true).b);
    expect(bucket({}, null, false, false).b).toBe(bucket({}, null, true, false).b);
  });

  it('F1 is inert: omitting the new arg equals passing it false', () => {
    // Every pre-split caller passes 7 args. The default must reproduce the old plan exactly.
    const old7 = generatePlanForUser([base()], cad, fm, TODAY, wx, null, false);
    const new8 = generatePlanForUser([base()], cad, fm, TODAY, wx, null, false, false);
    expect(new8).toEqual(old7);
  });

  it('F1 is inert under credit-ON too: 7-arg call equals 8-arg with ceiling off', () => {
    const old7 = generatePlanForUser([base()], cad, fm, TODAY, wx, null, true);
    const new8 = generatePlanForUser([base()], cad, fm, TODAY, wx, null, true, false);
    expect(new8).toEqual(old7);
  });
});

describe('DRG-WXFLAGSPLIT-001 F1: the saturation cap survives the new flag (boss Add 1, extended)', () => {
  // DRG-WXSATCAP-001 is flag-INDEPENDENT by design — a cap that lived in one flag branch would be silently
  // deleted by a flip. watercredit-satcap.test.js proves that across the credit flag; this extends the same
  // guard to the NEW flag, so the F1 split cannot become a second bypass route.
  const soak = { recent_precip_in: 3.0, today_precip_in: 1.0, upcoming_precip_in: 0.8, tomorrow_precip_in: 0.8, tomorrow_pop: 80 }; // wp=4.0
  const OVERDUE = { last_water: ago(10) }; // way past any interval, ceiling or not -> DUE absent the cap
  for (const [credit, maxdays] of [[false, false], [true, false], [false, true], [true, true]]) {
    it(`credit=${credit} maxdays=${maxdays}: 4" soak on an outdoor planting still SKIPs`, () => {
      expect(bucket(OVERDUE, soak, credit, maxdays).b).toBe('SKIP');
    });
    it(`credit=${credit} maxdays=${maxdays}: covered planting is still exempt from the cap`, () => {
      expect(bucket({ ...OVERDUE, covered: true }, soak, credit, maxdays).b).toBe('DUE');
    });
  }
});
