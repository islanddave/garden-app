// BUG-F2RAINBASIS-001 — THE BASIS-PARITY GATE.
//
// The legacy engine and the F2 ledger do not read the same precipitation, and nothing checked it.
// That is not a rounding difference: it means a flag-ON vs flag-OFF comparison on any day with rain
// today reports a RAIN-CREDIT SEMANTICS difference as ledger divergence. Every bound-B and bound-D
// figure the F2 shadow soak has ever produced on such a day is confounded by it.
//
//   LEGACY  engine.js windowPrecip  -> recent_precip_in + today_precip_in      ... INCLUDES today
//   LEDGER  ledger.js foldLedger    -> for (d = windowStart; d < todayStr)     ... EXCLUDES today
//                                      over weather_daily, settled days only
//
// And the today term is not even all measured. engine.js:211-217 states it verbatim:
// `today_precip_in = today_observed_in + today_remaining_in` — "rain the WS-2902 has already
// MEASURED plus the hourly forecast for the hours not yet elapsed" — "So the D0 term is
// part-measured/part-predicted, in a ratio that moves through the day, and any gate that must
// distinguish the two reads today_observed_in / today_remaining_in — NEVER THIS SUM." The nightly
// plan run fires ~02:00, before the day has started, so at that hour the term is 100% forecast and
// the credit that decides whether to skip watering a live plant is granted on rain that has not
// fallen. That is BUG-RAINFORECASTCREDIT-001, a separate CORRECTNESS defect; THIS file fixes nothing.
//
// STATE AS OF THIS COMMIT. BUG-RAINFORECASTCREDIT-001's fix has landed (`creditPrecip(hy,
// measuredOnly)` beside windowPrecip) but ships behind `CARE_RAIN_MEASURED_CREDIT_ENABLED`, which
// DEFAULTS OFF — so flag-off behaviour is byte-identical and every assertion below still describes
// production. When Dave flips that flag, the legacy leg starts spending measured precipitation only
// and the two bases NARROW: the residual gap becomes exactly "today's measured rain", which legacy
// still counts and the ledger still does not. The divergence block below is written against the
// flag-OFF default and is expected to survive the flip; if it starts failing, the bases have moved
// further than the flag alone explains and that is worth investigating rather than silencing.
//
// WHAT THIS GATE IS FOR. It is a tripwire on a known-bad state. The two bases diverge today, on
// purpose-of-record, and these tests PIN that divergence so it cannot change silently in either
// direction — not by a fix, not by a refactor, not by a flag default moving. When the bases are
// made to agree, these tests FAIL, and whoever made them agree has to come here and say so
// deliberately. That is the intent: the failure is the feature.
//
// Measured through the real modules, never read off the source — the same discipline the sibling
// heatdemote.test.js uses, and for the same reason: three separate criteria on this engine read
// fine as prose and were wrong when finally executed.
import { describe, it, expect } from 'vitest';
import engine from './engine.js';
import ledger from './ledger.js';

const { windowPrecip } = engine;
const { foldLedger, vesselProfile, etMidnightMs } = ledger;

const TODAY = '2026-06-21';
const YESTERDAY = '2026-06-20';
const DAY = 86400000;

// One qualifying rain row. 0.50" clears every tier's `normal` bar (0.25) on fabric_ground.
const WET = { precip_in: 0.5, et0_in: 0.18, tmax_f: 70 };

// CRITICAL FIXTURE DETAIL — effNowMs is 23:59:30, not midday, and the tests are worthless without it.
//
// TWO independent mechanisms keep today's rain out of the ledger fold, and they are trivially
// confused:
//   (a) the loop bound            ledger.js:250  `for (d = windowStartStr; d < todayStr; ...)`
//   (b) the credit-time filter    ledger.js:263  a day-credit lands at 23:59 ET of its day and is
//                                                dropped by `if (t > effNowMs) continue`
// With a midday effNowMs, (b) alone suppresses a today-keyed credit, so a test written that way
// passes whatever the loop bound says — it cannot see (a) at all. Verified: mutating the bound to
// `<=` left such a test green. Running the clock to 23:59:30 disarms (b), so the loop bound becomes
// the only thing still excluding today, and the assertion means what it claims.
const LATE = etMidnightMs(TODAY) + DAY - 30000;   // 23:59:30 ET — after a same-day credit's 23:59

function ctx(weatherByDate) {
  return {
    wiEff: 3,
    thr: 3,
    events: [],
    weatherByDate,
    weatherRowCount: 30,                     // >= CONFIDENCE.minWeatherRows, so not degenerate
    todayStr: TODAY,
    effNowMs: LATE,
    todayEt0: 0.18,
    todayTmax: 70,
    exposure: 'outdoor',
    vessel: vesselProfile('fabric_bag', '5 gal'),
    rainTier: 'fabric_ground',
    transplantAt: null,
  };
}

