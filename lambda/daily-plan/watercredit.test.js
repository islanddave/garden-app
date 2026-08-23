// DRG-WATERCREDIT-001 — Path B-plus rain-credit golden fixture, V1 2-class (covered vs outdoor).
// Crucible verdict 2026-06-18 + Dave 2026-06-21: bed-vs-container isn't in the data, so V1 keys on
// covered (under cover -> never credited) vs outdoor (one conservative profile: 0.25in soak-in threshold,
// 1-day hold), with the transplant carve-out. Exercises the REAL generatePlanForUser decision path.
import { describe, it, expect } from 'vitest';
import engine from './engine.js';
import _cf from './_coverFlags.js';
const { withCoverFlags } = _cf;  // BUG-NOLOCOUTDOOR-001 fixture bridge
const { generatePlanForUser, rainClass, rainCreditDays, RAIN_IA, isSmallVessel, vesselSizeSmall } = engine;

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
  const p = withCoverFlags({ id: 't', name: 'X', variety: 'v', genus: 'g', status: 'active', project: 'P', project_id: 'pp', container_type: null, container_size: null, covered: false, last_water: null, substrate_start: ago(81), transplant_at: null, ...ov });
  const out = generatePlanForUser([p], cad, fm, TODAY, wx, hy);
  const b = out.tasks.water_due.some(w => w.id === 't') ? 'DUE'
    : out.tasks.rain_skipped.some(w => w.id === 't') ? 'SKIP'
    : out.tasks.no_history.some(w => w.id === 't') ? 'NOHIST' : 'NONE';
  return { b, out };
}

describe('DRG-WATERCREDIT-001 V1: 2-class keying (covered vs outdoor)', () => {
  it('covered => none (never credited); outdoor => outdoor profile', () => {
    // BUG-NOLOCOUTDOOR-001: rainClass now keys on rain_exposed_resolved (SQL `state IS FALSE`),
    // not the raw `covered` boolean. Known-covered and known-outdoor behave exactly as before.
    expect(rainClass({ rain_exposed_resolved: false })).toBe('none');
    expect(rainClass({ rain_exposed_resolved: true })).toBe('outdoor');
  });

  it('an UNKNOWN location is never rain-credited (the fail-safe direction)', () => {
    // The rain half of the asymmetry. An un-located planting carries rain_exposed_resolved=false,
    // so it classes as 'none' and can never be credited for rain it may not have received.
    // Its frost twin runs the OPPOSITE way — see frostClass.test.js's matching case.
    expect(rainClass({ rain_exposed_resolved: false, frost_covered_resolved: false })).toBe('none');
  });

  it('rainClass does NOT fall back to the retired `covered` field', () => {
    // The rename is the fix. A fallback would make an un-located planting (covered:false, no
    // resolved flag) indistinguishable from a genuinely outdoor one — which is the bug — while
    // every assertion above still passed. `covered: false` alone must NOT yield 'outdoor'.
    expect(rainClass({ covered: false })).toBe('none');
    expect(rainClass({})).toBe('none');
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
    ['fresh transplant outdoor (transplant_at recent), big rain -> due (carve-out)', { covered: false, last_water: ago(3), transplant_at: ago(5) }, H.big, 'DUE'],
    ['DRG-WATERCREDIT-002: established, recent substrate_start but transplant_at NULL, big rain -> skip (created_at no longer carves out)', { covered: false, last_water: ago(3), substrate_start: ago(5), transplant_at: null }, H.big, 'SKIP'],
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
    const { out } = bucket({ covered: false, last_water: ago(3), transplant_at: ago(5) }, H.big);
    const w = out.tasks.water_due.find(x => x.id === 't');
    expect(w.rain_note).toMatch(/fresh transplant/);
  });
});


describe('DRG-WATERCREDIT-003 V1: vessel-aware fresh-transplant carve-out', () => {
  it('isSmallVessel: small types + small sizes => true', () => {
    expect(isSmallVessel({ container_type: 'tray_cell', container_size: '2 in' })).toBe(true);
    expect(isSmallVessel({ container_type: 'soil_block', container_size: '4 in' })).toBe(true);
    expect(isSmallVessel({ container_type: 'solo_cup', container_size: null })).toBe(true);
    expect(isSmallVessel({ container_type: 'plastic_pot', container_size: '4 in' })).toBe(true);
    expect(isSmallVessel({ container_type: 'fabric_bag', container_size: '3 in' })).toBe(true);
  });
  it('isSmallVessel: large types + >=1gal sizes => false (established, gets rain credit)', () => {
    expect(isSmallVessel({ container_type: 'fabric_bag', container_size: '5 gal' })).toBe(false);
    expect(isSmallVessel({ container_type: 'trough', container_size: '6x2 ft' })).toBe(false);
    expect(isSmallVessel({ container_type: 'in_ground', container_size: null })).toBe(false);
    expect(isSmallVessel({ container_type: 'plastic_pot', container_size: '6 in' })).toBe(false);
    expect(isSmallVessel({ container_type: 'plastic_pot', container_size: '1 gal' })).toBe(false);
  });
  it('isSmallVessel: unknown/null vessel fails safe to small (deny credit -> water it)', () => {
    expect(isSmallVessel({ container_type: null, container_size: null })).toBe(true);
    expect(isSmallVessel({ container_type: 'plastic_pot', container_size: 'garbage' })).toBe(true);
    expect(isSmallVessel({ container_type: null, container_size: '5 gal' })).toBe(false); // known-large size still wins
  });
  it('vesselSizeSmall: boundary + unit parsing', () => {
    expect(vesselSizeSmall('4 in')).toBe(true);
    expect(vesselSizeSmall('4.5 in')).toBe(false);
    expect(vesselSizeSmall('1 qt')).toBe(true);
    expect(vesselSizeSmall('0.5qt')).toBe(true);
    expect(vesselSizeSmall('1 gal')).toBe(false);
    expect(vesselSizeSmall('6x2 ft')).toBe(false);
    expect(vesselSizeSmall(null)).toBeNull();
    expect(vesselSizeSmall('no units here')).toBeNull();
  });

  // Behavioral: a RECENT transplant (within 21d) in a LARGE vessel now gets rain credit (no longer carved out);
  // the SAME recency in a SMALL vessel stays carved out (Dave 2026-06-24: established 5-gal bag peppers were
  // wrongly labeled "fresh transplant" daily after rain).
  it('large-vessel recent transplant + big rain => SKIP (credited; carve-out no longer applies)', () => {
    const { b, out } = bucket({ covered: false, last_water: ago(3), transplant_at: ago(5), container_type: 'fabric_bag', container_size: '5 gal' }, H.big);
    expect(b).toBe('SKIP');
    expect(out.tasks.rain_skipped[0].reason).toMatch(/counts as watering/);
  });
  it('small-vessel recent transplant + big rain => DUE (carve-out still applies)', () => {
    const { b, out } = bucket({ covered: false, last_water: ago(3), transplant_at: ago(5), container_type: 'tray_cell', container_size: '2 in' }, H.big);
    expect(b).toBe('DUE');
    const w = out.tasks.water_due.find(x => x.id === 't');
    expect(w.rain_note).toMatch(/fresh transplant/);
  });
});

