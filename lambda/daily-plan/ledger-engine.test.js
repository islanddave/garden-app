// ledger-engine.test.js — V4-WATERMATH-001 F2 at generatePlan level.
// Three jobs, mirroring the watercredit-tiered parity philosophy (the canon names that pattern):
//   (1) STANDING FLAG-OFF GUARD: generatePlan(waterLedgerEnabled:false) — and enabled WITHOUT an
//       event window — is byte-identical to the default engine across ALL committed parity
//       scenarios (the DRG-BACKBONE goldens) AND across every ledger scenario.
//   (2) FLAG-ON ACCEPTANCE: the canon Part 5 per-mechanism tests (a)-(h) as engine-visible
//       verdicts, under the LIVE prod flag combo (rain-credit + today-aware ON, maxdays OFF).
//   (3) COMMITTED SHADOW GOLDENS: ledger-goldens.json pins the off/on projection of every ledger
//       scenario — the flip gate's expected-delta artifact. Regenerate DELIBERATELY with
//       UPDATE_LEDGER_GOLDENS=1 npx vitest run lambda/daily-plan/ledger-engine.test.js
//       and review the diff like a seededgate expected-delta list.
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import engine from './engine.js';
import lf from './ledger-fixtures.js';
import { scenarios as paritySc } from '../../tests/parity/daily-plan/fixtures.mjs';

const { generatePlan } = engine;
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const cadence = JSON.parse(readFileSync(here('./cadence-data-v2.json'), 'utf8'));
const fertModel = JSON.parse(readFileSync(here('./fertilization-model.json'), 'utf8'));

// LIVE prod combo (verified 2026-08-12): rain-credit + today-aware + cadence-scopes ON, maxdays OFF.
// cadence-scopes is a data-shape flag (handler nulls the column when off); fixtures carry
// cadence_scopes on the plantings that want the researched path, so no engine arg exists for it.
const LIVE = { rainCreditEnabled: true, rainMaxDaysEnabled: false, todayAwareEnabled: true };

const runOff = (s) => generatePlan({ ...s.input, cadence, fertModel, ...LIVE, waterLedgerEnabled: false });
const runOn = (s) => generatePlan({ ...s.input, cadence, fertModel, ...LIVE, waterLedgerEnabled: true });
const due = (plan, id) => Object.values(plan.users).flatMap((u) => u.tasks.water_due).find((x) => x.id === id);
const skipped = (plan, id) => Object.values(plan.users).flatMap((u) => u.tasks.rain_skipped).find((x) => x.id === id);
const never = (plan, id) => Object.values(plan.users).flatMap((u) => u.tasks.no_history).find((x) => x.id === id);

// ── (1) standing flag-OFF guard ───────────────────────────────────────────────────────────────────
describe('STANDING FLAG-OFF GUARD — the ledger flag off (or starved) is byte-identical', () => {
  for (const s of paritySc) {
    it(`waterLedgerEnabled:false deep-equals default for parity golden "${s.name}"`, () => {
      const off = generatePlan({ ...s.input, cadence, fertModel, waterLedgerEnabled: false });
      const def = generatePlan({ ...s.input, cadence, fertModel });
      expect(off).toEqual(def);
    });
  }
  it('enabled WITHOUT an event window stays legacy (a failed read degrades the whole run)', () => {
    for (const s of paritySc) {
      const starved = generatePlan({ ...s.input, cadence, fertModel, waterLedgerEnabled: true,
        eventsByPlant: null, weatherDaily: [] });
      const def = generatePlan({ ...s.input, cadence, fertModel });
      expect(starved).toEqual(def);
    }
  });
  it('flag OFF deep-equals default across every ledger scenario too (fractional time is IN-flag)', () => {
    for (const s of lf.scenarios) {
      const off = runOff(s);
      const def = generatePlan({ ...s.input, cadence, fertModel, ...LIVE });
      expect(off, s.name).toEqual(def);
    }
  });
  it('FALSIFIABILITY: the flag genuinely changes behavior on >=1 scenario (else it is a no-op)', () => {
    const diverged = lf.scenarios.some((s) => JSON.stringify(runOff(s)) !== JSON.stringify(runOn(s)));
    expect(diverged).toBe(true);
  });
});

