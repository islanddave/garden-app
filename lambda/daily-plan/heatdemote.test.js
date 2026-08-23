// BUG-HEATDEMOTETOTAL-001 — the >=85F fabric-bag rain rule must DEMOTE credit, not deny it.
//
// The filed defect was about the ledger path's demoteDepth('light') -> null. Investigating it found a
// strictly worse instance on the LEGACY path, which is the one prod runs (CARE_WATER_LEDGER_ENABLED
// unset; CARE_RAIN_CREDIT_ENABLED=true, verified on the live Lambda config 2026-08-23): the engine
// short-circuited `bagHeatGate ? null`, so an outdoor fabric bag that had earned the full
// fabric_ground credit got ZERO at any rain depth. Measured before the fix, 5-gal bag / 0.5" window
// rain / wi=3: 84F -> 3 credit-days, 85F -> 0, 90F -> 0.
//
// Every number below is measured end-to-end through generatePlanForUser, not read off the source.
// The credit is recovered from the plan the way the garden experiences it: the largest
// days-since-water that still lands on rain_skipped. A planting skips iff dW >= wi and
// dW - credit < wi, so credit = maxSkipDW - wi + 1 (0 when nothing at/over the interval skips).
import { describe, it, expect } from 'vitest';
import engine from './engine.js';
import ledger from './ledger.js';
import LP from './ledgerParams.js';
import _cf from './_coverFlags.js';
const { withCoverFlags } = _cf;
const { generatePlanForUser, BAG_HEAT_GATE_F, bagHeatDemoteCredit, RAIN_TIER_HOLD } = engine;

const TODAY = '2026-06-21';
const ago = (d) => { const t = new Date(TODAY + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - d); return t.toISOString().slice(0, 10); };
const WI = 3;   // cad.default.water_interval_days_container
const cad = { default: { crop: 'tomato', water_interval_days_inground: 5, water_interval_days_container: WI, water_method: 'soak', soil_moisture_target: 'moist' }, by_variety: {}, by_genus_fallback: {}, pest_watch: {} };
const fm = { amendments_in_inventory: { fruiting_feed: { item: 'a', apply: 'b' }, kelp: { item: 'k' }, veg_feed: { item: 'v', apply: 'w' }, castings: { item: 'c', apply: 'd' } }, water_quality: null };
const hy = (recent) => ({ recent_precip_in: recent, today_precip_in: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 });
const RAIN = hy(0.5);             // clears both IAs (outdoor 0.25, fabric_ground 0.20)
const BAG = { container_type: 'fabric_bag', container_size: '5 gal' };
const wxAt = (highToday) => ({ tonightLow: 60, highToday });

// LIVE prod configuration unless a case says otherwise.
function plan(ov, weather, hydrology = RAIN, rainCreditEnabled = true) {
  const p = withCoverFlags({ id: 't', name: 'X', variety: 'v', genus: 'g', status: 'active', project: 'P', project_id: 'pp',
    container_type: null, container_size: null, covered: false, last_water: null, substrate_start: ago(81), transplant_at: null, ...ov });
  const out = generatePlanForUser([p], cad, fm, TODAY, weather, hydrology, rainCreditEnabled, false, false, null);
  const skipped = out.tasks.rain_skipped.find((w) => w.id === 't');
  const due = out.tasks.water_due.find((w) => w.id === 't');
  return { bucket: skipped ? 'SKIP' : due ? 'DUE' : 'OTHER', skipped, due };
}

function appliedCreditDays(tmax, ov = BAG, rainCreditEnabled = true, hydrology = RAIN) {
  let maxSkip = null;
  for (let dW = WI; dW <= WI + 12; dW++) {
    if (plan({ ...ov, last_water: ago(dW) }, wxAt(tmax), hydrology, rainCreditEnabled).bucket === 'SKIP') maxSkip = dW;
  }
  return maxSkip == null ? 0 : maxSkip - WI + 1;
}

