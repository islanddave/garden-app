// soakcontainer.test.js — BUG-SOAKBAR-001: SOAK_TODAY_SMALL_IN, the today-forecast bar for small vessels.
//
// WHY A NEW FILE. todayrain.test.js owns the today AXIS (does the branch exist, does it read the remainder,
// does it fail closed on a null PoP). This file owns the small-vessel BAR VALUE — whether the number is
// defensible, and whether it still does what the derivation claims after any future retune. Those are
// different failure modes: the axis can be perfect while the constant is nonsense, which is exactly the
// state this file was written to end (a 2.0" bar that asserted a container needs 2" of rain to bank a day).
//
// EVIDENCE. Every hydrology payload in the "prod replay" block below was read from live prod
// (daily_plan.items.hydrology / .prior_runs, via psql-ro) on 2026-08-12, covering plan_dates 2026-06-17..
// 2026-08-12 — 56 nightly runs. They are real measurements, not invented fixtures. The season contained
// exactly FOUR days whose nightly run cleared todayQualifies; all four are pinned here, because a threshold
// justified against synthetic grids and never run against the real distribution is how a bar ends up
// vacuous for a whole season without anyone noticing.
import { describe, it, expect } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import engine from './engine.js';
import _cf from './_coverFlags.js';
import THRESHOLDS from './wateringThresholds.json';
const { withCoverFlags } = _cf;

const {
  generatePlanForUser, saturationSuppressed, todayQualifies,
  SOAK_TODAY_SMALL_IN, SOAK_CAP_IN, isSmallVessel,
} = engine;
// Read from the shared JSON, not from an engine export: this doubles as proof that the value the engine
// acts on is the value in the single-source file, so a private literal reintroduced in engine.js fails here.
const { SOAK_FCST_QPF_IN } = THRESHOLDS;

// The two agronomic inputs the derivation rests on. Kept as named constants so a reader can see that the
// assertions below are arithmetic over Dave's number and the engine's own number, not free-floating magic.
const CONTAINER_NEED_IN_PER_DAY = 0.075;  // Dave-observed, 2026-08-12: "containers are VERY happy with .075 a day"
const IA_SMALL_FAST_IN = 0.35;            // engine RAIN_TIER_IA.small_fast — live in prod (CARE_RAIN_CREDIT_ENABLED=true)
const WORST_OBSERVED_DELIVERY = 0.47;     // 2026-06-22: 1.42" forecast @ 91% PoP -> 0.67" actually delivered

const sup = (hy, smallVessel) => saturationSuppressed('outdoor', hy, { todayAware: true, smallVessel });

