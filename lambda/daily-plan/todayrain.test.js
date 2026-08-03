// todayrain.test.js — BUG-TODAYWATER-001: today-forecast suppression.
//
// WHY A NEW FILE. The existing daily-plan suite was mutation-tested during the crucible and found to have
// essentially ZERO discriminating power over this defect class: deleting the today term from windowPrecip
// killed 2 tests, and hard-wiring `rain_coming = false` — the production defect at maximum severity — also
// killed 2, both times the same golden catching an incidental "0.02" inside a string. Every satcap fixture
// deliberately parks its precipitation in `recent_precip_in` to isolate the cap, so grafting today-rain rows
// onto that file would blur the one gate that does have real coverage. This file owns the today axis.
//
// THE ORACLE IS THE INCIDENT. On 2026-08-03 the stored prod plan held recent=0, today=0.98 @ 84% PoP,
// tomorrow=0, and emitted 200 water_due. A live re-run at 08:37 with today=3.8 @ 92% produced 18, all of
// them `covered` (Shelf 4 ×15, Stable ×2, Shelf 2 ×1). Those are real figures, used here as fixtures.
import { describe, it, expect } from 'vitest';
import engine from './engine.js';

const { generatePlanForUser, generatePlan, saturationSuppressed, todayQualifies } = engine;

const TODAY = '2026-08-03';
// resolveCadence spreads cad.default, and the engine reads the _container/_inground variants — a bare
// water_interval_days leaves wi undefined and the planting lands in NO bucket at all, silently.
const CAD = {
  default: { water_interval_days_container: 3, water_interval_days_inground: 3, crop: 'generic' },
  by_variety: {}, by_genus_fallback: {},
};
const FM = { water_quality: { implications: [] } };

const H = (recent, today, todayPop, tomorrow, tomorrowPop) => ({
  recent_precip_in: recent, today_precip_in: today, today_pop: todayPop,
  tomorrow_precip_in: tomorrow, tomorrow_pop: tomorrowPop, upcoming_precip_in: (tomorrow || 0),
});

const plant = (over = {}) => ({
  id: 'p1', name: 'Test Planting', project: 'Proj', project_id: 'pr1', workspace_id: 'w1',
  genus: 'generic', status: 'growing', covered: false, container_type: null, container_size: null,
  last_water: '2026-07-24',            // dW = 10 vs interval 3 — comfortably due
  transplant_at: null, rain_exposed: null, ...over,
});

// An explicitly LARGE vessel. Needed because isSmallVessel() returns TRUE for an unset container_type
// (fail-safe: unknown vessel → deny credit → water it), and container_type is ~unpopulated in this DB. So a
// default planting takes the conservative SOAK_TODAY_SMALL_IN bar; only a named bed takes the general one.
// Deliberate — see the null-vessel case below — but it means every general-bar test must name a vessel or
// it would silently be exercising the small-vessel path instead.
const BED = { container_type: 'in_ground' };

// Returns bucket + row, so assertions can check the REASON too. A bucket-only assertion cannot tell the
// soak branch from the today branch, which is exactly how a today-aware fix looks green while firing
// through the wrong gate.
function verdict({ hy, p = {}, high = 75, todayAware = true }) {
  const wx = { tonightLow: 60, highToday: high, code: 0, short: '', unit: 'F' };
  const plan = generatePlanForUser([plant(p)], CAD, FM, TODAY, wx, hy, false, false, todayAware);
  const t = plan.tasks || {};
  const w = (t.water_due || []).find(r => r.id === 'p1');
  const s = (t.rain_skipped || []).find(r => r.id === 'p1');
  if (w) return { bucket: 'water', row: w };
  if (s) return { bucket: 'skip', row: s };
  return { bucket: 'absent', row: null };
}

