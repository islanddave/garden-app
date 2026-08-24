// rainforecastcredit.test.js — BUG-RAINFORECASTCREDIT-001: rain credit must spend MEASURED rain only.
//
// THE DEFECT. windowPrecip's own comment (engine.js:211-217) states the contract: the D0 term is
// `today_observed_in + today_remaining_in` — measured gauge rain PLUS the hourly forecast for hours not
// yet elapsed — "part-measured/part-predicted, in a ratio that moves through the day", and "any gate
// that must distinguish the two reads today_observed_in / today_remaining_in — never this sum."
// Rain credit is the strongest such gate in the engine: it retires a real watering task. It read the sum.
//
// THE ORACLE IS PROD. 2026-08-23, v4.45.0: 35 plantings rain-skipped while only 0.09" had actually
// fallen — 0.13" of the credited 0.22" was still forecast. And at the 02:00 run (the one that builds the
// morning list) index.js reads Open-Meteo precipitation_sum[2] "for a day that has not started", so the
// D0 term there is 100% prediction. Those figures are the fixtures below.
//
// WHY A NEW FILE, AND WHY THESE ASSERTIONS. todayrain.test.js records that this suite had "essentially
// ZERO discriminating power" over the today-rain axis — two mutations each killed the same two goldens,
// both times on an incidental substring. The satcap fixtures deliberately park precipitation in
// recent_precip_in to isolate the cap, so they cannot see this at all. Every assertion here is written to
// FAIL if creditPrecip ignores its measuredOnly argument; M1 is the explicit mutation guard.
import { describe, it, expect } from 'vitest';
import engine from './engine.js';
import _cf from './_coverFlags.js';
const { withCoverFlags } = _cf;

const { generatePlanForUser } = engine;

const TODAY = '2026-08-23';
const CAD = {
  default: { water_interval_days_container: 3, water_interval_days_inground: 3, crop: 'generic' },
  by_variety: {}, by_genus_fallback: {},
};
const FM = { water_quality: { implications: [] } };

// Split hydrology: `today` is the SUM the old path spent; observed/remaining are the two components the
// contract says a distinguishing gate must read. Keeping all three explicit is the point of the file.
const H = ({ recent = 0, observed = null, remaining = 0, pop = 0 }) => ({
  recent_precip_in: recent,
  today_precip_in: (observed || 0) + (remaining || 0),
  ...(observed == null ? {} : { today_observed_in: observed }),
  today_remaining_in: remaining,
  today_pop: pop,
  tomorrow_precip_in: 0, tomorrow_pop: null, upcoming_precip_in: 0,
});

// in_ground: a named LARGE vessel. isSmallVessel() is true for an unset container_type (fail-safe), which
// would route through the small-vessel bar and silently test a different path. Same trap todayrain.test.js
// documents. rain_exposed true so the row is credit-eligible at all (rainClass -> 'outdoor').
const plant = (over = {}) => withCoverFlags({
  id: 'p1', name: 'Test Planting', project: 'Proj', project_id: 'pr1', workspace_id: 'w1',
  genus: 'generic', status: 'growing', covered: false,
  container_type: 'in_ground', container_size: null,
  // dW = 4 vs interval 3. Chosen so credit can actually FLIP the verdict: in_ground HOLD is 3 days, so a
  // row must be due (dW >= 3) but within reach of the credit (dW - 3 < 3), i.e. dW in {3,4,5}. A far-overdue
  // row like dW=10 stays due under BOTH flag states — the assertions would then be green-by-coincidence and
  // measure nothing, which is precisely the vacuity this file's M1 guard exists to rule out.
  last_water: '2026-08-19',
  transplant_at: null, rain_exposed: true, ...over,
});

