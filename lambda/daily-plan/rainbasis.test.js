// BUG-F2RAINBASIS-001 — THE BASIS-PARITY GATE.
//
// The legacy engine and the F2 ledger did not read the same precipitation, and nothing checked it.
// That was not a rounding difference: it meant a flag-ON vs flag-OFF comparison on any day with rain
// today reported a RAIN-CREDIT SEMANTICS difference as ledger divergence. Every bound-B and bound-D
// figure the F2 shadow soak produced on such a day was confounded by it.
//
//   LEGACY  engine.js creditPrecip(hy,true) -> recent_precip_in + today_observed_in   ... INCLUDES today
//   LEDGER  ledger.js foldLedger            -> for (d = windowStart; d < todayStr)    ... EXCLUDED today
//                                              over weather_daily, settled days only
//
// The gap was never that the ledger credited LESS. It credited the same rain A DAY LATE: today's
// gauge reading earned nothing until it settled into weather_daily overnight. Measured as a one-day
// phase shift in the shadow soaks — 2026-08-23 (the day 0.34" fell) pushed 29 plantings from
// legacy-skipped to ledger-due, and 2026-08-24 (the day that rain landed in weather_daily) pushed 74
// the other way.
//
// THIS FILE USED TO PIN THAT DIVERGENCE as a known-bad state, and instructed whoever closed it to
// come here and rewrite the block to assert parity instead. That is what happened on 2026-08-24, and
// this is the rewrite. foldLedger now takes an optional `todayPrecip` and emits a D0 day-credit from
// it; engine.js sources it from `hydrology.today_observed_in` and nothing else — byte-identically the
// term creditPrecip spends. The two engines agree BY CONSTRUCTION on what counts, so any residual
// flag-on/flag-off diff measures the MODEL rather than the input.
//
// WHAT THIS GATE IS FOR NOW. Three invariants, each of which a plausible future edit would break:
//   (1) PARITY  — the same field moves both legs, and only that field does.
//   (2) MEASURED-ONLY — the forecast half (today_remaining_in) moves NEITHER leg. Crediting it is
//       BUG-RAINFORECASTCREDIT-001, which retired 32 plantings from a morning watering list on
//       2026-08-08 against 0.97" predicted at 28% PoP, of which 0.04" fell.
//   (3) weather_daily STAYS SETTLED-DAYS-ONLY. The fix deliberately did NOT widen the loop bound to
//       `d <= todayStr`: no D0 row exists to read (the writer skips `d >= today`), and inventing one
//       would persist a partial day. Anyone who widens that bound must fail here.
//
// Measured through the real modules, never read off the source — the same discipline the sibling
// heatdemote.test.js uses, and for the same reason: three separate criteria on this engine read
// fine as prose and were wrong when finally executed.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import engine from './engine.js';
import ledger from './ledger.js';
import LP from './ledgerParams.js';
import lf from './ledger-fixtures.js';

const { windowPrecip, rainCreditDays, generatePlan } = engine;
const { foldLedger, vesselProfile, etMidnightMs, addDays } = ledger;

const TODAY = '2026-06-21';
const YESTERDAY = '2026-06-20';
const DAY = 86400000;

// One qualifying rain amount. 0.50" clears every tier's `normal` bar (0.25) on fabric_ground.
const WET_IN = 0.5;
const WET = { precip_in: WET_IN, et0_in: 0.18, tmax_f: 70 };

// CRITICAL FIXTURE DETAIL — there are TWO clocks here and they test different things.
//
// TWO independent mechanisms used to keep today's rain out of the fold, and they are trivially
// confused:
//   (a) the loop bound          `for (d = windowStartStr; d < todayStr; ...)`
//   (b) the credit-time filter  a settled day-credit lands at 23:59 ET of its day and is dropped by
//                               `if (t > effNowMs) return`
// With a midday effNowMs, (b) alone suppresses a today-keyed credit, so a test written that way
// passes whatever the loop bound says — it cannot see (a) at all. Verified originally by mutating
// the bound to `<=` and watching such a test stay green. LATE (23:59:30) disarms (b), so the loop
// bound is the only thing still excluding a weather_daily row keyed to today — which is invariant
// (3) above and is asserted at LATE for exactly that reason.
//
// MID (12:00) is the clock for the NEW D0 term, and it is equally load-bearing: the D0 credit is
// positioned at effNow, so at MID it must land AND leave zero demand accruing behind it. A credit
// wrongly positioned at 23:59 would be dropped by (b) and a credit wrongly positioned at 00:00
// would leave twelve hours of demand on the board. Only effNow gives d === 0 exactly.
const LATE = etMidnightMs(TODAY) + DAY - 30000;
const MID = etMidnightMs(TODAY) + 12 * 3600000;