describe('DRG-WATERCREDIT-004: hot-day fabric-bag heat-gate (>=85°F)', () => {
  const wxHot = { tonightLow: 70, highToday: 90 };
  const wxMild = { tonightLow: 60, highToday: 80 };
  const wxEdge = { tonightLow: 65, highToday: 85 }; // exactly at the gate
  const mk = (ov, hy, weather) => {
    const p = withCoverFlags({ id: 't', name: 'X', variety: 'v', genus: 'g', status: 'active', project: 'P', project_id: 'pp', container_type: null, container_size: null, covered: false, last_water: null, substrate_start: ago(81), transplant_at: null, ...ov });
    const out = generatePlanForUser([p], cad, fm, TODAY, weather, hy);
    const b = out.tasks.water_due.some(w => w.id === 't') ? 'DUE'
      : out.tasks.rain_skipped.some(w => w.id === 't') ? 'SKIP' : 'OTHER';
    return { b, out };
  };
  // BUG-HEATDEMOTETOTAL-001 (2026-08-23) — these two cases previously asserted DUE at 90°F and at the
  // 85°F edge, which pinned the gate's TOTAL DENIAL (`bagHeatGate ? rc=null`). That denial is the
  // defect: the gate is documented as a demotion and now is one. On THIS 2-class flag-OFF path the
  // demotion has no room to move — RAIN_HOLD_DAYS is 1, which is already bagHeatMinCreditDays — so the
  // hot bag now keeps the same 1 day a mild one gets and drops to rain_skipped at dW == wi. The gate
  // still fires (the note proves it), and the cases where it still changes the OUTCOME are the
  // in-flag/live ones, measured in heatdemote.test.js (3 credit-days -> 1 at >=85°F).
  it('established outdoor fabric bag, big rain, HOT day => SKIP at the 1-day floor, gate named in the reason', () => {
    const { b, out } = mk({ container_type: 'fabric_bag', container_size: '5 gal', last_water: ago(3) }, H.big, wxHot);
    expect(b).toBe('SKIP');
    const r = out.tasks.rain_skipped.find(w => w.id === 't');
    expect(r.credited_days).toBe(1);
    expect(r.reason).toMatch(/fabric bag dries fast at 90°F/i);
  });
  it('SAME fabric bag, big rain, MILD day => SKIP (credit applies)', () => {
    const { b, out } = mk({ container_type: 'fabric_bag', container_size: '5 gal', last_water: ago(3) }, H.big, wxMild);
    expect(b).toBe('SKIP');
    // The discriminator on this path is the reason, not the bucket: no gate, no bag clause.
    expect(out.tasks.rain_skipped.find(w => w.id === 't').reason).not.toMatch(/fabric bag/i);
  });
  it('fabric bag at exactly 85°F => gate fires (inclusive), credit floored not erased', () => {
    const { b, out } = mk({ container_type: 'fabric_bag', container_size: '5 gal', last_water: ago(3) }, H.big, wxEdge);
    expect(b).toBe('SKIP');
    expect(out.tasks.rain_skipped.find(w => w.id === 't').reason).toMatch(/fabric bag dries fast at 85°F/i);
  });
  it('hot day but NON-fabric vessel (in_ground) => SKIP (gate is fabric-only)', () => {
    expect(mk({ container_type: 'in_ground', container_size: null, last_water: ago(5) }, H.big, wxHot).b).toBe('SKIP'); // in_ground uses the 5d interval
  });
  it('hot day, COVERED fabric bag => DUE (covered never credited; no misleading bag note)', () => {
    const { b, out } = mk({ container_type: 'fabric_bag', container_size: '5 gal', covered: true, last_water: ago(3) }, H.big, wxHot);
    expect(b).toBe('DUE');
    expect(out.tasks.water_due.find(w => w.id === 't').rain_note ?? '').not.toMatch(/fabric bag dries fast/i);
  });
  it('hot day, fabric bag, NO qualifying rain => DUE via normal path (gate is a no-op without rain)', () => {
    expect(mk({ container_type: 'fabric_bag', container_size: '5 gal', last_water: ago(4) }, H.none, wxHot).b).toBe('DUE');
  });
});
