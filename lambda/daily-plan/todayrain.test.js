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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import engine from './engine.js';
import station from './station.js';
import _cf from './_coverFlags.js';
const { withCoverFlags } = _cf;  // BUG-NOLOCOUTDOOR-001 fixture bridge

const { generatePlanForUser, generatePlan, saturationSuppressed, todayQualifies, SOAK_CAP_IN, SOAK_TODAY_SMALL_IN } = engine;
const { deriveStation, mergeStationHydrology } = station;

// station.js ships an EMPTY DEFAULT_STATIONS (public repo — see its header), so deriveStation() needs a
// config supplied here. The MAC below must match the one the gauge fixtures use further down.
let prevStations;
beforeEach(() => {
  prevStations = process.env.AWN_STATIONS_JSON;
  process.env.AWN_STATIONS_JSON = JSON.stringify([
    { mac: 'AA:BB:CC:DD:EE:FF', tz: 'America/New_York', lat: 41.8888, lng: -70.7777, schema_version: 1 },
  ]);
});
afterEach(() => {
  if (prevStations === undefined) delete process.env.AWN_STATIONS_JSON;
  else process.env.AWN_STATIONS_JSON = prevStations;
});

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

const plant = (over = {}) => withCoverFlags({
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

  it('S9c holds small vessels to a larger forecast than beds before a skip is safe', () => {
    // BUG-SOAKBAR-001 retuned SOAK_TODAY_SMALL_IN 2.0 -> 0.91 (derivation in engine.js; bar value and its
    // blast radius are owned by soakcontainer.test.js). What this test asserts is unchanged and is the
    // ORDERING, not the number: a container is never skipped on a forecast that would only just skip a bed.
    // Amounts moved to straddle the current bar — 0.85" below, 2.5" above — so the test still discriminates.
    const small = { container_type: 'solo_cup' };
    expect(verdict({ hy: H(0, 0.85, 84, 0, null), p: small }).bucket).toBe('water');
    expect(verdict({ hy: H(0, 0.85, 84, 0, null), p: BED }).bucket).toBe('skip');   // same rain, bed: skipped
    expect(verdict({ hy: H(0, 2.5, 92, 0, null), p: small }).bucket).toBe('skip');
  });

  it('S9d treats an UNSET container_type as small — the dominant case, deliberately conservative', () => {
    // container_type is ~unpopulated in this database, so this is the common path, not an edge case.
    // Consequence worth stating plainly: on the 02:01 snapshot of 2026-08-03 this fix suppresses in-ground
    // beds and does NOT suppress the unlabelled bags. Suppressing those required the 3.8" that only became
    // OBSERVABLE later that morning — which is the staleness half of the bug, not this half.
    // BUG-SOAKBAR-001: 0.98" -> 0.85" so the "unlabelled row still waters" half stays below the retuned
    // 0.91" bar. The point of the test is the CLASSIFICATION of an unset container_type, not the amount.
    expect(verdict({ hy: H(0, 0.85, 84, 0, null) }).bucket).toBe('water');
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

// ── BUG-TODAYWATER-001 2nd pass — the composition seam with BUG-RAINACTUAL-001 ────────────────────────
// WHY THIS BLOCK EXISTS, AND WHY IT LOOKS DIFFERENT FROM EVERYTHING ABOVE. Every fixture above (and every
// one in watercredit-satcap.test.js) builds hydrology BY HAND through H(...), so today_precip_in is always a
// pure pre-dawn forecast — the exact shape the today branch was designed against. Production stopped looking
// like that when BUG-RAINACTUAL-001 made station.mergeStationHydrology set
//   today_precip_in = today_observed_in + today_remaining_in
// i.e. WS-2902 gauge-MEASURED rain plus the hourly forecast for the hours not yet elapsed. At the 15:30 run
// that is essentially the on-site gauge total. today_observed_in / today_remaining_in appeared ONLY in
// station.test.js: each half was covered, the JUNCTION was not, and the defect lived precisely there — the
// flag-ON soak basis excluded measured rain and then a PoP gate vetoed it. So these fixtures are built the
// way the Lambda builds them (handler.js: mergeStationHydrology -> generatePlan) and never by hand.
describe('BUG-TODAYWATER-001 2nd pass — measured rain is water, not a probability', () => {
  const MAC = 'AA:BB:CC:DD:EE:FF';
  const rec = (day, hh, dailyrainin, tempf = 70) => ({ dateutc: Date.parse(`${day}T${hh}:00:00-04:00`), dailyrainin, tempf });
  const NOW_PM = Date.parse('2026-08-03T19:30:00Z');   // 15:30 ET on the plan day = the intraday run that STORES the plan

  // A fresh, fully-covering gauge whose D-1 and D-2 buckets are dry, so recent_precip_in is 0 and the ONLY
  // water in the picture is what fell TODAY. That isolates the term under test.
  const gauge = observed => deriveStation({ mac: MAC, records: [
    rec('2026-08-03', '15', observed),
    rec('2026-08-02', '23', 0),
    rec('2026-08-01', '23', 0),
    rec('2026-07-31', '18', 0),   // coverage anchor (day < D-2)
  ] }, { nowMs: NOW_PM });

  // observed = what the gauge has measured today; dayFcst = Open-Meteo's whole-day number. With no hourly
  // array the merge takes its documented wholeday fallback, so remaining = max(0, dayFcst - observed).
  const gaugeHy = (observed, dayFcst, pop) => mergeStationHydrology(
    { recent_precip_in: 0, today_precip_in: dayFcst, today_pop: pop, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: null },
    gauge(observed), { planDay: TODAY },
  ).merged;

  it('C1 the live defect: 1.5" MEASURED at 45% PoP is a soak, not a coin-flip', () => {
    // This is the shipped 2026-08-04 prod configuration (CARE_TODAY_AWARE_ENABLED=true) meeting the
    // gauge-driven today field. Pre-fix the soak basis read recent_precip_in alone = 0, so 1.5" of rain
    // physically in the ground scored zero, and the today branch then refused it for want of a 60% PoP:
    // 157 of Dave's plantings and 15 of Jen's went to water_due against 19/4 with the flag off.
    const m = gaugeHy(1.5, 1.5, 45);
    expect(m.today_observed_in).toBe(1.5);
    expect(m.today_remaining_in).toBe(0);
    expect(m.recent_precip_in).toBe(0);
    const s = saturationSuppressed('outdoor', m, { todayAware: true });
    expect(s).not.toBe(null);
    expect(s.kind).toBe('soak');           // NOT 'today' — this water is not a forecast
    expect(s.wp).toBe(1.5);
    // MUTATION: restore `const soakBasis = todayAware ? (hy.recent_precip_in || 0) : wp;` -> s is null here.
  });

  it('C2 the same, with a NULL PoP — the fail-closed path that has no probability to fail on', () => {
    // fetchPrecip really does emit today_pop:null (2026-07-03 and 06-17 in the stored plans). Fail-closed is
    // right for a forecast and absurd for a gauge: a missing probability cannot un-fall 1.5" of rain.
    const m = gaugeHy(1.5, 1.5, null);
    const s = saturationSuppressed('outdoor', m, { todayAware: true });
    expect(s.kind).toBe('soak');
    expect(todayQualifies(m)).toBe(false);   // the PoP gate still (correctly) refuses the forecast half
    // MUTATION: restore the recent-only soakBasis -> s is null.
  });

  it('C3 end-to-end through generatePlanForUser, including a hot fabric bag', () => {
    // saturationSuppressed is only half the path; the bucket is what Dave sees. And 'soak' must outrank
    // bagHeatGate exactly as it does for recent rain (S9b) — 1.5" measured today is the same class of water.
    const m = gaugeHy(1.5, 1.5, 45);
    const bed = verdict({ hy: m, p: BED, high: 92 });
    expect(bed.bucket).toBe('skip');
    expect(bed.row.sat_kind).toBe('soak');
    const bag = verdict({ hy: m, p: { container_type: 'fabric_bag' }, high: 92 });
    expect(bag.bucket).toBe('skip');
    expect(bag.row.sat_kind).toBe('soak');
    // MUTATION: restore the recent-only soakBasis -> both become 'water'.
  });

  it('C4 hourly basis reaches the same verdict — the fix is not an artifact of the wholeday fallback', () => {
    // The live 15:30 run resolves `remaining` from the HOURLY array (prov.today_remaining_basis='hourly'),
    // not the subtraction. Same conclusion, different construction, so the assertion is not pinned to a
    // fallback path that only fires when hourly data is missing.
    const hourly = { time: [], precipitation: [] };
    for (let h = 0; h < 24; h++) { hourly.time.push(`${TODAY}T${String(h).padStart(2, '0')}:00`); hourly.precipitation.push(0); }
    const { merged, prov } = mergeStationHydrology(
      { recent_precip_in: 0, today_precip_in: 1.5, today_pop: 45, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: null, hourly_precip: hourly },
      gauge(1.5), { planDay: TODAY },
    );
    expect(prov.today_remaining_basis).toBe('hourly');
    expect(merged.today_observed_in).toBe(1.5);
    expect(merged.today_remaining_in).toBe(0);
    expect(saturationSuppressed('outdoor', merged, { todayAware: true }).kind).toBe('soak');
  });

  it('C5 INVARIANT: once the gauge alone clears SOAK_CAP_IN, both flag states must agree', () => {
    // The general statement of the defect, independent of PoP, vessel, heat and forecast: water measured at
    // or above the cap suppresses, full stop. Flag OFF already got this right (its basis is recent+today, and
    // today >= observed by construction), so flag-ON/flag-OFF disagreement here IS the bug. Swept rather than
    // spot-checked, because the pre-fix failure was invisible at every PoP >= 60 and every vessel.
    for (const observed of [SOAK_CAP_IN, 1.2, 1.5, 3.8]) {
      for (const dayFcst of [observed, observed + 0.5]) {
        for (const pop of [null, 0, 45, 59, 60, 92]) {
          const m = gaugeHy(observed, dayFcst, pop);
          expect(m.today_observed_in).toBeGreaterThanOrEqual(SOAK_CAP_IN);
          for (const p of [BED, {}, { container_type: 'fabric_bag' }, { container_type: 'solo_cup' }, { container_type: 'tray_cell', transplant_at: '2026-07-29' }]) {
            for (const high of [70, 92]) {
              const on = verdict({ hy: m, p, high, todayAware: true });
              const off = verdict({ hy: m, p, high, todayAware: false });
              expect(on.bucket, `obs=${observed} fcst=${dayFcst} pop=${pop} high=${high} ${JSON.stringify(p)}`).toBe(off.bucket);
              expect(on.bucket).toBe('skip');
            }
          }
        }
      }
    }
    // MUTATION: restore the recent-only soakBasis -> every flag-ON case waters while flag-OFF skips.
  });
});

describe('BUG-TODAYWATER-001 2nd pass — the PoP gates the remainder, and only the remainder', () => {
  const MAC = 'AA:BB:CC:DD:EE:FF';
  const rec = (day, hh, dailyrainin) => ({ dateutc: Date.parse(`${day}T${hh}:00:00-04:00`), dailyrainin, tempf: 70 });
  const gauge = observed => deriveStation({ mac: MAC, records: [
    rec('2026-08-03', '15', observed), rec('2026-08-02', '23', 0), rec('2026-08-01', '23', 0), rec('2026-07-31', '18', 0),
  ] }, { nowMs: Date.parse('2026-08-03T19:30:00Z') });
  const gaugeHy = (observed, dayFcst, pop) => mergeStationHydrology(
    { recent_precip_in: 0, today_precip_in: dayFcst, today_pop: pop, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: null },
    gauge(observed), { planDay: TODAY },
  ).merged;

  it('C6 does not re-count fallen rain as "still coming": 0.4" down + 0.1" left is not a 0.5" forecast', () => {
    // Reading the day TOTAL here let the same water satisfy the soak basis and the incoming-forecast bar —
    // the double-count the disjoint-terms design (S19) exists to prevent, reintroduced through the back door
    // by the gauge. 0.5" total is under SOAK_CAP_IN and only 0.1" is still expected, so: water it.
    const m = gaugeHy(0.4, 0.5, 84);
    expect(m.today_observed_in).toBe(0.4);
    expect(m.today_remaining_in).toBe(0.1);
    expect(m.today_precip_in).toBe(0.5);
    expect(todayQualifies(m)).toBe(false);
    expect(verdict({ hy: m, p: BED }).bucket).toBe('water');
    // MUTATION: restore `const q = hy.today_precip_in` in todayQualifies -> qualifies, bucket becomes 'skip'.
  });

  it('C7 holds the small-vessel bar against the REMAINDER, not the day total', () => {
    // 0.9" has fallen, 0.6" is still expected, 1.5" for the day. SOAK_TODAY_SMALL_IN is a bar on how much
    // more is COMING — a solo cup that has already caught 0.9" and expects 0.6" more has not met the bar,
    // and the measured 0.9" is under the 1.0" cap, so it still needs water.
    // BUG-SOAKBAR-001 re-picked these amounts. The test's whole point is that the day TOTAL clears the bar
    // while the REMAINDER does not, so the numbers must straddle whatever the bar currently is: the old
    // 0.9/2.1 split leaves a 1.2" remainder, which clears the retuned 0.91" bar and would have made this
    // test assert the opposite of its own name. The remainder also has to stay >= SOAK_FCST_QPF_IN or
    // todayQualifies rejects it first and the bar is never consulted — that would pass vacuously.
    const m = gaugeHy(0.9, 1.5, 92);
    expect(m.today_remaining_in).toBeCloseTo(0.6, 5);
    expect(m.today_precip_in).toBeGreaterThan(SOAK_TODAY_SMALL_IN);          // day total clears the bar
    expect(m.today_remaining_in).toBeLessThan(SOAK_TODAY_SMALL_IN);          // remainder does not
    expect(todayQualifies(m)).toBe(true);                                    // ...and it is not the gate rejecting it
    expect(saturationSuppressed('outdoor', m, { todayAware: true, smallVessel: true })).toBe(null);
    expect(verdict({ hy: m, p: { container_type: 'solo_cup' } }).bucket).toBe('water');
    // MUTATION: restore `if(hy.today_precip_in >= bar)` -> 1.5 >= 0.91, bucket becomes 'skip'.
  });

  it('C8 reports the amount it actually judged, so a busted forecast stays auditable', () => {
    // 0.3" measured, 0.7" still expected. A row claiming `1" rain falling today` would be doubly wrong: the
    // 1" is not all forecast, and the 0.7" that could bust is invisible. This is the row that answers
    // "did we skip on a forecast that never arrived?".
    const m = gaugeHy(0.3, 1.0, 84);
    const s = saturationSuppressed('outdoor', m, { todayAware: true });
    expect(s.kind).toBe('today');
    expect(s.fq).toBe(0.7);
    const v = verdict({ hy: m, p: BED });
    expect(v.row.reason).toMatch(/0\.7" rain falling today/);
    expect(v.row.reason).not.toMatch(/\b1" rain falling/);
    // MUTATION: restore `fq: hy.today_precip_in` -> fq is 1 and the reason reads `1" rain falling today`.
  });

  it('C9 a real remaining of 0 is zero, not a fallback to the day total', () => {
    // `??` vs `||` in todayForecastIn. 0.9" fell, nothing more is coming, and 0.9" is under SOAK_CAP_IN —
    // so this waters, exactly as the flag-OFF path does. With `||`, the 0 falls through to today_precip_in
    // and 0.9" of ALREADY-FALLEN rain gets re-judged as an incoming forecast.
    const m = gaugeHy(0.9, 0.9, 84);
    expect(m.today_remaining_in).toBe(0);
    expect(todayQualifies(m)).toBe(false);
    expect(verdict({ hy: m, p: BED }).bucket).toBe('water');
    expect(verdict({ hy: m, p: BED, todayAware: false }).bucket).toBe('water');   // flag parity
    // MUTATION: `hy.today_remaining_in ?? hy.today_precip_in` -> `||` makes this 'skip'.
  });

  it('C11 rain_coming follows the remainder too — 1.5" that already fell is not "coming"', () => {
    // todayQualifies also drives the client-facing rain_coming/rain_horizon (generatePlan). Sharing the fix
    // is intentional and is a visible change on the gauge path: the Today widget stops announcing incoming
    // rain for a storm that has already passed. It reaches no engine gate, so it cannot move water_due.
    const wx = { tonightLow: 60, highToday: 75, code: 0, short: '', unit: 'F' };
    const run = hy => generatePlan({ plantings: [plant(BED)], cadence: CAD, fertModel: FM, today: TODAY,
      weather: wx, hydrology: hy, ownerFallback: 'u1' }).hydrology;
    const fallen = run(gaugeHy(1.5, 1.5, 84));         // all of it measured, nothing left
    expect(fallen.rain_coming).toBe(false);
    expect(fallen.rain_horizon).toBe(null);
    expect(fallen.today_observed_in).toBe(1.5);        // and the split still rides along for the audit
    expect(fallen.today_remaining_in).toBe(0);
    const stillComing = run(gaugeHy(0.3, 1.0, 84));    // 0.7" genuinely still expected
    expect(stillComing.rain_coming).toBe(true);
    expect(stillComing.rain_horizon).toBe('today');
  });

  it('C10 no bound station: the observed/remaining keys are absent and nothing changes', () => {
    // The dominant path if the gauge goes offline, and the back-compat contract for this fix: with no
    // station the observed term contributes 0 and the forecast term falls back to today_precip_in, so every
    // hand-built fixture in this file describes behaviour that is still live.
    const base = H(0, 0.98, 84, 0, null);
    const { merged } = mergeStationHydrology(base, null, { planDay: TODAY });
    expect(merged).toEqual(base);
    expect(merged.today_observed_in).toBeUndefined();
    expect(merged.today_remaining_in).toBeUndefined();
    for (const hy of [H(0, 0.98, 84, 0, null), H(0, 0.98, null, 0, null), H(1.2, 0, 0, 0, null),
      H(0.6, 0.6, 84, 0, null), H(0, 0.6, 40, 0, null), H(0, 3.8, 92, 0, null), H(0.6, 0, 0, 0.6, 70)]) {
      for (const p of [BED, {}, { container_type: 'fabric_bag' }]) {
        for (const flag of [true, false]) {
          const raw = verdict({ hy, p, high: 92, todayAware: flag });
          const thru = verdict({ hy: mergeStationHydrology(hy, null, { planDay: TODAY }).merged, p, high: 92, todayAware: flag });
          expect(thru.bucket).toBe(raw.bucket);
          expect(thru.row?.sat_kind ?? null).toBe(raw.row?.sat_kind ?? null);
          expect(thru.row?.reason ?? null).toBe(raw.row?.reason ?? null);
        }
      }
    }
  });
});