describe('BUG-TODAYWATER-001 — the regression, and the red line that guards it', () => {
  it('S1 suppresses an in-ground bed on the real 2026-08-03 hydrology, via the today branch', () => {
    const v = verdict({ hy: H(0, 0.98, 84, 0, null), p: BED });
    expect(v.bucket).toBe('skip');
    expect(v.row.sat_kind).toBe('today');          // not soak, not incoming
    expect(v.row.reason).toMatch(/rain falling today/);
    expect(v.row.reason).toMatch(/0\.98/);
    expect(v.row.reason).toMatch(/84%/);
  });

  it('S1b still waters that same bed with the flag OFF — the ship is inert until flipped', () => {
    expect(verdict({ hy: H(0, 0.98, 84, 0, null), p: BED, todayAware: false }).bucket).toBe('water');
  });

  it('S2 suppresses nothing on a dry hot day', () => {
    expect(verdict({ hy: H(0, 0, 0, 0, null), p: BED, high: 92 }).bucket).toBe('water');
  });

  it('S3 RED LINE: 0.6" at 40% PoP on a hot day must NOT suppress', () => {
    // A forecast that busts, on a hot day, must never silently skip watering.
    expect(verdict({ hy: H(0, 0.6, 40, 0, null), p: BED, high: 92 }).bucket).toBe('water');
  });

  it('S4/S5 puts a real seam at 60% PoP, in both directions', () => {
    expect(verdict({ hy: H(0, 0.6, 60, 0, null), p: BED, high: 92 }).bucket).toBe('skip');
    expect(verdict({ hy: H(0, 0.6, 59, 0, null), p: BED, high: 92 }).bucket).toBe('water');
  });

  it('S6/S7 puts a real seam at 0.5", in both directions', () => {
    expect(verdict({ hy: H(0, 0.5, 84, 0, null), p: BED }).bucket).toBe('skip');
    expect(verdict({ hy: H(0, 0.49, 84, 0, null), p: BED }).bucket).toBe('water');
  });

  it('S8 FAILS CLOSED on a null PoP — unknown probability is a data problem, not a certainty', () => {
    // The tomorrow branch treats pop==null as qualifying. Copying that to today would suppress every
    // outdoor planting on an amount with no probability attached — and fetchPrecip really does emit null.
    expect(verdict({ hy: H(0, 0.98, null, 0, null), p: BED }).bucket).toBe('water');
    expect(todayQualifies({ today_precip_in: 0.98, today_pop: null })).toBe(false);
  });
});

