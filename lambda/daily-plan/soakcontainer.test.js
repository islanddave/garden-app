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
  SOAK_TODAY_SMALL_IN, SOAK_CAP_IN, isSmallVessel, RAIN_TIER_IA, rainTierFor,
} = engine;
// Read from the shared JSON, not from an engine export: this doubles as proof that the value the engine
// acts on is the value in the single-source file, so a private literal reintroduced in engine.js fails here.
const { SOAK_FCST_QPF_IN } = THRESHOLDS;

// The two agronomic inputs the derivation rests on. Kept as named constants so a reader can see that the
// assertions below are arithmetic over Dave's number and the engine's own number, not free-floating magic.
const CONTAINER_NEED_IN_PER_DAY = 0.075;  // Dave-observed, 2026-08-12: "containers are VERY happy with .075 a day"
// BUG-SOAKTESTLITERAL-001: READ from the engine, never transcribed. As a local `= 0.35` this line made the
// header's "arithmetic over the engine's own number" claim FALSE — retuning RAIN_TIER_IA.small_fast left the
// derivation below asserting against a number the engine had stopped using, and every test here stayed green
// (verified: at small_fast 0.40 the pre-fix file passed 13/13). Importing it is what makes the derivation
// track its source, so a retune that invalidates the physics fails here instead of going quiet.
const IA_SMALL_FAST_IN = RAIN_TIER_IA.small_fast;  // live in prod (CARE_RAIN_CREDIT_ENABLED=true)
const WORST_OBSERVED_DELIVERY = 0.47;     // 2026-06-22: 1.42" forecast @ 91% PoP -> 0.67" actually delivered

const sup = (hy, smallVessel) => saturationSuppressed('outdoor', hy, { todayAware: true, smallVessel });

