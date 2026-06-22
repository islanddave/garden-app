// DRG-WATERCREDIT-001 — Path B-plus rain-credit golden fixture, V1 2-class (covered vs outdoor).
// Crucible verdict 2026-06-18 + Dave 2026-06-21: bed-vs-container isn't in the data, so V1 keys on
// covered (under cover -> never credited) vs outdoor (one conservative profile: 0.25in soak-in threshold,
// 1-day hold), with the transplant carve-out. Exercises the REAL generatePlanForUser decision path.
import { describe, it, expect } from 'vitest';
import engine from './engine.js';
const { generatePlanForUser, rainClass, rainCreditDays, RAIN_IA } = engine;

const TODAY = '2026-06-21';
const ago = (d) => { const t = new Date('2026-06-21T00:00:00Z'); t.setUTCDate(t.getUTCDate() - d); return t.toISOString().slice(0, 10); };
const cad = { default: { crop: 'tomato', water_interval_days_inground: 5, water_interval_days_container: 3, water_method: 'soak', soil_moisture_target: 'moist' }, by_variety: {}, by_genus_fallback: {}, pest_watch: {} };
const fm = { amendments_in_inventory: { fruiting_feed: { item: 'a', apply: 'b' }, kelp: { item: 'k' }, veg_feed: { item: 'v', apply: 'w' }, castings: { item: 'c', apply: 'd' } }, water_quality: null };
const wx = { tonightLow: 60, highToday: 75 };
const H = {
  big:    { recent_precip_in: 0.5,  today_precip_in: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 },
  edge:   { recent_precip_in: 0.26, today_precip_in: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 },
  under:  { recent_precip_in: 0.2,  today_precip_in: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 },
  missing:{ recent_precip_in: null, today_precip_in: null, upcoming_precip_in: null, tomorrow_precip_in: null, tomorrow_pop: null },
  none:   null,
};
function bucket(ov, hy) {
  const p = { id: 't', name: 'X', variety: 'v', genus: 'g', status: 'active', project: 'P', project_id: 'pp', container_type: null, container_size: null, covered: false, last_water: null, substrate_start: ago(81), ...ov };
  const out = generatePlanForUser([p], cad, fm, TODAY, wx, hy);
  const b = out.tasks.water_due.some(w => w.id === 't') ? 'DUE'
    : out.tasks.rain_skipped.some(w => w.id === 't') ? 'SKIP'
    : out.tasks.no_history.some(w => w.id === 't') ? 'NOHIST' : 'NONE';
  return { b, out };
}

describe('DRG-WATERCREDIT-001 V1: 2-class keying (covered vs outdoor)', () => {
  it('covered => none (never credited); outdoor => outdoor profile', () => {
    expect(rainClass({ covered: true })).toBe('none');
    expect(rainClass({ covered: false })).toBe('outdoor');
  });
  it('single conservative outdoor initial-abstraction = 0.25in; no in_ground class in V1', () => {
    expect(RAIN_IA.outdoor).toBe(0.25);
    expect(RAIN_IA.in_ground).toBeUndefined();
  });
  it('credit only for outdoor + only when window precip clears 0.25in; capped at one cycle (1-day hold)', () => {
    expect(rainCreditDays('none', 5, H.big)).toBeNull();
    expect(rainCreditDays('outdoor', 5, H.under)).toBeNull();   // 0.2 < 0.25
    expect(rainCreditDays('outdoor', 5, H.big)).not.toBeNull(); // 0.5 > 0.25
    expect(rainCreditDays('outdoor', 5, H.big).credit_days).toBe(1);  // short hold
    expect(rainCreditDays('outdoor', 5, H.missing)).toBeNull();
  });
});

describe('DRG-WATERCREDIT-001 V1: golden decision fixture (real engine)', () => {
  const G = [
    ['outdoor due, no rain', { covered: false, last_water: ago(4) }, H.none, 'DUE'],
    ['outdoor dW==wi, big rain, 1-day hold -> skip', { covered: false, last_water: ago(3) }, H.big, 'SKIP'],
    ['outdoor 1 day overdue, 1-day hold insufficient -> due', { covered: false, last_water: ago(4) }, H.big, 'DUE'],
    ['outdoor, rain just over Ia (0.26), dW==wi -> skip', { covered: false, last_water: ago(3) }, H.edge, 'SKIP'],
    ['outdoor, rain under Ia (0.2) -> due', { covered: false, last_water: ago(3) }, H.under, 'DUE'],
    ['outdoor way overdue, big rain still due (cap 1 cycle)', { covered: false, last_water: ago(10) }, H.big, 'DUE'],
    ['covered (Stable/House/shelf), big rain -> due (no credit)', { covered: true, last_water: ago(5) }, H.big, 'DUE'],
    ['covered, dW==wi, big rain -> due (never credited)', { covered: true, last_water: ago(3) }, H.big, 'DUE'],
    ['fresh transplant outdoor, big rain -> due (carve-out)', { covered: false, last_water: ago(3), substrate_start: ago(5) }, H.big, 'DUE'],
    ['established outdoor, big rain -> skip', { covered: false, last_water: ago(3), substrate_start: ago(81) }, H.big, 'SKIP'],
    ['missing precip -> due (no credit)', { covered: false, last_water: ago(3) }, H.missing, 'DUE'],
    ['no hydrology -> due', { covered: false, last_water: ago(3) }, H.none, 'DUE'],
    ['never watered -> no_history', { covered: false, last_water: null }, H.big, 'NOHIST'],
  ];
  for (const [desc, ov, hy, exp] of G) {
    it(desc + ' => ' + exp, () => { expect(bucket(ov, hy).b).toBe(exp); });
  }
});

describe('DRG-WATERCREDIT-001 V1: deferral count-bug fix + reasons', () => {
  it('a rain-credited planting is NOT counted in water_due (lands on rain_skipped with a reason)', () => {
    const { b, out } = bucket({ covered: false, last_water: ago(3) }, H.big);
    expect(b).toBe('SKIP');
    expect(out.counts.water_due).toBe(0);
    expect(out.counts.rain_skipped).toBe(1);
    expect(out.tasks.rain_skipped[0].reason).toMatch(/counts as watering/);
  });
  it('a due planting under the soak-in threshold carries a reason string', () => {
    const { out } = bucket({ covered: false, last_water: ago(3) }, H.under);
    const w = out.tasks.water_due.find(x => x.id === 't');
    expect(w.rain_note).toMatch(/soak-in threshold/);
  });
  it('fresh-transplant due carries the carve-out reason', () => {
    const { out } = bucket({ covered: false, last_water: ago(3), substrate_start: ago(5) }, H.big);
    const w = out.tasks.water_due.find(x => x.id === 't');
    expect(w.rain_note).toMatch(/fresh transplant/);
  });
});
