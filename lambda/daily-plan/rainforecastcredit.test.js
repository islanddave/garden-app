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

// ── The two LIVE residuals, closed 2026-08-24 ───────────────────────────────────────────────────
// The named defect above shipped and went live (CARE_RAIN_MEASURED_CREDIT_ENABLED, 2026-08-24
// 13:13Z). Two places still read the MIXED basis after it, and both were live on the flag-on path.
describe('BUG-RAINFORECASTCREDIT-001 residual 1 — the note quotes the number the decision used', () => {
  // 0.09" measured, 0.29" still expected. The decision is `rc == null` because 0.09" is under
  // RAIN_TIER_IA.in_ground (0.20). The note used to be rendered from windowPrecip (0.38"), producing
  // a sentence that contradicts its own arithmetic: `0.38" rain under the 0.2" soak-in threshold`.
  const SPLIT = { recent: 0, observed: 0.09, remaining: 0.29, pop: 0 };

  it('flag ON: the sentence is arithmetically true, and it is the measured figure', () => {
    const v = verdict({ hy: H(SPLIT), measuredCredit: true });
    expect(v.bucket).toBe('water');
    expect(v.row.rain_note).toBe('Water — 0.09" rain under the 0.2" soak-in threshold');
    // Parsed rather than pattern-matched, so this fails on ANY future basis that reintroduces a
    // number above the bar — not merely on the one string we happen to know about today.
    const [, amt, bar] = v.row.rain_note.match(/([\d.]+)" rain under the ([\d.]+)"/);
    expect(Number(amt)).toBeLessThan(Number(bar));
  });

  it('the note and the verdict cite the SAME basis — no third number in the sentence', () => {
    // The credit path's own view of this hydrology, read through the exported credit fn: it earns
    // nothing, and the amount it declined on is 0.09. The note must say 0.09 and not 0.38.
    expect(engine.rainCreditDays('outdoor', 3, H(SPLIT), true)).toBe(null);
    expect(verdict({ hy: H(SPLIT), measuredCredit: true }).row.rain_note).toContain('0.09"');
    expect(verdict({ hy: H(SPLIT), measuredCredit: true }).row.rain_note).not.toContain('0.38"');
  });

  it('this residual only became REACHABLE when the flag flipped', () => {
    // Flag OFF, the same day never reaches the note at all: 0.38" mixed clears the 0.20" tier IA, so
    // the row is rain-skipped and there is no sentence to be wrong. That is why the contradiction is
    // dated to the flip and not to the original commit, and why prod's 12 historical occurrences of
    // this note string are all arithmetically consistent.
    expect(verdict({ hy: H(SPLIT), measuredCredit: false }).bucket).toBe('skip');
  });

  it('flag OFF is byte-identical where the branch IS shared — creditPrecip(hy,false) IS windowPrecip', () => {
    // 0.05" measured + 0.10" still expected: BOTH bases are under the 0.20" tier IA, so both flag
    // states land in the note branch and the only difference is which number is quoted.
    const BOTH_UNDER = { recent: 0, observed: 0.05, remaining: 0.10, pop: 0 };
    expect(verdict({ hy: H(BOTH_UNDER), measuredCredit: false }).row.rain_note)
      .toBe('Water — 0.15" rain under the 0.2" soak-in threshold');
    expect(verdict({ hy: H(BOTH_UNDER), measuredCredit: true }).row.rain_note)
      .toBe('Water — 0.05" rain under the 0.2" soak-in threshold');
  });
});

describe('BUG-RAINFORECASTCREDIT-001 residual 2 — "already wet" means MEASURED wet', () => {
  // saturationSuppressed's incoming branch: "media is already wet AND more rain is coming, so there
  // is no drying window". The prerequisite read windowPrecip, whose D0 half is today's unelapsed
  // hourly FORECAST — so a forecast could satisfy the wetness floor and then be skipped on a second
  // forecast (tomorrow's), which is both a double-count and a claim about the soil that no gauge
  // supported. It now reads soakBasis, the same measured term the soak cap above it judges.
  const sup = (hy, todayAware) => engine.saturationSuppressed('outdoor', hy, { todayAware, smallVessel: false });
  // 0.55" of pure forecast for today, 0.6" more tomorrow at 80%. Nothing measured at all.
  const FORECAST_ONLY = { recent_precip_in: 0, today_observed_in: 0, today_remaining_in: 0.55,
    today_precip_in: 0.55, today_pop: 10, tomorrow_precip_in: 0.6, tomorrow_pop: 80 };
  // The same "more coming" setup, but 0.55" has actually FALLEN — and 0.20" more is still expected
  // today. That remainder is not decoration: with today_remaining_in at 0 the mixed sum and the
  // measured basis are the SAME NUMBER, and an assertion on the reported wp cannot tell which one
  // produced it. Mutation-verified — the 0-remainder version of this fixture let a revert to `wpR`
  // survive. It stays below SOAK_FCST_QPF_IN and at PoP 10, so it reaches no other gate.
  const MEASURED_WET = { ...FORECAST_ONLY, today_observed_in: 0.55, today_remaining_in: 0.20, today_precip_in: 0.75 };

  it('an unmeasured forecast no longer satisfies the already-wet prerequisite', () => {
    // today_pop 10 keeps the today branch out of it, so incoming is the only branch in play and a
    // null here is a real "water it", not a hand-off to another suppression.
    expect(sup(FORECAST_ONLY, true)).toBe(null);
  });

  it('measured water still satisfies it — the branch is narrowed, not disabled', () => {
    const s = sup(MEASURED_WET, true);
    expect(s.kind).toBe('incoming');
    // ...and sat_wp reports the basis the bar was applied to, as the soak branch does. A forensic
    // field carrying a number no bar was applied to cannot answer "did we skip on a bust?".
    expect(s.wp).toBe(0.55);
    expect(engine.windowPrecip(MEASURED_WET)).toBe(0.75);   // the number it must NOT report
  });

  it('todayAware OFF is byte-identical — soakBasis collapses to windowPrecip', () => {
    expect(sup(FORECAST_ONLY, false)).toEqual({ wp: 0.55, fq: 0.6, pop: 80, kind: 'incoming' });
  });
});