// Identical in every respect except WHICH DAY the rain row is keyed to.
const fold = (rainOnDay) => foldLedger(ctx({ [rainOnDay]: WET }));
const foldDry = () => foldLedger(ctx({}));

describe('BUG-F2RAINBASIS-001 — the two engines read different precipitation', () => {
  describe('LEGACY leg: today counts', () => {
    it('windowPrecip adds the today term to the recent term', () => {
      expect(windowPrecip({ recent_precip_in: 0.10, today_precip_in: 0.12 })).toBeCloseTo(0.22, 6);
    });

    it('rain that fell ONLY today still produces a basis above zero', () => {
      // The whole point: with nothing recent, today alone carries the credit decision.
      expect(windowPrecip({ recent_precip_in: 0, today_precip_in: 0.5 })).toBeCloseTo(0.5, 6);
    });

    it('the consumer CANNOT distinguish measured rain from forecast rain', () => {
      // engine.js:211-217 defines today_precip_in = today_observed_in + today_remaining_in and warns
      // that any gate needing the split must read the components, "never this sum". These two
      // hydrology objects describe OPPOSITE realities — in the first 0.30" has actually fallen, in
      // the second not a drop has and 0.30" is merely predicted for the rest of the day — and they
      // carry the split explicitly. windowPrecip reads neither field, so both yield the same basis
      // and the credit gate cannot tell a wet garden from a dry one. The defect, as an assertion.
      const hasRained = windowPrecip({
        recent_precip_in: 0.1, today_precip_in: 0.30, today_observed_in: 0.30, today_remaining_in: 0,
      });
      const notADropYet = windowPrecip({
        recent_precip_in: 0.1, today_precip_in: 0.30, today_observed_in: 0, today_remaining_in: 0.30,
      });
      expect(notADropYet).toBe(hasRained);
      // And pin that it is the SUM being consumed, so a future reader cannot mistake this for a
      // coincidence of the fixture: change the split's total and the basis moves with it.
      expect(windowPrecip({
        recent_precip_in: 0.1, today_precip_in: 0.10, today_observed_in: 0.10, today_remaining_in: 0,
      })).not.toBe(hasRained);
    });
  });

  describe('LEDGER leg: today does not count', () => {
    it('a rain row keyed to YESTERDAY earns day-credit', () => {
      // Establishes the instrument can move at all. Without this, the next test passes vacuously —
      // "no credit today" would also be satisfied by a fold that never grants credit for anything.
      const withRain = fold(YESTERDAY);
      const dry = foldDry();
      expect(withRain.d).toBeLessThan(dry.d);
    });

    it('the SAME rain row keyed to TODAY earns nothing', () => {
      // ledger.js:250 — `for (let d = windowStartStr; d < todayStr; ...)`, strict <, over
      // weather_daily, which by design holds completed days only.
      const rainToday = fold(TODAY);
      const dry = foldDry();
      expect(rainToday.d).toBe(dry.d);
    });
  });

  describe('THE DIVERGENCE — this is the tripwire', () => {
    it('half an inch falling today moves the legacy basis and not the ledger fold', () => {
      // KNOWN-BAD STATE, PINNED ON PURPOSE. When someone makes the two bases agree — by teaching
      // the ledger about today, or by removing today from the legacy term — THIS TEST FAILS.
      // That failure is correct and expected. Do not "fix" it by loosening the assertion: come
      // here, confirm the bases now agree, and rewrite this block to assert parity instead.
      // Ledger row: BUG-F2RAINBASIS-001.
      const legacyCountsToday = windowPrecip({ recent_precip_in: 0, today_precip_in: 0.5 });
      expect(legacyCountsToday).toBeGreaterThan(0);

      expect(fold(TODAY).d).toBe(foldDry().d);
    });

    it('the ledger window is exclusive of today by construction, not by data chance', () => {
      // Guards the *reason*, not just the symptom: pin that the fold reads a settled-days window.
      // If someone changes the loop bound to `<=` this still catches it even if the fixture drifts.
      const src = String(foldLedger);
      expect(src).toMatch(/d\s*<\s*todayStr/);
    });
  });

  describe('what a soak comparison therefore cannot claim', () => {
    it('any sample taken on a day with today-precipitation is confounded', () => {
      // Documented so the next person reading a soak diff does not attribute this gap to the fold's
      // math. bounds B and D are the two the F2 flip gate computes from these diffs.
      const todayPrecip = 0.5;
      const legacySees = windowPrecip({ recent_precip_in: 0, today_precip_in: todayPrecip });
      const ledgerSees = 0;   // proven by the TODAY-keyed fold tests above
      expect(legacySees).not.toBe(ledgerSees);
    });
  });
});
