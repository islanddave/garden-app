// rainLog.test.js — V4-RAINAUTOLOG-001 part 2.
//
// Fixtures are drawn from the REAL recovered gauge series (see migrations/v4-rainbackfill-001),
// not invented. That is deliberate: an earlier ticket in this repo shipped a green suite whose
// fixture was the one shape where nothing repeated, and a browser render found the bug the tests
// could not. The days below are the ones that actually happened, including the awkward ones —
// 2026-07-22 measured EXACTLY the threshold, and 2026-08-01 is a real hole in the station's series.

// rainLog.js is CommonJS (the whole daily-plan Lambda is), so the module is require()d through
// createRequire while vitest itself must be imported — mixing the two is what this preamble is for.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
const { resolveRainRun, rainAutologState, rainDecision, previousDay, rainMetadata, GAUGE_SOURCE } =
  createRequire(import.meta.url)('./rainLog.js');

const gauge = (precip_in) => ({ precip_in, precip_source: GAUGE_SOURCE });
const model = (precip_in, src = 'openmeteo_archive') => ({ precip_in, precip_source: src });

describe('resolveRainRun — which of the three daily runs may log', () => {
  // The three real crons, converted to ET. Named so a failure says which run broke.
  it('logs on the nightly run (02:00 ET, cron(0 6) under EDT)', () => {
    expect(resolveRainRun({}, { etHour: 2 })).toMatchObject({ log: true, slot: 'nightly' });
  });

  it('logs at 01:00 ET too — the same cron under EST, which is why the window is not one hour', () => {
    expect(resolveRainRun({}, { etHour: 1 }).log).toBe(true);
  });

  it('ALSO matches intraday-am at 05:30 ET — so the once-a-day cap rests on the already-logged guard', () => {
    // Documenting the overlap rather than pretending it away. handler.js must not log twice; this
    // test exists so that anyone who removes that guard sees, here, why it was load-bearing.
    expect(resolveRainRun({}, { etHour: 5 }).log).toBe(true);
  });

  it('does NOT log on intraday-pm (15:30 ET) — that run is the frost slot', () => {
    expect(resolveRainRun({}, { etHour: 15 })).toMatchObject({ log: false, slot: 'other' });
  });

  it('does not log when the ET hour is unavailable, and says so', () => {
    expect(resolveRainRun({}, {})).toMatchObject({ log: false, reason: 'no_et_hour' });
    expect(resolveRainRun({}, { etHour: 'not-a-number' }).reason).toBe('no_et_hour');
  });

  it('event.rainLog forces and suppresses — the rehearsal lever', () => {
    expect(resolveRainRun({ rainLog: true }, { etHour: 15 }).log).toBe(true);
    expect(resolveRainRun({ rainLog: false }, { etHour: 2 }).log).toBe(false);
  });

  it('hour 0 is inside the window — a boundary a >0 test would have passed by accident', () => {
    expect(resolveRainRun({}, { etHour: 0 }).log).toBe(true);
  });

  describe('RAIN_AUTOLOG_ENABLED — its own switch, opposite polarity to CARE_WATER_LEDGER_ENABLED', () => {
    const prev = process.env.RAIN_AUTOLOG_ENABLED;
    afterEach(() => {
      if (prev === undefined) delete process.env.RAIN_AUTOLOG_ENABLED;
      else process.env.RAIN_AUTOLOG_ENABLED = prev;
    });

    it('defaults ON when unset — an unset env must not silently stop rain being logged', () => {
      delete process.env.RAIN_AUTOLOG_ENABLED;
      expect(resolveRainRun({}, { etHour: 2 }).log).toBe(true);
    });

    it("disarms ONLY on the exact string 'false'", () => {
      process.env.RAIN_AUTOLOG_ENABLED = 'false';
      expect(resolveRainRun({}, { etHour: 2 })).toMatchObject({ log: false, reason: 'flag_off' });
    });

    it('stays ON for other falsy-looking values — 0, "no", "" must not disarm it', () => {
      for (const v of ['0', 'no', '', 'FALSE', 'off']) {
        process.env.RAIN_AUTOLOG_ENABLED = v;
        expect(resolveRainRun({}, { etHour: 2 }).log, `value ${JSON.stringify(v)} must not disarm`).toBe(true);
      }
    });

    it('outranks the event override — a forced run cannot bypass a deliberate disable', () => {
      process.env.RAIN_AUTOLOG_ENABLED = 'false';
      expect(resolveRainRun({ rainLog: true }, { etHour: 2 }).log).toBe(false);
    });

    // ── BUG-RAINAUTOLOGCLIFF-001 — the arming state must be readable from the VALUE ──────────────
    // The four tests above pin BEHAVIOUR and none of them changed. These pin the thing that was
    // actually broken: for months the live answer was "armed", the live config was "key absent",
    // and nothing connected the two — so every investigation of this writer went to the wrong flag.
    // A test that only asserts `.log` cannot tell an explicit decision from an unset variable, which
    // is exactly how the gap survived a green suite.
    describe('the arming state is reported, not inferred', () => {
      it("'true' arms and says it was an explicit decision", () => {
        process.env.RAIN_AUTOLOG_ENABLED = 'true';
        expect(rainAutologState()).toEqual({ enabled: true, config: 'explicit_on' });
        expect(resolveRainRun({}, { etHour: 2 })).toMatchObject({ log: true, flag: 'explicit_on' });
      });

      it("'false' disarms and says it was an explicit decision", () => {
        process.env.RAIN_AUTOLOG_ENABLED = 'false';
        expect(rainAutologState()).toEqual({ enabled: false, config: 'explicit_off' });
        expect(resolveRainRun({}, { etHour: 2 })).toMatchObject({ log: false, reason: 'flag_off', flag: 'explicit_off' });
      });

      it('THE MISSING-KEY CASE: still arms — and is NOT reported as a decision', () => {
        // Fail direction is OPEN, deliberately and at zero behaviour cost: the key is absent on the
        // live Lambda today and this writer authors the latest water event for 217 of 239 live
        // plantings, so failing closed here would silently stop ~217 rows/day the moment it shipped.
        // What changes is that the absence now has a NAME.
        delete process.env.RAIN_AUTOLOG_ENABLED;
        expect(rainAutologState()).toEqual({ enabled: true, config: 'default_key_absent' });
        expect(resolveRainRun({}, { etHour: 2 })).toMatchObject({ log: true, flag: 'default_key_absent' });
      });

      it('an unset key and an explicit ON are NOT the same report — the whole point', () => {
        // Non-vacuity: if these two collapsed to one token the distinction would be decorative and
        // recon would be no better off than it was with `!== 'false'`.
        delete process.env.RAIN_AUTOLOG_ENABLED;
        const absent = rainAutologState();
        process.env.RAIN_AUTOLOG_ENABLED = 'true';
        const explicit = rainAutologState();
        expect(absent.enabled).toBe(explicit.enabled);
        expect(absent.config).not.toBe(explicit.config);
      });

      it('a typo is armed AND flagged as unrecognised, never folded into the on-branch', () => {
        for (const v of ['0', 'no', '', 'FALSE', 'off', 'ture']) {
          process.env.RAIN_AUTOLOG_ENABLED = v;
          expect(rainAutologState(), `value ${JSON.stringify(v)}`)
            .toEqual({ enabled: true, config: 'default_unrecognised' });
        }
      });

      it('every resolveRainRun exit carries the flag, not just the disabled one', () => {
        // "the logger ran" and "the logger ran because nobody set the key" have to be separable from
        // the outside, which means the tag must ride the paths that SUCCEED too, not only the veto.
        delete process.env.RAIN_AUTOLOG_ENABLED;
        for (const [event, opts] of [[{}, { etHour: 2 }], [{}, { etHour: 15 }], [{}, {}],
          [{ rainLog: true }, { etHour: 15 }], [{ rainLog: false }, { etHour: 2 }]]) {
          expect(resolveRainRun(event, opts).flag).toBe('default_key_absent');
        }
        process.env.RAIN_AUTOLOG_ENABLED = 'false';
        expect(resolveRainRun({}, { etHour: 2 }).flag).toBe('explicit_off');
      });
    });
  });
});