// A watering yesterday at noon keeps D well under the long-dry hedge, so a Normal credit resolves
// through applyDepth's plain `return 0` rather than the partial-rewet branch. That is what makes the
// exact-zero assertion below a statement about POSITION rather than about the hedge arithmetic.
const WATERED_YESTERDAY = [{ id: 'w1', t: etMidnightMs(YESTERDAY) + 12 * 3600000, type: 'watering', depth: null }];

function ctx(over = {}) {
  return {
    wiEff: 3,
    thr: 3,
    events: WATERED_YESTERDAY,
    weatherByDate: {},
    weatherRowCount: 30,                     // >= CONFIDENCE.minWeatherRows, so not degenerate
    todayStr: TODAY,
    effNowMs: MID,
    todayEt0: 0.18,
    todayTmax: 70,
    exposure: 'outdoor',
    vessel: vesselProfile('fabric_bag', '5 gal'),
    rainTier: 'fabric_ground',
    transplantAt: null,
    ...over,
  };
}
const fold = (over) => foldLedger(ctx(over));

describe('BUG-F2RAINBASIS-001 — the two engines now read the same precipitation', () => {
  describe('LEGACY leg: today counts, and it is the GAUGE half that counts', () => {
    it('the live measured basis is recent + today_observed_in', () => {
      // Read through rainCreditDays rather than off the source: `wp` on the returned credit IS the
      // basis the credit was granted on, so this executes the real path the plan takes.
      const rc = rainCreditDays('outdoor', 3, { recent_precip_in: 0.10, today_observed_in: 0.42, today_remaining_in: 0.90, today_precip_in: 1.32 }, true);
      expect(rc.wp).toBeCloseTo(0.52, 6);
    });

    it('rain that fell ONLY today still produces a basis above zero', () => {
      // The whole point: with nothing recent, today alone carries the credit decision.
      expect(rainCreditDays('outdoor', 3, { recent_precip_in: 0, today_observed_in: WET_IN }, true).wp).toBeCloseTo(WET_IN, 6);
    });

    it('the still-expected half buys nothing — measured and forecast are NOT interchangeable', () => {
      // These two hydrology bags describe OPPOSITE realities: in the first 0.30" has actually fallen,
      // in the second not a drop has and 0.30" is merely predicted for the rest of the day. The
      // pre-flag basis (windowPrecip) could not tell them apart, which is BUG-RAINFORECASTCREDIT-001.
      const hasRained = { recent_precip_in: 0.1, today_precip_in: 0.30, today_observed_in: 0.30, today_remaining_in: 0 };
      const notADropYet = { recent_precip_in: 0.1, today_precip_in: 0.30, today_observed_in: 0, today_remaining_in: 0.30 };
      expect(windowPrecip(hasRained)).toBe(windowPrecip(notADropYet));                 // the old, blind basis
      expect(rainCreditDays('outdoor', 3, hasRained, true).wp).toBeCloseTo(0.40, 6);
      expect(rainCreditDays('outdoor', 3, notADropYet, true)).toBe(null);              // 0.10" < RAIN_IA
    });
  });

  describe('LEDGER leg: today counts too, from the gauge, positioned at now', () => {
    it('a rain row keyed to YESTERDAY earns day-credit', () => {
      // Establishes the instrument can move at all. Without this, the next tests could pass
      // vacuously — "no credit" is also satisfied by a fold that never grants credit for anything.
      expect(fold({ weatherByDate: { [YESTERDAY]: WET } }).d).toBeLessThan(fold().d);
    });

    it('todayPrecip earns a same-day credit — this is the fix', () => {
      expect(fold({ todayPrecip: WET_IN }).d).toBeLessThan(fold().d);
    });

    it('the credit lands AT effNow, so no demand accrues behind it', () => {
      // Exact zero, not "less than". A Normal credit on a profile under the long-dry hedge resets D
      // flat to 0 (applyDepth), so d at effNow can only be 0 if the credit is positioned there:
      //   at 00:00 ET -> twelve hours of demand accrue after it, d ≈ 0.6
      //   at 23:59 ET -> in the future at every run, clipped by `t > effNowMs`, d unchanged at ≈ 1.86
      expect(fold({ todayPrecip: WET_IN }).d).toBe(0);
      expect(fold().d).toBeGreaterThan(1);            // and the dry control is nowhere near 0
    });

    it('the depth mapping applies to today exactly as it does to a settled day', () => {
      // Same tier table, same arithmetic — the D0 term is not a second, softer credit path.
      const dry = fold().d;
      expect(fold({ todayPrecip: 0.05 }).d).toBe(dry);                       // under the 0.10" light floor: trace
      expect(fold({ todayPrecip: 0.12 }).d).toBeCloseTo(dry - LP.LIGHT_CREDIT_WI * 3, 6);   // light
      expect(fold({ todayPrecip: 0.30 }).d).toBe(0);                         // normal -> reset
    });

    it('the bag-heat demotion applies to today too', () => {
      // tmax is BOTH the demotion input and a demand input for a fabric bag, so the control must be
      // a dry fold at the SAME tmax — comparing against the 70F dry fold would credit the demotion
      // with a demand difference it did not cause.
      const hot = { todayTmax: 90 };                                          // >= RAIN_DAY.bagHeatSoftenF
      const dryHot = fold(hot).d;
      expect(fold({ ...hot, todayPrecip: WET_IN }).d).toBeCloseTo(dryHot - LP.LIGHT_CREDIT_WI * 3, 6); // normal demoted to light
      expect(fold({ todayPrecip: WET_IN }).d).toBe(0);                        // ...and undemoted at 70F
    });

    it('a covered planting earns nothing from today, same as from any other day', () => {
      const covered = { exposure: 'covered' };
      expect(fold({ ...covered, todayPrecip: WET_IN }).d).toBe(fold(covered).d);
    });

    it('no gauge (todayPrecip absent) is inert — every pre-existing caller is byte-identical', () => {
      expect(fold({ todayPrecip: null }).d).toBe(fold().d);
      expect(fold({ todayPrecip: undefined }).d).toBe(fold().d);
    });
  });

  describe('weather_daily STAYS settled-days-only — the fix went the other way on purpose', () => {
    it('a rain row keyed to TODAY still earns nothing, even at 23:59', () => {
      // At LATE the 23:59 credit-time filter is disarmed, so the loop bound `d < todayStr` is the
      // only thing excluding this row — which is what makes the assertion mean what it claims.
      // Widening that bound is the fix that was NOT taken: handler.js writes settled days only and
      // re-guards `d >= today`, so there is no D0 row to read and a `<=` bound would either be dead
      // code or, worse, an invitation to start persisting a day that has not finished.
      const late = { effNowMs: LATE };
      expect(fold({ ...late, weatherByDate: { [TODAY]: WET } }).d).toBe(fold(late).d);
      // ...and the same row keyed one day earlier does move it, so the fixture is not the reason.
      expect(fold({ ...late, weatherByDate: { [YESTERDAY]: WET } }).d).toBeLessThan(fold(late).d);
    });

    it('the settled loop is exclusive of today by construction, not by data chance', () => {
      expect(String(foldLedger)).toMatch(/d\s*<\s*todayStr/);
    });
  });

  describe('THE PARITY — this is the tripwire now', () => {
    it('the same gauge reading moves BOTH legs, and the forecast half moves NEITHER', () => {
      const measured = { recent_precip_in: 0, today_observed_in: WET_IN, today_remaining_in: 0, today_precip_in: WET_IN };
      const forecast = { recent_precip_in: 0, today_observed_in: 0, today_remaining_in: WET_IN, today_precip_in: WET_IN };

      // Legacy: measured earns credit, forecast earns none.
      expect(rainCreditDays('outdoor', 3, measured, true)).toBeTruthy();
      expect(rainCreditDays('outdoor', 3, forecast, true)).toBe(null);
      // Ledger: identically.
      expect(fold({ todayPrecip: measured.today_observed_in }).d).toBeLessThan(fold().d);
      expect(fold({ todayPrecip: forecast.today_observed_in }).d).toBe(fold().d);
      // And the two bags are indistinguishable to the OLD basis — the defect, still assertable.
      expect(windowPrecip(measured)).toBe(windowPrecip(forecast));
    });
  });
});