describe('BUG-TODAYWATER-001 — a forecast must not outrank the carve-outs that stop plants dying', () => {
  it('S9 keeps watering a hot fabric bag through a qualifying today forecast', () => {
    // bagHeatGate exists because a 5-gal bag dries top-to-bottom in heat. A busted forecast would leave it
    // unwatered at 92°F; flower abscission follows within 24h and blossom-end-rot is locked into fruit
    // ripening weeks later. 'today' is subordinate; 'soak' — water already fallen — is not.
    // 2.5" so it CLEARS the small-vessel bar and the today branch genuinely fires — at 0.98" this test
    // passed vacuously (fabric_bag resolves to isSmallVessel, so _sat was null and the precedence guard
    // was never exercised). Mutation-verified: removing the guard now fails this.
    const v = verdict({ hy: H(0, 2.5, 92, 0, null), p: { container_type: 'fabric_bag' }, high: 92 });
    expect(v.bucket).toBe('water');
    expect(v.row.rain_note).toMatch(/fabric bag dries fast/);
    // And the guard is the ONLY thing holding it: same inputs, mild day, and it suppresses.
    expect(verdict({ hy: H(0, 2.5, 92, 0, null), p: { container_type: 'fabric_bag' }, high: 70 }).bucket).toBe('skip');
  });

  it('S9b DOES suppress that same bag once the rain has actually fallen', () => {
    // recent=1.2 puts windowPrecip over SOAK_CAP_IN, so soak fires and correctly outranks the heat gate.
    // This is the whole line between predicted water and measured water.
    const v = verdict({ hy: H(1.2, 0, 0, 0, null), p: { container_type: 'fabric_bag' }, high: 92 });
    expect(v.bucket).toBe('skip');
    expect(v.row.sat_kind).toBe('soak');
  });

  it('S11 keeps watering a fresh transplant in a small vessel through a today forecast', () => {
    // 2.5" for the same reason as S9 — below the small-vessel bar the today branch never fires and the
    // assertion proves nothing.
    const v = verdict({
      hy: H(0, 2.5, 92, 0, null),
      p: { container_type: 'tray_cell', transplant_at: '2026-07-29' },
    });
    expect(v.bucket).toBe('water');
    expect(v.row.rain_note).toMatch(/fresh transplant/);
    // Established planting, identical vessel and rain: suppressed. So the carve-out is doing the work.
    expect(verdict({ hy: H(0, 2.5, 92, 0, null), p: { container_type: 'tray_cell' } }).bucket).toBe('skip');
  });

  it('S9c holds small vessels to a much larger forecast before a skip is safe', () => {
    // SOAK_TODAY_SMALL_IN = 2.0. A container intercepts rain only over its own footprint and a mature
    // canopy sheds water away from it, so ~1" is under half of one watering.
    const small = { container_type: 'solo_cup' };
    expect(verdict({ hy: H(0, 0.98, 84, 0, null), p: small }).bucket).toBe('water');
    expect(verdict({ hy: H(0, 2.5, 92, 0, null), p: small }).bucket).toBe('skip');
  });

  it('S9d treats an UNSET container_type as small — the dominant case, deliberately conservative', () => {
    // container_type is ~unpopulated in this database, so this is the common path, not an edge case.
    // Consequence worth stating plainly: on the 02:01 snapshot of 2026-08-03 this fix suppresses in-ground
    // beds and does NOT suppress the unlabelled bags. Suppressing those required the 3.8" that only became
    // OBSERVABLE later that morning — which is the staleness half of the bug, not this half.
    expect(verdict({ hy: H(0, 0.98, 84, 0, null) }).bucket).toBe('water');
    expect(verdict({ hy: H(0, 3.8, 92, 0, null) }).bucket).toBe('skip');   // the 08:37 re-run figure
  });

  it('S13 never suppresses covered plantings, at any amount', () => {
    // The 18 that correctly stayed on the list during the incident were all indoor.
    expect(verdict({ hy: H(0, 3.8, 92, 0, null), p: { covered: true } }).bucket).toBe('water');
    expect(saturationSuppressed('none', H(0, 3.8, 92, 0, null), { todayAware: true })).toBe(null);
  });
});

describe('BUG-TODAYWATER-001 — the pre-existing branches must not move', () => {
  it('S14/S15 leaves SOAK_CAP_IN at 1.0, both directions', () => {
    expect(verdict({ hy: H(1.0, 0, 0, 0, null), p: BED }).row?.sat_kind).toBe('soak');
    expect(verdict({ hy: H(0.99, 0, 0, 0, null), p: BED }).bucket).toBe('water');
  });

  it('S16/S17 leaves the tomorrow "incoming" branch unchanged', () => {
    expect(verdict({ hy: H(0.6, 0, 0, 0.6, 70), p: BED }).row?.sat_kind).toBe('incoming');
    expect(verdict({ hy: H(0.3, 0, 0, 0.6, 70), p: BED }).bucket).toBe('water');
  });

  it('S19 DISJOINT TERMS: soak judges actuals, today judges the forecast, neither double-counts', () => {
    // The double-count this replaces: windowPrecip is recent+today, so before this change a single 0.6"
    // forecast could satisfy both a "0.5 already wet" floor and a "0.5 more coming" bar. Now the two
    // branches read disjoint inputs, which is a structural guarantee rather than an arithmetic one.
    // Actuals alone below the cap, forecast alone above its bar → the TODAY branch owns it.
    const t = verdict({ hy: H(0.6, 0.6, 84, 0, null), p: BED });
    expect(t.bucket).toBe('skip');
    expect(t.sat_kind ?? t.row.sat_kind).toBe('today');

    // Actuals alone at the cap → SOAK owns it, regardless of any forecast.
    const s2 = verdict({ hy: H(1.2, 0, 0, 0, null), p: BED });
    expect(s2.row.sat_kind).toBe('soak');

    // And the forecast alone can never reach the soak branch: 3.8" forecast with zero actuals is 'today',
    // so it stays subordinate to the carve-outs instead of overriding them.
    expect(verdict({ hy: H(0, 3.8, 92, 0, null), p: BED }).row.sat_kind).toBe('today');
  });
});