describe('BUG-SOAKBAR-001 — the bar is derived, and the derivation is executable', () => {
  // The headline behaviour change. At the old 2.0" bar a container facing a 0.9" forecast at 92% PoP was
  // told to water; the derivation says 0.9" is precisely the point where even the season's worst forecast
  // bust still banks a full day. THIS IS THE TEST THAT FAILS AT 2.0.
  // BUG-RAINTIERFALLBACK-001: bar retuned 0.91 -> 0.53 (the loss term it derives from moved 0.35 -> 0.17).
  // Read the bar from the engine rather than restating it, so the next retune moves this fixture with it
  // instead of failing here as a stale literal — the same lesson BUG-SOAKTESTLITERAL-001 taught above.
  it('suppresses a small vessel at the derived bar, and still waters just below it', () => {
    const at = { recent_precip_in: 0, today_precip_in: SOAK_TODAY_SMALL_IN, today_pop: 92, tomorrow_precip_in: 0, tomorrow_pop: null };
    expect(sup(at, true)?.kind).toBe('today');
    const below = { ...at, today_precip_in: SOAK_TODAY_SMALL_IN - 0.01 };
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
      expect(sup(hy, true)?.kind).toBe('today');   // the real engine, same input, still suppresses at its own bar
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Arithmetic, not a restatement of the literal: if someone retunes the bar without redoing the physics,
  // this fails. A bar that cannot cover one day of need under the worst measured bust is not defensible.
  it('a worst-case forecast bust at the bar still banks a full day of container need', () => {
    // The loss term has to be the loss the vessels this bar governs ACTUALLY take, not just a table entry
    // that happens to be spelled small_fast: remap a rigid pot to a gentler tier and the derivation below
    // would be subtracting an abstraction containers never pay. Pinned via the engine's own resolver.
    expect(RAIN_TIER_IA[rainTierFor('plastic_pot')]).toBe(IA_SMALL_FAST_IN);
    // BUG-RAINTIERFALLBACK-001: was `expect(RAIN_TIER_IA[rainTierFor(null)]).toBe(IA_SMALL_FAST_IN)` — "unknown
    // vessels land here too". They no longer do, deliberately: rainTierFor now resolves NULL/unrecognised to the
    // derived 'unknown' row so the fail-safe survives a small_fast retune. That does NOT weaken this derivation,
    // because the bar being derived governs `smallVessel` (vesselProfile), and a rigid pot — pinned above — is
    // what actually pays IA_SMALL_FAST_IN. What must still hold is the direction: an unknown vessel clears a bar
    // at least as high as the rigid pot it used to alias, never a lower one.
    expect(RAIN_TIER_IA[rainTierFor(null)]).toBeGreaterThanOrEqual(IA_SMALL_FAST_IN);
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
    // BUG-RAINFORECASTCREDIT-001 residual (2026-08-24): was 'incoming', is now 'today'. The incoming
    // branch's "already wet" prerequisite moved from windowPrecip to soakBasis — MEASURED water only —
    // and on this day nothing had been measured at all (recent 0, no gauge split in the payload), so
    // the branch that used to claim the day was asserting wet media on a forecast. Same suppression,
    // honest label, and now it is the today branch's own bars deciding it: PoP 91 >= 60 and 1.42" >=
    // the 0.91" small-vessel bar. See the dedicated test below for what this day does and does not prove.
    { d: '2026-06-22', hy: { recent_precip_in: 0, today_precip_in: 1.42, today_pop: 91, tomorrow_precip_in: 1.25, tomorrow_pop: 74, upcoming_precip_in: 1.25 },
      expectSmall: 'today', actual: 0.67 },
    { d: '2026-07-07', hy: { recent_precip_in: 0, today_precip_in: 0.74, today_pop: 90, tomorrow_precip_in: 0, tomorrow_pop: 7, upcoming_precip_in: 0.16 },
      // BUG-RAINTIERFALLBACK-001 (2026-09-06): was `null`. This is the ONE day in the season the 0.91 -> 0.53
      // retune flips, and it flips toward suppression: forecast 0.74" clears 0.53" where it missed 0.91".
      // `actual` says the call is right — 1.03" fell, MORE than forecast, so the containers genuinely got their
      // water. That is worth stating plainly because the retune widens FORECAST-based suppression, which is the
      // direction the header argues against; this day is the evidence that the widened bar is not reckless, and
      // the season's worst bust (06-22, 1.42" -> 0.67") was already suppressed at the OLD bar, so the retune
      // does not touch it.
      expectSmall: 'today', actual: 1.03 },
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

  // 2026-06-22 USED to be claimed by the incoming branch before the bar was ever consulted, and was
  // recorded here as bar-INSENSITIVE at any bar value. That is no longer true, and the reversal is the
  // point of this test now. The incoming branch's "already wet" prerequisite reads soakBasis (measured
  // actuals + today's gauge) instead of windowPrecip (which folds in today's unelapsed FORECAST).
  // On this day the gauge split does not even exist in the payload and recent was 0 — not one drop had
  // been measured — so "rain incoming on already-wet media" was a false premise, and a forecast was
  // satisfying a wetness floor and then being skipped on a second forecast. The day now falls to the
  // today branch, which is where a forecast-only skip belongs and which applies its own bars.
  //
  // This MATTERS beyond the label. `today` is deliberately SUBORDINATE to the fast-dry carve-outs
  // (engine.js _satApplies: a fresh transplant or a hot fabric bag is watered anyway) while `incoming`
  // outranks them, and `today` is the only branch that consults the small-vessel bar. So a day like
  // this one now waters the plantings those carve-outs exist to protect, and a weaker forecast that
  // used to be claimed by incoming will now have to clear 0.91" to hold a small vessel at all.
  it('2026-06-22 is a FORECAST skip, not an already-wet skip — the bar decides it now', () => {
    const { hy } = SEASON[0];
    expect(sup(hy, true).kind).toBe('today');
    expect(sup(hy, false).kind).toBe('today');
    expect(todayQualifies(hy)).toBe(true);
    // Nothing had been measured: this is exactly the premise the incoming branch used to assert.
    expect((hy.recent_precip_in || 0) + (hy.today_observed_in || 0)).toBe(0);
    // And it IS bar-sensitive now — the same day under a bar above the forecast waters the container.
    // Proven behaviourally against a real patched threshold file, the same hermetic trick used above,
    // so this cannot pass on an arithmetic restatement of the literal.
    const dir = mkdtempSync(join(tmpdir(), 'soakbar622-'));
    try {
      cpSync(dirname(fileURLToPath(import.meta.url)), dir, { recursive: true });
      const jsonPath = join(dir, 'wateringThresholds.json');
      writeFileSync(jsonPath, JSON.stringify(
        { ...JSON.parse(readFileSync(jsonPath, 'utf8')), SOAK_TODAY_SMALL_IN: 1.75 }, null, 2) + '\n');
      const patched = createRequire(import.meta.url)(join(dir, 'engine.js'));
      expect(patched.saturationSuppressed('outdoor', hy, { todayAware: true, smallVessel: true })).toBe(null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
  // 2026-08-24, BUG-RAINFORECASTCREDIT-001 residual: that is exactly what happened, and this is the
  // deliberate edit. 2026-06-22 joined the list — not because the bar moved (it did not) but because the
  // incoming branch stopped claiming days on unmeasured rain, so the bar is consulted on one more day of
  // the season than before. One day of 56 nightly runs; every other day is unchanged.
  it('the bar fires on all four days this season — 07-07 joined when the bar dropped to 0.53', () => {
    const firesNow = SEASON.filter(s => sup(s.hy, true)?.kind === 'today').map(s => s.d);
    expect(firesNow).toEqual(['2026-06-22', '2026-07-07', '2026-07-29', '2026-08-03']);
    // Every qualifying day of the season now suppresses, so this list has stopped discriminating: at 0.53"
    // no day in the corpus separates fire from no-fire. Pin the boundary directly instead, or the assertion
    // above degrades into "the bar is below every forecast we have" and cannot fail for the right reason.
    const justUnder = { ...SEASON[1].hy, today_precip_in: SOAK_TODAY_SMALL_IN - 0.01 };
    expect(sup(justUnder, true)).toBe(null);
    // And no day in the season is claimed by incoming any more: every payload here predates the gauge
    // split, so soakBasis is `recent` alone and only 07-29 carries any measured water at all (0.8" < 1.0"
    // cap, < 0.5"... no: 0.8 >= 0.5, but its tomorrow_precip_in is 0.02, below the more-coming bar).
    expect(SEASON.filter(s => sup(s.hy, true)?.kind === 'incoming').map(s => s.d)).toEqual([]);
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
