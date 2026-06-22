// DRG-WATERCREDIT-001 — Path B-plus rain-credit golden fixture (crucible verdict 2026-06-18).
// Hand-adjudicated cases exercising the REAL generatePlanForUser decision path: per-class
// initial-abstraction-then-credit over the recent precip window, transplant carve-out, indoor
// never-credited, cap at one cycle, and the deferral-count-bug fix (skipped != counted as due).
import { describe, it, expect } from 'vitest';
import engine from './engine.js';
const { generatePlanForUser, rainClass, rainCreditDays, RAIN_IA } = engine;

const TODAY = '2026-06-21';
const ago = (d) => { const t = new Date('2026-06-21T00:00:00Z'); t.setUTCDate(t.getUTCDate() - d); return t.toISOString().slice(0, 10); };
const cad = { default: { crop: 'tomato', water_interval_days_inground: 5, water_interval_days_container: 3, water_method: 'soak', soil_moisture_target: 'moist' }, by_variety: {}, by_genus_fallback: {}, pest_watch: {} };
const fm = { amendments_in_inventory: { fruiting_feed: { item: 'a', apply: 'b' }, kelp: { item: 'k' }, veg_feed: { item: 'v', apply: 'w' }, castings: { item: 'c', apply: 'd' } }, water_quality: null };
const wx = { tonightLow: 60, highToday: 75 };
const H = {
  big:    { recent_precip_in: 0.5, today_precip_in: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 },
  small:  { recent_precip_in: 0.1, today_precip_in: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 },
  mid:    { recent_precip_in: 0.3, today_precip_in: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 },
  missing:{ recent_precip_in: null, today_precip_in: null, upcoming_precip_in: null, tomorrow_precip_in: null, tomorrow_pop: null },
  none:   null,
};
function bucket(ov, hy) {
  const p = { id: 't', name: 'X', variety: 'v', genus: 'g', status: 'active', project: 'P', project_id: 'pp', container_type: null, container_size: null, last_water: null, substrate_start: ago(81), ...ov };
  const out = generatePlanForUser([p], cad, fm, TODAY, wx, hy);
  const b = out.tasks.water_due.some(w => w.id === 't') ? 'DUE'
    : out.tasks.rain_skipped.some(w => w.id === 't') ? 'SKIP'
    : out.tasks.no_history.some(w => w.id === 't') ? 'NOHIST' : 'NONE';
  return { b, out };
}

describe('DRG-WATERCREDIT-001: rainClass keying', () => {
  it('in-ground / raised_bed (and cucurbit/leek heuristic) => in_ground', () => {
    expect(rainClass({ container_type: 'in_ground' }, true)).toBe('in_ground');
    expect(rainClass({ container_type: 'raised_bed' }, true)).toBe('in_ground');
  });
  it('outdoor container => container; indoor (shelf/window/tray) + unknown => none', () => {
    expect(rainClass({ container_type: 'container' }, false)).toBe('container');
    expect(rainClass({ container_type: 'tray' }, false)).toBe('none');
    expect(rainClass({ container_type: 'window' }, false)).toBe('none');
    expect(rainClass({ container_type: null }, false)).toBe('none');
  });
});

describe('DRG-WATERCREDIT-001: per-class initial-abstraction', () => {
  it('in-ground Ia 0.15, container Ia 0.25 (Dave-confirmed)', () => {
    expect(RAIN_IA.in_ground).toBe(0.15);
    expect(RAIN_IA.container).toBe(0.25);
  });
  it('credit only when window precip clears Ia', () => {
    expect(rainCreditDays('in_ground', 5, H.small)).toBeNull();   // 0.1 < 0.15
    expect(rainCreditDays('in_ground', 5, H.big)).not.toBeNull(); // 0.5 > 0.15
    expect(rainCreditDays('none', 5, H.big)).toBeNull();          // indoor never
    expect(rainCreditDays('in_ground', 5, H.missing)).toBeNull(); // missing -> no credit
  });
  it('caps credit at one cadence cycle', () => {
    expect(rainCreditDays('in_ground', 5, H.big).credit_days).toBe(5);  // full cycle
    expect(rainCreditDays('container', 3, H.big).credit_days).toBe(1);  // 1-day hold
  });
});