describe('BUG-SOAKBAR-001 — the bar is derived, and the derivation is executable', () => {
  // The headline behaviour change. At the old 2.0" bar a container facing a 0.9" forecast at 92% PoP was
  // told to water; the derivation says 0.9" is precisely the point where even the season's worst forecast
  // bust still banks a full day. THIS IS THE TEST THAT FAILS AT 2.0.
  it('suppresses a small vessel at the derived bar, and still waters just below it', () => {
    const at = { recent_precip_in: 0, today_precip_in: 0.91, today_pop: 92, tomorrow_precip_in: 0, tomorrow_pop: null };
    expect(sup(at, true)?.kind).toBe('today');
    const below = { ...at, today_precip_in: 0.90 };
    expect(sup(below, true)).toBe(null);
  });

  // MUTATION-DRIVEN. Everything else in this file compares VALUES, so re-privatising the constant in
  // engine.js (`const SOAK_TODAY_SMALL_IN = 0.91;`) with today's number survived every other assertion —
  // and would then silently ignore the shared file the moment someone retunes it there. This proves the
  // engine READS wateringThresholds.json by feeding it a different file and watching the behaviour move.
  // Not a source-text regex: a re-privatised engine is textually self-consistent and would pass one.
  // vi.doMock does NOT work here: engine.js reaches the JSON through a CJS require(), which vitest's mock
  // registry does not intercept, and the test passed vacuously against the real file. Copying the directory
  // and editing the JSON in the copy is hermetic and exercises the genuine require path.
  it('reads the bar from the shared file — a private literal cannot survive here', () => {
    const dir = mkdtempSync(join(tmpdir(), 'soakbar-'));
    try {
      cpSync(dirname(fileURLToPath(import.meta.url)), dir, { recursive: true });
      const jsonPath = join(dir, 'wateringThresholds.json');
      const patchedJson = { ...JSON.parse(readFileSync(jsonPath, 'utf8')), SOAK_TODAY_SMALL_IN: 1.75 };
      writeFileSync(jsonPath, JSON.stringify(patchedJson, null, 2) + '\n');
      const patched = createRequire(import.meta.url)(join(dir, 'engine.js'));
      expect(patched.SOAK_TODAY_SMALL_IN).toBe(1.75);
      // ...and the BEHAVIOUR must move with it, not merely the export.
      const hy = { recent_precip_in: 0, today_precip_in: 1.0, today_pop: 92, tomorrow_precip_in: 0, tomorrow_pop: null };
      expect(patched.saturationSuppressed('outdoor', hy, { todayAware: true, smallVessel: true })).toBe(null);
      expect(sup(hy, true)?.kind).toBe('today');   // the real engine, same input, still suppresses at 0.91
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Arithmetic, not a restatement of the literal: if someone retunes the bar without redoing the physics,
  // this fails. A bar that cannot cover one day of need under the worst measured bust is not defensible.
  it('a worst-case forecast bust at the bar still banks a full day of container need', () => {
    const delivered = SOAK_TODAY_SMALL_IN * WORST_OBSERVED_DELIVERY;
    const banked = delivered - IA_SMALL_FAST_IN;
    expect(banked).toBeGreaterThanOrEqual(CONTAINER_NEED_IN_PER_DAY);
    // ...and the bar is not wastefully above that point: it buys under two days of need, so it is the
    // minimum defensible value rather than another round number picked for comfort.
    expect(banked).toBeLessThan(2 * CONTAINER_NEED_IN_PER_DAY);
  });

  // The structural floor. todayQualifies gates on SOAK_FCST_QPF_IN first, so a bar at or below it can never
  // be reached and containers silently collapse onto the bed bar. A future "let's lower it further" edit
  // that crosses 0.5 would be a no-op dressed as a change; this makes that impossible to land quietly.
  it('stays strictly above the qualifying gate, or it is dead code', () => {
    // Also pins that the engine acts on the SHARED file's value — a private literal reintroduced in
    // engine.js (the exact defect wateringThresholds.json exists to prevent) fails right here.
    expect(SOAK_TODAY_SMALL_IN).toBe(THRESHOLDS.SOAK_TODAY_SMALL_IN);
    expect(SOAK_TODAY_SMALL_IN).toBeGreaterThan(SOAK_FCST_QPF_IN);
    // Proven behaviourally, not just numerically: there must exist a forecast that qualifies, suppresses a
    // bed, and does NOT suppress a container. If the bar ever collapses, this band is empty.
    const band = { recent_precip_in: 0, today_precip_in: SOAK_FCST_QPF_IN, today_pop: 80, tomorrow_precip_in: 0, tomorrow_pop: null };
    expect(todayQualifies(band)).toBe(true);
    expect(sup(band, false)?.kind).toBe('today');   // bed: suppressed
    expect(sup(band, true)).toBe(null);             // container: still watered
  });

  // Direction of the asymmetry. Whatever the value, a container must never be suppressed on LESS rain than
  // a bed — that inversion would contradict every physical argument in the engine header, and is the shape
  // a careless retune takes. Asserted as a property across the range, not by example.
  it('never suppresses a container on less rain than a bed', () => {
    for (let amt = 0; amt <= 4.0001; amt += 0.05) {
      const hy = { recent_precip_in: 0, today_precip_in: Math.round(amt * 100) / 100, today_pop: 90, tomorrow_precip_in: 0, tomorrow_pop: null };
      if (sup(hy, true)) expect(sup(hy, false), `container suppressed but bed watered at ${amt}"`).toBeTruthy();
    }
  });

  it('is monotonic for small vessels — more forecast rain never produces MORE watering', () => {
    let sawSkip = false;
    for (const amt of [0, 0.25, 0.49, 0.5, 0.74, 0.89, 0.9, 1.42, 2.2, 3.8]) {
      const hy = { recent_precip_in: 0, today_precip_in: amt, today_pop: 92, tomorrow_precip_in: 0, tomorrow_pop: null };
      if (sup(hy, true)) sawSkip = true;
      else expect(sawSkip, `container watering reappeared at ${amt}" after a skip`).toBe(false);
    }
    expect(sawSkip).toBe(true);
  });
});

describe('BUG-SOAKBAR-001 — replay against the real 2026 season (live prod payloads)', () => {
  // The four nightly runs from 2026-06-17..2026-08-12 that cleared todayQualifies. Verbatim from prod.
  // `expectSmall` is what the CURRENT bar must do; the note records what actually fell, reconstructed from
  // the stored recent_precip_in chain (recent(D) = actual(D-2) + actual(D-1); the reconstruction reproduced
  // all 56 stored recent values with zero inconsistencies).
  const SEASON = [
    { d: '2026-06-22', hy: { recent_precip_in: 0, today_precip_in: 1.42, today_pop: 91, tomorrow_precip_in: 1.25, tomorrow_pop: 74, upcoming_precip_in: 1.25 },
      expectSmall: 'incoming', actual: 0.67 },
    { d: '2026-07-07', hy: { recent_precip_in: 0, today_precip_in: 0.74, today_pop: 90, tomorrow_precip_in: 0, tomorrow_pop: 7, upcoming_precip_in: 0.16 },
      expectSmall: null, actual: 1.03 },
    { d: '2026-07-29', hy: { recent_precip_in: 0.8, today_precip_in: 2.2, today_pop: 95, tomorrow_precip_in: 0.02, tomorrow_pop: 72, upcoming_precip_in: 0.03 },
      expectSmall: 'today', actual: 2.84 },
    { d: '2026-08-03', hy: { recent_precip_in: 0, today_precip_in: 4.32, today_pop: 92, tomorrow_precip_in: 0, tomorrow_pop: 0, upcoming_precip_in: 0 },
      expectSmall: 'today', actual: 2.22 },
  ];

  it('reproduces the engine verdict on every qualifying day of the season', () => {
    for (const { d, hy, expectSmall } of SEASON) {
      const got = sup(hy, true);
      expect(got ? got.kind : null, `small-vessel verdict changed on ${d}`).toBe(expectSmall);
    }
  });

  // 2026-06-22 is the day the bar LOOKS like it should matter (1.42" @ 91%) and does not: the incoming
  // branch claims it first, because 1.25" more was forecast for the next day. Recorded because a reader
  // comparing 1.42 against the bar would otherwise conclude this day is bar-sensitive. It is not, at ANY
  // bar value — which is a large part of why the constant is near-inert.
  it('2026-06-22 is claimed by the incoming branch before the bar is ever consulted', () => {
    const { hy } = SEASON[0];
    expect(sup(hy, true).kind).toBe('incoming');
    // The day DOES clear the today gate — so it is branch ORDER, not the gate and not the bar, that
    // decides here. Both vessel classes land on 'incoming', which is what makes the day bar-insensitive.
    expect(todayQualifies(hy)).toBe(true);
    expect(sup(hy, false).kind).toBe('incoming');
  });

  // Every suppression this bar produced on real data was CORRECT: the rain that arrived cleared the
  // abstraction and banked at least a day. This is the false-skip audit, run against measurements rather
  // than against the forecast we acted on.
  it('produced no false skips — every real suppression was covered by the rain that actually fell', () => {
    const skipped = SEASON.filter(s => sup(s.hy, true)?.kind === 'today');
    expect(skipped.length).toBeGreaterThan(0);
    for (const s of skipped) {
      expect(s.actual - IA_SMALL_FAST_IN, `${s.d} suppressed but banked nothing`).toBeGreaterThanOrEqual(CONTAINER_NEED_IN_PER_DAY);
    }
  });

  // The honest blast-radius pin. If a future change makes the bar start firing on new days, that is a real
  // behaviour change and should be a deliberate, visible test edit — not a silent side effect.
  it('the retune from 2.0 changed zero days this season, and that is the recorded result', () => {
    const firesNow = SEASON.filter(s => sup(s.hy, true)?.kind === 'today').map(s => s.d);
    expect(firesNow).toEqual(['2026-07-29', '2026-08-03']);
  });
});

describe('BUG-SOAKBAR-001 — which plantings this constant actually governs', () => {
  // Counter-intuitive and load-bearing: the 5-gal fabric bag that the ORIGINAL 2.0" justification was
  // written about is classified LARGE by isSmallVessel (vesselSizeSmall treats any gallon figure as
  // established), so it has never been governed by this constant at all — it takes the 0.5" bed bar.
  // Live prod census 2026-08-12: 87 of 254 plantings are gallon-sized fabric bags on the BED bar; 95 are
  // small-vessel, and 56 of those 95 qualify only because container_type/size is unset (fail-safe).
  it('gallon-sized fabric bags take the BED bar, not this one', () => {
    expect(isSmallVessel({ container_type: 'fabric_bag', container_size: '5 gal' })).toBe(false);
    expect(isSmallVessel({ container_type: 'fabric_bag', container_size: '10 gal' })).toBe(false);
    const hy = { recent_precip_in: 0, today_precip_in: 0.6, today_pop: 90, tomorrow_precip_in: 0, tomorrow_pop: null };
    expect(sup(hy, isSmallVessel({ container_type: 'fabric_bag', container_size: '5 gal' }))?.kind).toBe('today');
  });

  it('genuinely small vessels and unlabelled rows take this bar', () => {
    expect(isSmallVessel({ container_type: 'tray_cell', container_size: null })).toBe(true);
    expect(isSmallVessel({ container_type: 'plastic_pot', container_size: '3 in' })).toBe(true);
    expect(isSmallVessel({ container_type: null, container_size: null })).toBe(true);  // 25 live rows
  });

  // End-to-end through generatePlanForUser, not just the pure fn — the bar has to survive the plan path.
  it('carries through the composed plan for an unlabelled planting', () => {
    const cad = { default: { water_interval_days_container: 3, water_interval_days_inground: 3, crop: 'generic' }, by_variety: {}, by_genus_fallback: {} };
    const p = withCoverFlags({
      id: 'p1', name: 'Test', project: 'P', project_id: 'pr1', workspace_id: 'w1', genus: 'generic',
      status: 'growing', covered: false, container_type: null, container_size: null,
      last_water: '2026-07-24', transplant_at: null, rain_exposed: null,
    });
    const hy = { recent_precip_in: 0, today_precip_in: 0.95, today_pop: 92, tomorrow_precip_in: 0, tomorrow_pop: null };
    const wx = { tonightLow: 60, highToday: 75, code: 0, short: '', unit: 'F' };
    const plan = generatePlanForUser([p], cad, {}, '2026-08-03', wx, hy, false, false, true);
    const row = (plan.tasks.rain_skipped || []).find(r => r.id === 'p1');
    expect(row, 'unlabelled container not suppressed at the derived bar').toBeTruthy();
    expect(row.sat_kind).toBe('today');
    // measured-water branches untouched by this change
    expect(SOAK_CAP_IN).toBe(1.0);
  });
});