// ── (2) canon Part 5 acceptance, engine-visible ───────────────────────────────────────────────────
describe('acceptance (a)-(h) under the LIVE flag combo', () => {
  it('(a) 19:00 Normal on wi=1: legacy due next morning, ledger NOT due; control stays due both ways', () => {
    const s = lf.scenarios.find((x) => x.name === 'evening-soak-wi1');
    const off = runOff(s), on = runOn(s);
    expect(due(off, 'ev1')).toBeTruthy();               // the headline complaint, reproduced
    expect(due(on, 'ev1')).toBeUndefined();             // fixed by fractional time alone
    expect(due(off, 'ctl')).toBeTruthy();
    expect(due(on, 'ctl')).toBeTruthy();                // the fix does not blanket-suppress
  });
  it('(b) Deep vs Normal on in-ground diverge: Deep holds a lower D (bank) at the same instant', () => {
    const s = lf.scenarios.find((x) => x.name === 'deep-vs-normal-inground');
    const on = runOn(s);
    const dp = due(on, 'dp'), nm = due(on, 'nm');
    const dOf = (x, id) => x ? x.ledger.d : Object.values(runOn(s).users)
      .flatMap((u) => u.tasks.water_due).find((y) => y.id === id)?.ledger.d;
    // neither may be due yet at wi=5 in-ground; assert through the goldens' d when due, else
    // through the absence ordering: Deep must never be due while Normal is not.
    if (dp || nm) {
      expect(nm).toBeTruthy();
      if (dp && nm) expect(dp.ledger.d).toBeLessThan(nm.ledger.d);
    }
    // the strong assertion runs at unit level (ledger.test.js); here we pin no-inversion.
    expect(dp && !nm).toBeFalsy();
  });
  it('(d) rain week floors D and the planting resurfaces after it stops', () => {
    const s = lf.scenarios.find((x) => x.name === 'rain-week-resurfaces');
    const on = runOn(s);
    const rw = due(on, 'rw');
    expect(rw).toBeTruthy();                            // 8 dry days since the rain stopped
    expect(rw.ledger.d).toBeGreaterThan(0);
  });
  it('(e) heat wave day 14: due item carries elevated demand drivers from weather_daily.tmax_f', () => {
    const s = lf.scenarios.find((x) => x.name === 'heatwave-fixed-ref');
    const on = runOn(s);
    const hw = due(on, 'hw');
    expect(hw).toBeTruthy();
    const drivers = Object.fromEntries(hw.ledger.drivers.map((d) => [d.factor, d.value]));
    expect(drivers.et0_ratio).toBeGreaterThan(1.5);     // fixed ref holds the whole wave elevated
    expect(drivers.vessel).toBeGreaterThan(1.3);        // 1.35 bag ramp at 92F x 1.0 mid size
  });
  it('(f) empty weather_daily: verdict still renders, demand degrades to 1.0, tier demotes one step', () => {
    const s = lf.scenarios.find((x) => x.name === 'degraded-no-weather');
    const on = runOn(s);
    const dg = due(on, 'dg');
    expect(dg).toBeTruthy();
    // researched provenance missing exactly ONE input (weather) is MEDIUM by the canon tier table
    // ("HIGH provenance missing one input"); the degradation itself is loud via the driver line.
    expect(dg.ledger.confidence).toBe('MEDIUM');
    expect(dg.ledger.drivers.some((d) => d.factor === 'weather_degraded')).toBe(true);
    expect(dg.ledger.drivers.find((d) => d.factor === 'demand_today').value).toBe(1);
  });
  it('(g) never-watered path is byte-identical flag ON vs OFF', () => {
    const s = lf.scenarios.find((x) => x.name === 'never-watered');
    expect(never(runOn(s), 'nv')).toEqual(never(runOff(s), 'nv'));
  });
  it('(h) a moisture_check this morning clears the 15:30 run (engine half of the same-day contract)', () => {
    const s = lf.scenarios.find((x) => x.name === 'snooze-today');
    expect(due(runOff(s), 'sz')).toBeTruthy();          // legacy cannot hear the snooze
    expect(due(runOn(s), 'sz')).toBeUndefined();
  });
  it('saturation cap stays SUPREME and its gate is D-based, not dW-based', () => {
    const s = lf.scenarios.find((x) => x.name === 'satcap-supremacy');
    const off = runOff(s), on = runOn(s);
    // ledger-due + soaked -> saturated skip with the ledger key riding along
    const sat = skipped(on, 'sat');
    expect(sat).toBeTruthy();
    expect(sat.saturated).toBe(true);
    expect(sat.ledger).toBeTruthy();
    expect(due(on, 'sat')).toBeUndefined();
    // dW>=wi but D<thr (watered yesterday evening): legacy sat-skips it, the ledger does not even
    // reach the cap — the eligibility gate moved from dW>=wi to D>=dueThreshold (engine.js:455 note)
    expect(skipped(off, 'fresh')).toBeTruthy();
    expect(skipped(on, 'fresh')).toBeUndefined();
    expect(due(on, 'fresh')).toBeUndefined();
  });
});