describe('rainDecision — threshold and the gauge-only rule', () => {
  it('logs the eight real rain days at their measured amounts', () => {
    for (const inches of [0.65, 0.80, 2.84, 0.54, 0.64, 2.22, 0.21, 0.34]) {
      expect(rainDecision(gauge(inches))).toEqual({ log: true, amountIn: inches, reason: 'above_threshold' });
    }
  });

  it('does NOT log 2026-07-22, which measured EXACTLY 0.10 — "above" is strict', () => {
    expect(rainDecision(gauge(0.10))).toMatchObject({ log: false, reason: 'below_threshold' });
  });

  it('does not log the near-misses that really occurred (0.09, 0.04, 0.02, 0.01)', () => {
    for (const inches of [0.09, 0.04, 0.02, 0.01]) {
      expect(rainDecision(gauge(inches)).log).toBe(false);
    }
  });

  it('logs 0.11 — the smallest amount that clears the bar, so the comparison is pinned from both sides', () => {
    expect(rainDecision(gauge(0.11)).log).toBe(true);
  });

  it('REFUSES a model-sourced day even well above threshold — 2026-08-01 is the live case', () => {
    // The model said 0.12" for a day the station has no record of. Under a naive threshold-only
    // rule this would have produced 212 event rows asserting rain that no instrument measured.
    const d = rainDecision(model(0.12));
    expect(d.log).toBe(false);
    expect(d.reason).toBe('not_gauge_sourced:openmeteo_archive');
  });

  it('REFUSES the model even when it is dramatically wrong in the other direction', () => {
    // 2026-08-03: model 1.00", gauge 2.22". Logging the model figure would understate by half.
    expect(rainDecision(model(1.00)).log).toBe(false);
    expect(rainDecision(model(0.5, 'openmeteo_live')).reason).toBe('not_gauge_sourced:openmeteo_live');
  });

  it('distinguishes "no rain" from "no station" — the reasons are not interchangeable', () => {
    expect(rainDecision(null).reason).toBe('no_weather_row');
    expect(rainDecision({ precip_in: 1.5, precip_source: null }).reason).toBe('no_precip_source');
    expect(rainDecision(gauge(null)).reason).toBe('no_precip_value');
    expect(rainDecision(gauge(0)).reason).toBe('below_threshold');
  });

  it('a null precip on a gauge row is NOT treated as zero', () => {
    // Silently reading null as 0 would assert a dry day whenever the station dropped a reading.
    expect(rainDecision(gauge(null))).toMatchObject({ log: false, amountIn: null });
  });
});