describe('DRG-WATERCREDIT-001: golden decision fixture (real engine)', () => {
  const G = [
    ['in-ground due, no rain', { container_type: 'in_ground', last_water: ago(6) }, H.none, 'DUE'],
    ['in-ground due, big rain -> skip', { container_type: 'in_ground', last_water: ago(6) }, H.big, 'SKIP'],
    ['in-ground, rain under Ia -> due', { container_type: 'in_ground', last_water: ago(6) }, H.small, 'DUE'],
    ['in-ground way overdue, big rain still due (cap 1 cycle)', { container_type: 'in_ground', last_water: ago(20) }, H.big, 'DUE'],
    ['in-ground boundary dW==wi, big rain -> skip', { container_type: 'in_ground', last_water: ago(5) }, H.big, 'SKIP'],
    ['raised_bed = in_ground class -> skip', { container_type: 'raised_bed', last_water: ago(6) }, H.big, 'SKIP'],
    ['container due, no rain', { container_type: 'container', last_water: ago(4) }, H.none, 'DUE'],
    ['container 1-day hold insufficient (dW4) -> due', { container_type: 'container', last_water: ago(4) }, H.big, 'DUE'],
    ['container dW==wi, big rain, 1-day hold -> skip', { container_type: 'container', last_water: ago(3) }, H.big, 'SKIP'],
    ['container mid rain 0.3>0.25 Ia, dW3 -> skip', { container_type: 'container', last_water: ago(3) }, H.mid, 'SKIP'],
    ['container rain under Ia 0.25 -> due', { container_type: 'container', last_water: ago(4) }, H.small, 'DUE'],
    ['indoor tray, big rain -> due (no credit)', { container_type: 'tray', last_water: ago(5) }, H.big, 'DUE'],
    ['indoor window, big rain -> due (no credit)', { container_type: 'window', last_water: ago(5) }, H.big, 'DUE'],
    ['unknown container null, big rain -> due (no credit)', { container_type: null, last_water: ago(6) }, H.big, 'DUE'],
    ['fresh transplant in-ground, big rain -> due (carve-out)', { container_type: 'in_ground', last_water: ago(6), substrate_start: ago(5) }, H.big, 'DUE'],
    ['established in-ground, big rain -> skip', { container_type: 'in_ground', last_water: ago(6), substrate_start: ago(81) }, H.big, 'SKIP'],
    ['missing precip -> due (no credit)', { container_type: 'in_ground', last_water: ago(6) }, H.missing, 'DUE'],
    ['cucurbit null container -> in_ground heuristic -> skip', { genus: 'cucurbita', container_type: null, last_water: ago(6) }, H.big, 'SKIP'],
    ['never watered -> no_history', { container_type: 'in_ground', last_water: null }, H.big, 'NOHIST'],
  ];
  for (const [desc, ov, hy, exp] of G) {
    it(desc + ' => ' + exp, () => { expect(bucket(ov, hy).b).toBe(exp); });
  }
});

describe('DRG-WATERCREDIT-001: deferral count-bug fix', () => {
  it('a rain-credited planting is NOT counted in water_due (lands on rain_skipped)', () => {
    const { b, out } = bucket({ container_type: 'in_ground', last_water: ago(6) }, H.big);
    expect(b).toBe('SKIP');
    expect(out.counts.water_due).toBe(0);
    expect(out.counts.rain_skipped).toBe(1);
    expect(out.tasks.rain_skipped[0].reason).toMatch(/counts as watering/);
  });
  it('a due planting carries a reason string', () => {
    const { out } = bucket({ container_type: 'in_ground', last_water: ago(6) }, H.small);
    const w = out.tasks.water_due.find(x => x.id === 't');
    expect(w.rain_note).toMatch(/soak-in threshold/);
  });
});