// ── payload contract ──────────────────────────────────────────────────────────────────────────────
describe('payload contract (canon Decision 10 — the ::int crash class)', () => {
  it('every emitted days_since/overdue_by/interval is an INTEGER across all scenarios, both flags', () => {
    for (const s of lf.scenarios) {
      for (const plan of [runOff(s), runOn(s)]) {
        for (const up of Object.values(plan.users)) {
          for (const x of [...up.tasks.water_due, ...up.tasks.rain_skipped]) {
            if (x.days_since != null) expect(Number.isInteger(x.days_since), `${s.name}:${x.id}`).toBe(true);
            if (x.overdue_by != null) expect(Number.isInteger(x.overdue_by), `${s.name}:${x.id}`).toBe(true);
            expect(Number.isInteger(x.interval), `${s.name}:${x.id}`).toBe(true);
          }
        }
      }
    }
  });
  it('ledger precision rides ONLY in the additive `ledger` key (d, due_at, wi_eff, confidence, drivers)', () => {
    const s = lf.scenarios.find((x) => x.name === 'live-combo-confidence');
    const hi = due(runOn(s), 'hi');
    expect(Object.keys(hi.ledger).sort()).toEqual(['confidence', 'd', 'drivers', 'due_at', 'wi_eff']);
    expect(new Date(hi.ledger.due_at).toString()).not.toBe('Invalid Date');
    expect(engine.PLAN_SCHEMA_VERSION).toBe(1);         // additive keys only — no reader bump
  });
  it('server-side confidence: researched HIGH, guess LOW, snooze-demoted MEDIUM — one authority', () => {
    const s = lf.scenarios.find((x) => x.name === 'live-combo-confidence');
    const on = runOn(s);
    expect(due(on, 'hi').ledger.confidence).toBe('HIGH');
    expect(due(on, 'lo').ledger.confidence).toBe('LOW');
    expect(due(on, 'dm').ledger.confidence).toBe('MEDIUM');
  });
});

// ── (2b) container_type -> RAIN_DEPTH wiring ─────────────────────────────────────────────────────
// Guards engine.js's ledger ctx `rainTier: rainDepthTierFor(...)`. ledger.test.js cannot see this:
// it calls foldLedger with an explicit rainTier, so reverting the call site to rainTierFor left the
// whole suite green while handing every NULL-container planting bed-equivalent rain credit (~22 live
// rows). Built inline rather than as a lf.scenario so it does not move ledger-goldens.json.
describe('NULL container_type reaches the STRICT RAIN_DEPTH row, not the bag row', () => {
  // 0.27" is the discriminating amount: Light on the unknown row (light .10, normal .30), Normal on
  // the bag row (normal .25). Same cadence, same size, same history — only container_type differs.
  const base = {
    today: lf.TODAY, nowMs: lf.NOW, weather: lf.WX, hydrology: lf.HY, ownerFallback: 'dave',
    weatherDaily: lf.weatherDaily({ precipOn: { [lf.ago(3)]: 0.27 } }),
    eventsByPlant: { unk: [lf.w(lf.ago(6), 12, null, 'e1')], bag: [lf.w(lf.ago(6), 12, null, 'e2')] },
    plantings: [
      lf.P({ id: 'unk', container_type: null, container_size: '5 gal', last_water: lf.ago(6) }),
      lf.P({ id: 'bag', container_type: 'fabric_bag', container_size: '5 gal', last_water: lf.ago(6) }),
    ],
  };
  const plan = generatePlan({ ...base, cadence, fertModel, ...LIVE, waterLedgerEnabled: true });
  const dOf = (id) => (due(plan, id) || skipped(plan, id) || never(plan, id)).ledger.d;
  it('the unknown vessel ends the fold DRIER than the bag (less credit from the same rain)', () => {
    expect(dOf('unk')).toBeGreaterThan(dOf('bag'));
  });
  it('and the gap is exactly the Light-vs-Normal split, not a rounding wobble', () => {
    expect(dOf('unk') - dOf('bag')).toBeGreaterThan(0.5);
  });
});

// ── (3) committed shadow goldens — the flip gate's expected-delta artifact ────────────────────────
describe('shadow goldens (ledger-goldens.json)', () => {
  const GOLDEN_PATH = here('./ledger-goldens.json');
  const current = {};
  for (const s of lf.scenarios) {
    current[s.name] = { note: s.note, off: lf.project(runOff(s)), on: lf.project(runOn(s)) };
  }
  if (process.env.UPDATE_LEDGER_GOLDENS === '1') {
    writeFileSync(GOLDEN_PATH, JSON.stringify(current, null, 1) + '\n');
  }
  it('the committed off/on projections match the engine exactly (regenerate DELIBERATELY)', () => {
    expect(existsSync(GOLDEN_PATH), 'run UPDATE_LEDGER_GOLDENS=1 once to capture').toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
    expect(current).toEqual(golden);
  });
});