describe('BUG-HEATDEMOTETOTAL-001 — >=85F bag rain credit is reduced, never erased (LIVE config)', () => {
  it('a bag that earns credit keeps some of it at every hot temperature', () => {
    // THE defect, stated as its own assertion. Pre-fix every one of these read 0.
    for (const tmax of [85, 86, 88, 90, 95, 105]) {
      expect(appliedCreditDays(tmax), `${tmax}F denied credit outright`).toBeGreaterThanOrEqual(1);
    }
  });

  it('measured credit-days: 3 below the gate, 1 at and above it', () => {
    expect(appliedCreditDays(80)).toBe(3);
    expect(appliedCreditDays(84)).toBe(3);
    expect(appliedCreditDays(85)).toBe(1);   // gate is inclusive at exactly 85F
    expect(appliedCreditDays(90)).toBe(1);
  });

  it('it is a REDUCTION — hot credit is strictly less than the un-gated credit', () => {
    // Paired with the >=1 assertion above: alone this passes on the pre-fix total denial too.
    expect(appliedCreditDays(90)).toBeLessThan(appliedCreditDays(84));
    expect(appliedCreditDays(84)).toBe(Math.min(RAIN_TIER_HOLD.fabric_ground, WI));
  });

  it('the published credited_days carries the demoted number, and the reason names the cut', () => {
    const hot = plan({ ...BAG, last_water: ago(WI) }, wxAt(90));
    expect(hot.bucket).toBe('SKIP');
    expect(hot.skipped.credited_days).toBe(1);
    expect(hot.skipped.reason).toMatch(/fabric bag dries fast at 90°F: 1d credit, cut from 3d/);
    const mild = plan({ ...BAG, last_water: ago(WI) }, wxAt(84));
    expect(mild.skipped.credited_days).toBe(3);
    expect(mild.skipped.reason).not.toMatch(/cut from/);
  });

  it('a bag still short of its interval after the cut is due, and the note says why', () => {
    const out = plan({ ...BAG, last_water: ago(6) }, wxAt(90));
    expect(out.bucket).toBe('DUE');
    expect(out.due.rain_note).toMatch(/fabric bag dries fast at 90°F: 0\.5" rain credited at 1d \(cut from 3d\)/);
  });

  it('a hot bag whose rain never cleared the soak-in threshold blames the THRESHOLD, not the heat', () => {
    // Pre-fix this said "rain credit withheld on hot days" — naming a cause that did not apply, since
    // there was no credit to withhold. The gate fires on temperature alone; the note must not.
    const out = plan({ ...BAG, last_water: ago(WI) }, wxAt(90), hy(0.1));
    expect(out.bucket).toBe('DUE');
    expect(out.due.rain_note).toMatch(/soak-in threshold/);
    expect(out.due.rain_note).not.toMatch(/withheld/);
  });
});

describe('BUG-HEATDEMOTETOTAL-001 — the demotion reads named constants, not literals', () => {
  it('bagHeatDemoteCredit = max(bagHeatMinCreditDays, floor(credit x bagHeatSoftenFactor))', () => {
    const f = LP.RAIN_DAY.bagHeatSoftenFactor, min = LP.RAIN_DAY.bagHeatMinCreditDays;
    for (const base of [1, 2, 3, 4, 7]) {
      expect(bagHeatDemoteCredit({ credit_days: base }).credit_days).toBe(Math.max(min, Math.floor(base * f)));
    }
  });
  it('the floor holds even where the factor alone would zero the credit', () => {
    // The structural half of the fix: a retune of the factor must not be able to restore the denial.
    expect(bagHeatDemoteCredit({ credit_days: 1 }).credit_days).toBe(LP.RAIN_DAY.bagHeatMinCreditDays);
    expect(LP.RAIN_DAY.bagHeatMinCreditDays).toBeGreaterThanOrEqual(1);
  });
  it('nothing earned -> nothing to demote (null passes through, no phantom credit)', () => {
    expect(bagHeatDemoteCredit(null)).toBeNull();
  });
  it('the engine gate temperature and the params one are the same number', () => {
    // Two spellings of 85 with nothing pinning them together until now.
    expect(BAG_HEAT_GATE_F).toBe(LP.RAIN_DAY.bagHeatSoftenF);
  });
});

describe('BUG-HEATDEMOTETOTAL-001 — scope: what the fix deliberately does NOT change', () => {
  it('a fresh transplant in a small vessel is still a FULL denial', () => {
    // A demotion is right for a bag that holds water; it is wrong for a small root ball.
    const out = plan({ container_type: 'solo_cup', container_size: '0.5 qt', last_water: ago(WI), transplant_at: ago(5) }, wxAt(90));
    expect(out.bucket).toBe('DUE');
    expect(out.due.rain_note).toMatch(/fresh transplant/);
  });
  it('a covered bag is still never credited, hot or not', () => {
    const out = plan({ ...BAG, covered: true, last_water: ago(WI) }, wxAt(90));
    expect(out.bucket).toBe('DUE');
    expect(out.due.rain_note ?? '').not.toMatch(/fabric bag/i);
  });
  it('a non-fabric vessel keeps its full credit at 90F (the gate is still fabric-only)', () => {
    // Compared across the gate rather than against a literal: these vessels take their own intervals
    // (in_ground runs the 5-day one), and the claim is that 85F moves NEITHER of them.
    for (const v of [{ container_type: 'in_ground', container_size: null },
      { container_type: 'plastic_pot', container_size: '2 gal' }]) {
      const mild = appliedCreditDays(84, v), hot = appliedCreditDays(90, v);
      expect(hot, `${v.container_type} moved across the gate`).toBe(mild);
      expect(hot).toBeGreaterThan(0);
    }
  });
  it('the LEDGER path rule is untouched — demoteDepth still walks one class and light still falls off', () => {
    // The flip-time replacement of THIS rule is deferred by crucible verdict C5 (ledgerParams
    // RAIN_DAY). This fix is the legacy path only; the two must not be folded together.
    expect(ledger.demoteDepth('deep')).toBe('normal');
    expect(ledger.demoteDepth('normal')).toBe('light');
    expect(ledger.demoteDepth('light')).toBeNull();
  });
});

describe('BUG-HEATDEMOTETOTAL-001 — the legacy 2-class path cannot express the demotion', () => {
  it('flag-OFF base credit IS the minimum, so the hot credit equals the mild one', () => {
    // Not a bug and not a regression: RAIN_HOLD_DAYS is 1, and there is nothing between one day and
    // none. Recorded so a future reader does not read the equality as the gate having been deleted.
    // The gate still fires there — it just has no resolution to demote into.
    expect(appliedCreditDays(84, BAG, false)).toBe(1);
    expect(appliedCreditDays(90, BAG, false)).toBe(1);
  });
});