// ── End-to-end: the engine actually threads today_observed_in into the fold ─────────────────────
// The pure-fold tests above all pass if ledger.js is perfect and engine.js never passes the field.
// That is the single most likely way this fix rots, so it gets its own block, run through
// generatePlan under the LIVE prod flag combo plus the measured-credit and ledger flags.
describe('BUG-F2RAINBASIS-001 — wired end-to-end through generatePlan', () => {
  const here = (p) => fileURLToPath(new URL(p, import.meta.url));
  const cadence = JSON.parse(readFileSync(here('./cadence-data-v2.json'), 'utf8'));
  const fertModel = JSON.parse(readFileSync(here('./fertilization-model.json'), 'utf8'));
  const NOW = lf.at(lf.TODAY, 15, 30);                 // the 15:30 ET intraday run — gauge has a full day
  const PLANT = lf.P({
    id: 'r1', container_type: 'in_ground', container_size: null, covered: false,
    last_water: lf.ago(6),
    db_cadence: lf.SEED({ water_interval_days_container: 3, water_interval_days_inground: 3 }),
  });
  // today_pop 0 and tomorrow 0 keep every saturation branch out of this: the only thing that can
  // move the verdict is rain credit, which is what we are measuring.
  const hy = (observed) => ({ ...lf.HY, recent_precip_in: 0, today_pop: 0,
    today_observed_in: observed, today_remaining_in: 0, today_precip_in: observed });
  const run = (observed, waterLedgerEnabled) => generatePlan({
    plantings: [PLANT], cadence, fertModel, today: lf.TODAY, nowMs: NOW, weather: lf.WX,
    hydrology: hy(observed), ownerFallback: 'dave',
    weatherDaily: lf.weatherDaily(), eventsByPlant: { r1: [lf.w(lf.ago(6), 12, null, 'e1')] },
    rainCreditEnabled: true, rainMaxDaysEnabled: false, todayAwareEnabled: true,
    measuredCreditEnabled: true, waterLedgerEnabled,
  });
  const row = (plan) => {
    const u = Object.values(plan.users)[0];
    const d = u.tasks.water_due.find((x) => x.id === 'r1');
    return d ? { verdict: 'water', d: d.ledger ? d.ledger.d : null } : { verdict: 'not_due', d: null };
  };

  it('the ledger sees today\'s gauge: 6 days dry is due, and today\'s rain retires it', () => {
    expect(row(run(0, true))).toEqual({ verdict: 'water', d: 6.72 });
    // 0.12" is Light for the in_ground tier: real credit, not enough to retire a 6-day gap.
    expect(row(run(0.12, true))).toEqual({ verdict: 'water', d: 5.22 });
    // 0.30" is Normal: full reset, and the planting drops off the list.
    expect(row(run(0.30, true))).toEqual({ verdict: 'not_due', d: null });
  });

  it('the forecast half changes NOTHING end-to-end', () => {
    const stillDry = generatePlan({
      plantings: [PLANT], cadence, fertModel, today: lf.TODAY, nowMs: NOW, weather: lf.WX,
      hydrology: { ...lf.HY, recent_precip_in: 0, today_pop: 0,
        today_observed_in: 0, today_remaining_in: 0.75, today_precip_in: 0.75 },
      ownerFallback: 'dave', weatherDaily: lf.weatherDaily(),
      eventsByPlant: { r1: [lf.w(lf.ago(6), 12, null, 'e1')] },
      rainCreditEnabled: true, rainMaxDaysEnabled: false, todayAwareEnabled: true,
      measuredCreditEnabled: true, waterLedgerEnabled: true,
    });
    expect(row(stillDry)).toEqual({ verdict: 'water', d: 6.72 });
  });

  it('and both engines agree on WHICH DAY the rain counted — the phase shift is gone', () => {
    // Legacy leg, same hydrology: 0.30" clears RAIN_TIER_IA.in_ground (0.20) TODAY, so the legacy
    // chain grants credit today. Before this fix the ledger granted it tomorrow. Now both spend it
    // on the same day, and the residual disagreement below (legacy still waters, ledger does not) is
    // the F2 MODEL — continuous demand vs a 3-day interval hold — which is what the soak measures.
    expect(rainCreditDays('outdoor', 3, hy(0.30), true)).toBeTruthy();
    expect(row(run(0.30, false)).verdict).toBe('water');
    expect(row(run(0.30, true)).verdict).toBe('not_due');
    // The credit is same-day on BOTH sides: with no rain at all the ledger waters too, so the
    // not_due above is caused by today's gauge and by nothing else in the fixture.
    expect(row(run(0, true)).verdict).toBe('water');
  });
});