// measuredCredit is the 11th positional arg on generatePlanForUser. todayAware is OFF here deliberately:
// it gates saturationSuppressed, and a soak/incoming suppression would retire the row through a DIFFERENT
// branch and mask what the credit path did. This file tests credit, so credit must be the only lever.
function verdict({ hy, p = {}, measuredCredit = false }) {
  const wx = { tonightLow: 60, highToday: 75, code: 0, short: '', unit: 'F' };
  const plan = generatePlanForUser(
    [plant(p)], CAD, FM, TODAY, wx, hy,
    /* rainCreditEnabled */ true, /* rainMaxDaysEnabled */ false, /* todayAwareEnabled */ false,
    /* ledgerOpts */ null, /* measuredCreditEnabled */ measuredCredit,
  );
  const t = plan.tasks || {};
  const w = (t.water_due || []).find(r => r.id === 'p1');
  const s = (t.rain_skipped || []).find(r => r.id === 'p1');
  if (w) return { bucket: 'water', row: w };
  if (s) return { bucket: 'skip', row: s };
  return { bucket: 'absent', row: null };
}

// The prod incident, split into its true components: 0.09" fell, 0.13" was still forecast.
const PROD_0823 = { recent: 0, observed: 0.09, remaining: 0.13, pop: 60 };
// The 02:00 case: nothing measured yet at all, the whole D0 term is prediction.
const NIGHTLY = { recent: 0, observed: 0, remaining: 0.40, pop: 80 };

describe('BUG-RAINFORECASTCREDIT-001 — credit spends measured rain only', () => {
  it('F1 flag OFF reproduces the defect: unfallen forecast rain retires the watering', () => {
    const v = verdict({ hy: H(NIGHTLY), measuredCredit: false });
    expect(v.bucket).toBe('skip');            // 0.40" of pure prediction bought a skip
  });

  it('F2 flag ON: the same fully-forecast day does NOT retire the watering', () => {
    const v = verdict({ hy: H(NIGHTLY), measuredCredit: true });
    expect(v.bucket).toBe('water');
  });

  it('F3 flag ON: measured rain still earns credit — this is not a blanket denial', () => {
    // 0.60" actually on the ground, comfortably past RAIN_IA/tier IA for in_ground.
    const v = verdict({ hy: H({ recent: 0, observed: 0.60, remaining: 0, pop: 0 }), measuredCredit: true });
    expect(v.bucket).toBe('skip');
  });

  it('F4 flag ON: recent actuals are untouched — only the D0 term changes basis', () => {
    const v = verdict({ hy: H({ recent: 0.60, observed: 0, remaining: 0, pop: 0 }), measuredCredit: true });
    expect(v.bucket).toBe('skip');
  });

  it('F5 the prod 2026-08-23 case flips: 0.09" measured is not the 0.22" it was credited', () => {
    expect(verdict({ hy: H(PROD_0823), measuredCredit: false }).bucket).toBe('skip');
    expect(verdict({ hy: H(PROD_0823), measuredCredit: true }).bucket).toBe('water');
  });

  it('F6 no bound station (today_observed_in ABSENT) contributes no credit — fail-safe direction', () => {
    // canon 20260710 4.3: never suppress a baseline watering cue on unverified rain. With no gauge there
    // is no measured value, so today must buy nothing rather than falling back to the forecast total.
    const hy = H({ recent: 0, observed: null, remaining: 0.50, pop: 90 });
    expect(hy.today_observed_in).toBeUndefined();      // fixture integrity: the field really is absent
    expect(verdict({ hy, measuredCredit: true }).bucket).toBe('water');
  });

  it('M1 MUTATION GUARD — these assertions discriminate, they are not incidentally green', () => {
    // If creditPrecip were to ignore measuredOnly (the mutation that reinstates the defect), flag ON and
    // flag OFF would agree on every input. This asserts they DISAGREE on the exact case that matters, so
    // a regression cannot pass by making both branches identical. Guards the guard — a green suite that
    // cannot fail is the failure mode this file exists to avoid.
    const off = verdict({ hy: H(PROD_0823), measuredCredit: false }).bucket;
    const on  = verdict({ hy: H(PROD_0823), measuredCredit: true }).bucket;
    expect(off).not.toBe(on);
    expect([off, on]).toEqual(['skip', 'water']);
  });
});
