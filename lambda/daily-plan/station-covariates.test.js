// V5-WXSTATIONCOVARIATES-001 — the CALM/CLEAR covariates.
//
// WHY THIS FILE EXISTS SEPARATELY from station-overnight.test.js. That file guards the night's
// minimum. This one guards the covariates WITHOUT which the minimum cannot answer anything: a
// crucible (2026-09-14) established that "does the forecast run warm on calm, clear frost nights"
// is unanswerable unless each night records whether it WAS calm — and that this loop had been
// reading two fields per record and dropping wind, dewpoint and duration on the floor. AWN serves a
// ~3-day rolling window, so those are gone for every night that ages out.
//
// The assertions below are written against the two failure modes that actually threaten this data,
// both of which pass a naive suite:
//   (1) a wrong field name, which yields null forever and reads as "no such sensor";
//   (2) absence coerced to zero, which INVENTS the calm night the covariate exists to detect.
import { describe, it, expect } from 'vitest';
import st from './station.js';

const { overnightMins } = st;
const TZ = 'America/New_York';

// 5-minute records across a local night. `extra(h, m)` returns whatever non-temp fields the record
// should carry, so a test can model a partial-coverage anemometer or a missing dewpoint sensor.
function night(dateISO, { tempAt = () => 45, extra = () => ({}), stepMin = 5 } = {}) {
  const recs = [];
  const base = Date.parse(`${dateISO}T00:00:00-04:00`);
  const push = (h, m, off) => recs.push({
    dateutc: base + ((off + h) * 60 + m) * 60000, tempf: tempAt(h), ...extra(h, m),
  });
  for (let h = 18; h < 24; h++) for (let m = 0; m < 60; m += stepMin) push(h, m, 0);
  for (let h = 0; h <= 8; h++) for (let m = 0; m < 60; m += stepMin) push(h, m, 24);
  return recs;
}