describe('BUG-TODAYWATER-001 — rain_coming (client-facing, reaches no engine gate)', () => {
  const wx = { tonightLow: 60, highToday: 75, code: 0, short: '', unit: 'F' };
  const run = hy => generatePlan({
    plantings: [plant()], cadence: CAD, fertModel: FM, today: TODAY,
    weather: wx, hydrology: hy, ownerFallback: 'u1',
  }).hydrology;

  it('becomes today-aware and carries a horizon', () => {
    const t = run(H(0, 0.98, 84, 0, null));
    expect(t.rain_coming).toBe(true);
    expect(t.rain_horizon).toBe('today');

    const m = run(H(0, 0, 0, 0.6, 70));
    expect(m.rain_coming).toBe(true);
    expect(m.rain_horizon).toBe('tomorrow');
  });

  it('does not fire on a low or absent PoP, matching the suppression gate', () => {
    expect(run(H(0, 0.98, 40, 0, null)).rain_coming).toBe(false);
    expect(run(H(0, 0.98, null, 0, null)).rain_coming).toBe(false);
    expect(run(H(0, 0.98, 40, 0, null)).rain_horizon).toBe(null);
  });

  it('does not treat fallen rain as "coming" — 1.0" already down is a soak, not a forecast', () => {
    expect(run(H(1.0, 0, 0, 0, null)).rain_coming).toBe(false);
  });
});

describe('BUG-TODAYWATER-001 — invariants', () => {
  it('never places a planting in both water_due and rain_skipped', () => {
    const hys = [H(0, 0.98, 84, 0, null), H(1.2, 0, 0, 0, null), H(0, 0, 0, 0, null), H(0.6, 0.6, 84, 0, null)];
    for (const hy of hys) {
      const wx = { tonightLow: 60, highToday: 80, code: 0, short: '', unit: 'F' };
      const plan = generatePlanForUser([plant(BED)], CAD, FM, TODAY, wx, hy, false, false, true);
      const ids = [...(plan.tasks.water_due || []), ...(plan.tasks.rain_skipped || [])].map(r => r.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('is monotonic in today_precip_in — more rain never produces MORE watering', () => {
    // Guards the seam an implementer would create by mixing a weighted and an unweighted comparison.
    let sawSkip = false;
    for (const amt of [0, 0.25, 0.49, 0.5, 0.98, 2.0, 3.8]) {
      const b = verdict({ hy: H(0, amt, 84, 0, null), p: BED }).bucket;
      if (b === 'skip') sawSkip = true;
      else expect(sawSkip, `watering reappeared at ${amt}" after a skip — non-monotonic`).toBe(false);
    }
    expect(sawSkip).toBe(true);
  });

  it('records the decision inputs on every suppression, so a busted forecast is auditable', () => {
    // Without these, "did we skip on a forecast that never arrived?" is unanswerable after the fact —
    // and that is precisely the failure this change can cause.
    const v = verdict({ hy: H(0, 0.98, 84, 0, null), p: BED });
    expect(v.row.sat_kind).toBe('today');
    expect(v.row.today_in).toBe(0.98);
    expect(v.row.today_pop).toBe(84);
    expect(typeof v.row.sat_wp).toBe('number');
  });
});