describe('previousDay — the day being logged', () => {
  it('returns the previous ET day', () => {
    expect(previousDay('2026-08-28')).toBe('2026-08-27');
  });

  it('crosses month and year boundaries', () => {
    expect(previousDay('2026-08-01')).toBe('2026-07-31');
    expect(previousDay('2026-01-01')).toBe('2025-12-31');
    expect(previousDay('2026-03-01')).toBe('2026-02-28');
  });

  it('is stable across both DST transitions — the noon anchor is the reason', () => {
    // US DST 2026: forward Mar 8, back Nov 1. A midnight-anchored implementation returns the SAME
    // day for one of these.
    expect(previousDay('2026-03-08')).toBe('2026-03-07');
    expect(previousDay('2026-03-09')).toBe('2026-03-08');
    expect(previousDay('2026-11-01')).toBe('2026-10-31');
    expect(previousDay('2026-11-02')).toBe('2026-11-01');
  });

  it('rejects malformed input rather than inventing a date', () => {
    for (const bad of [null, undefined, '', '2026-8-1', 'yesterday', 20260828]) {
      expect(previousDay(bad)).toBeNull();
    }
  });
});

describe('rainMetadata', () => {
  it('marks an auto-logged row and carries the measurement', () => {
    const m = rainMetadata(0.34);
    expect(m).toMatchObject({ gauge_in: 0.34, precip_source: 'awn_gauge', auto_logged: true });
    expect(m.backfilled).toBeUndefined();
  });

  it('shares the migration tag but stays distinguishable from it', () => {
    expect(rainMetadata(0.34).rain_backfill).toBe(rainMetadata(0.34, { backfilled: true }).rain_backfill);
    expect(rainMetadata(0.34, { backfilled: true })).toMatchObject({ backfilled: true });
    expect(rainMetadata(0.34, { backfilled: true }).auto_logged).toBeUndefined();
  });
});