describe('overnightMins covariates — what makes a night "calm and clear" knowable later', () => {
  it('records wind min/mean/max from windspeedmph', () => {
    // MUTATION GUARDED: swapping windMinMph/windMaxMph, or summing instead of averaging.
    const out = overnightMins(night('2026-10-09', { extra: (h) => ({ windspeedmph: h === 4 ? 0 : 6 }) }), TZ);
    const b = out['2026-10-09'];
    expect(b.windMinMph).toBe(0);
    expect(b.windMaxMph).toBe(6);
    expect(b.windMeanMph).toBeGreaterThan(5);
    expect(b.windMeanMph).toBeLessThan(6);
  });

  it('reads dewPoint in camelCase — the one field AWN does not spell in lowercase', () => {
    // MUTATION GUARDED: "normalizing" r.dewPoint to r.dewpoint / r.dewpointf. That reads as null for
    // every record, which a Number.isFinite guard turns into "this station has no dewpoint sensor" —
    // silent, permanent, and indistinguishable from the truth. Verified against a live AWN record
    // 2026-09-14: windspeedmph/windgustmph/winddir/humidity/solarradiation are lowercase; dewPoint
    // alone is camelCase. This test is the only thing standing between that trap and the corpus.
    const out = overnightMins(night('2026-10-09', { extra: (h) => ({ dewPoint: h === 4 ? 31.2 : 40 }) }), TZ);
    expect(out['2026-10-09'].dewPointMinF).toBe(31.2);
    expect(out['2026-10-09'].dewSamples).toBeGreaterThan(150);
  });

  it('treats a MISSING wind reading as absent, never as zero', () => {
    // The sharpest correctness point in this feature. 0 mph is a real, meteorologically loaded value:
    // dead calm IS the radiative case. If a missing field were coerced to 0 the corpus would invent
    // calm nights wholesale — manufacturing precisely the signal it exists to measure, in the
    // direction that would make a bias correction look justified when it is not.
    const out = overnightMins(night('2026-10-09', { extra: (h) => (h >= 2 && h <= 5 ? {} : { windspeedmph: 8 }) }), TZ);
    const b = out['2026-10-09'];
    expect(b.windMinMph).toBe(8);            // not 0 — the absent hours contributed nothing
    expect(b.windMeanMph).toBe(8);
    expect(b.windCoverage).toBeLessThan(1);  // and the gap is REPORTED, not hidden
    expect(b.windCoverage).toBeGreaterThan(0);
  });

  it('counts samples below each frost threshold, as counts rather than minutes', () => {
    // MUTATION GUARDED: an off-by-one from <= vs <, and any threshold silently dropped. Counts (not
    // minutes) because the 5-minute interval is AWN's choice; baking it in would misreport every
    // night if they change it.
    const temps = { 18: 45, 19: 45, 20: 45, 21: 45, 22: 45, 23: 39, 0: 37, 1: 34, 2: 32, 3: 31, 4: 31, 5: 34, 6: 37, 7: 41, 8: 45 };
    const b = overnightMins(night('2026-10-09', { tempAt: (h) => temps[h] }), TZ)['2026-10-09'];
    expect(b.samplesBelow[40]).toBeGreaterThan(b.samplesBelow[38]);
    expect(b.samplesBelow[38]).toBeGreaterThan(b.samplesBelow[33]);
    expect(b.samplesBelow[32]).toBe(24);     // 31F for exactly two hours = 24 five-minute records
    expect(b.samplesBelow[33]).toBe(36);     // 32F and 31F = three hours
  });

  it('keeps per-hour min AND the reading at the hour mark, so a later alignment is still free', () => {
    // A comparison against an hourly forecast can mean "coldest within the hour" or "the value at the
    // mark". Picking one now is irreversible once the 5-minute records age out, so store both.
    // MUTATION GUARDED: collapsing these to one value, or letting `at` drift to the hour's LAST
    // record. Hour 4 falls steadily across the hour — 40.0 at :00 down to 34.5 at :55 — so the
    // hour-mark reading and the hour's minimum are different numbers, and a drift to the last record
    // would read 34.5 where 40 is correct. An earlier version of this test held hour 4 flat, which
    // made both conventions agree and let that mutation survive; the mutation harness caught it.
    const b = overnightMins(night('2026-10-09', {
      tempAt: () => 45,
      extra: (h, m) => (h === 4 ? { tempf: 40 - m / 10 } : {}),
    }), TZ)['2026-10-09'];
    expect(b.hourly['4'].min).toBe(34.5);    // the coldest reading inside the hour, at :55
    expect(b.hourly['4'].at).toBe(40);       // the reading AT the hour mark, at :00
    expect(b.hourly['4'].atOff).toBeUndefined();   // accumulator stripped, not published
  });

  it('a night with NO covariate fields keeps its minimum and says so', () => {
    // Degradation, not loss. The temperature is the non-negotiable column; covariates are a bonus that
    // must never take the night down with them.
    const b = overnightMins(night('2026-10-09'), TZ)['2026-10-09'];
    expect(b.minF).toBe(45);
    expect(b.covariatesAvailable).toBe(true);
    expect(b.windSamples).toBe(0);
    expect(b.windMeanMph).toBe(null);        // null, NOT 0
    expect(b.dewPointMinF).toBe(null);
  });

  it('does not disturb the existing minimum/samples/endHour contract', () => {
    // The corpus's truth column predates this change and other code keys off it.
    const temps = { 18: 52, 19: 50, 20: 48, 21: 46, 22: 44, 23: 43, 0: 42, 1: 41, 2: 40, 3: 38, 4: 34, 5: 36, 6: 38, 7: 41, 8: 45 };
    const b = overnightMins(night('2026-10-09', { tempAt: (h) => temps[h] }), TZ)['2026-10-09'];
    expect(b.minF).toBe(34);
    expect(b.endHour).toBe(8);
    expect(b.samples).toBeGreaterThan(150);
  });

  it('a throwing record costs the covariates, NEVER the night or the plan', () => {
    // The load-bearing safety property, and the reason the try/catch exists. `deriveStation` is called
    // bare in handler.js — unlike the explicitly-guarded `fetchStation` beside it — and index.js's
    // outer catch re-throws. So an uncaught throw anywhere in this function ends the invocation: no
    // daily_plan row for ANY Space, and no frost alert fires. A getter that throws models any future
    // defect in covariate arithmetic.
    const recs = night('2026-10-09');
    Object.defineProperty(recs[40], 'windspeedmph', { get() { throw new Error('boom'); } });
    const out = overnightMins(recs, TZ);
    expect(out['2026-10-09'].minF).toBe(45);          // the night survived
    expect(out['2026-10-09'].covariateError).toBe(true);  // and the damage is declared
  });
});
