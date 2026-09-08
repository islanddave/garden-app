// V5-RADIATIVEFROST-001 — the pure module.
//
// The failure this file is most concerned with is NOT a wrong number, it is a MANUFACTURED POSITIVE.
// The trip condition is "clear and calm", i.e. cloud and wind at or near ZERO. So the usual
// null-must-not-become-0 rule of this codebase is not a hygiene point here — coercing an absent
// reading to 0 would synthesise the exact condition the module exists to detect, and it would do it
// on the nights when data is missing, which is precisely when nobody is checking.
import { describe, it, expect } from 'vitest';
import rf from './radiativeFrost.js';

const { nightsFrom, nightFor, radiativeTrips, nightKeyFor, prevDate, MIN_HOURS } = rf;

// One full 18:00->08:00 window = 15 hours. Values are constant unless `over` names an hour.
const NIGHT_HOURS = [18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7, 8];
function nightRows(date, nextDate, { dew = 30, cloud = 5, wind = 2 } = {}, hours = NIGHT_HOURS) {
  return hours.map((h) => {
    const d = h >= 18 ? date : nextDate;
    return [`${d}T${String(h).padStart(2, '0')}:00`, dew, cloud, wind];
  });
}
const block = (rows) => ({
  time: rows.map((r) => r[0]),
  dew_point_2m: rows.map((r) => r[1]),
  cloud_cover: rows.map((r) => r[2]),
  wind_speed_10m: rows.map((r) => r[3]),
});

describe('nightKeyFor / prevDate — the day-boundary arithmetic', () => {
  it('labels a night by the date it STARTS on, so evening and small hours agree', () => {
    expect(nightKeyFor('2026-10-09T22:00')).toBe('2026-10-09');
    expect(nightKeyFor('2026-10-10T03:00')).toBe('2026-10-09');   // same night
    expect(nightKeyFor('2026-10-09T18:00')).toBe('2026-10-09');
    expect(nightKeyFor('2026-10-10T08:00')).toBe('2026-10-09');
  });

  it('drops daytime hours — they belong to no night', () => {
    for (const h of ['09', '12', '15', '17']) {
      expect(nightKeyFor(`2026-10-09T${h}:00`)).toBeNull();
    }
  });

  it('crosses month, year and leap-day boundaries without a Date object', () => {
    expect(prevDate('2026-10-01')).toBe('2026-09-30');
    expect(prevDate('2026-01-01')).toBe('2025-12-31');
    expect(prevDate('2026-03-01')).toBe('2026-02-28');
    expect(prevDate('2024-03-01')).toBe('2024-02-29');   // leap
    expect(nightKeyFor('2026-01-01T02:00')).toBe('2025-12-31');
  });

  it('refuses a malformed stamp rather than guessing', () => {
    for (const bad of [null, undefined, 42, '', '2026-10-09', '2026-10-09Txx:00']) {
      expect(nightKeyFor(bad)).toBeNull();
    }
  });
});

describe('nightsFrom — bucketing and the absence rule', () => {
  it('collapses one 18:00->08:00 window into a single night keyed on the start date', () => {
    const n = nightsFrom(block(nightRows('2026-10-09', '2026-10-10')));
    expect(n).toHaveLength(1);
    expect(n[0].date).toBe('2026-10-09');
    expect(n[0].hours).toBe(15);
  });

  it('derives minimum dewpoint and MEAN cloud/wind, and flags a clear calm night radiative', () => {
    const rows = nightRows('2026-10-09', '2026-10-10', { dew: 33, cloud: 4, wind: 2 });
    rows[6][1] = 28;                                   // one colder dewpoint hour
    const n = nightsFrom(block(rows))[0];
    expect(n.minDewpointF).toBe(28);                   // MIN, not mean
    expect(n.meanCloudPct).toBe(4);
    expect(n.meanWindMph).toBe(2);
    expect(n.radiative).toBe(true);
  });

  it('is NOT radiative when it is cloudy, or windy, or both', () => {
    const at = (o) => nightsFrom(block(nightRows('2026-10-09', '2026-10-10', o)))[0].radiative;
    expect(at({ cloud: 90, wind: 2 })).toBe(false);
    expect(at({ cloud: 5, wind: 14 })).toBe(false);
    expect(at({ cloud: 90, wind: 14 })).toBe(false);
    expect(at({ cloud: 5, wind: 2 })).toBe(true);
  });

  it('THE MANUFACTURED-POSITIVE GUARD: absent cloud/wind must never read as 0', () => {
    // If a null were coerced to 0 this night would come back radiative — 0% cloud, 0 mph wind — which
    // is the strongest possible positive, invented entirely out of missing data.
    const rows = nightRows('2026-10-09', '2026-10-10', { dew: 30, cloud: 80, wind: 20 });
    for (const r of rows) { r[2] = null; r[3] = null; }
    const n = nightsFrom(block(rows));
    expect(n).toHaveLength(0);                          // no night at all, so no signal
    expect(nightFor(n, '2026-10-09')).toBeNull();
    expect(radiativeTrips(nightFor(n, '2026-10-09'), 39, 38)).toBe(false);
  });

  it('skips only the hours that are incomplete, keeping a night that still has enough', () => {
    const rows = nightRows('2026-10-09', '2026-10-10');
    rows[0][2] = null; rows[1][3] = null;               // two hours unusable
    const n = nightsFrom(block(rows))[0];
    expect(n.hours).toBe(13);
    expect(n.radiative).toBe(true);
  });

  it(`drops a night below MIN_HOURS (${MIN_HOURS}) rather than judging it on a fragment`, () => {
    const short = nightRows('2026-10-09', '2026-10-10', {}, [18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4]);
    expect(short).toHaveLength(11);
    expect(nightsFrom(block(short))).toHaveLength(0);
  });

  it('returns [] — never throws — on an absent or partial hourly block', () => {
    expect(nightsFrom(null)).toEqual([]);
    expect(nightsFrom({})).toEqual([]);
    expect(nightsFrom({ time: ['2026-10-09T18:00'] })).toEqual([]);          // no value arrays
    const rows = nightRows('2026-10-09', '2026-10-10');
    const b = block(rows); delete b.cloud_cover;
    expect(nightsFrom(b)).toEqual([]);                                       // one array missing
  });

  it('separates consecutive nights and returns them in date order', () => {
    const rows = [...nightRows('2026-10-09', '2026-10-10', { cloud: 3 }),
      ...nightRows('2026-10-10', '2026-10-11', { cloud: 95 })];
    const n = nightsFrom(block(rows));
    expect(n.map((x) => x.date)).toEqual(['2026-10-09', '2026-10-10']);
    expect(n[0].radiative).toBe(true);
    expect(n[1].radiative).toBe(false);
  });

  it('survives the fall-back DST night, which has a repeated local hour', () => {
    // 2026-11-01 -> 02: America/New_York repeats 01:00. String bucketing takes both; a Date-based
    // implementation is where this goes wrong, which is why there is no Date in the module.
    const rows = nightRows('2026-11-01', '2026-11-02');
    rows.splice(8, 0, ['2026-11-02T01:00', 30, 5, 2]);   // the second 01:00
    const n = nightsFrom(block(rows));
    expect(n).toHaveLength(1);
    expect(n[0].date).toBe('2026-11-01');
    expect(n[0].hours).toBe(16);
    expect(n[0].radiative).toBe(true);
  });
});

describe('radiativeTrips — three conditions, all required', () => {
  const rad = { date: '2026-10-09', minDewpointF: 33, meanCloudPct: 5, meanWindMph: 2, radiative: true };

  it('trips when clear+calm, dewpoint at/below the trip point, and the low is within proximity', () => {
    expect(radiativeTrips(rad, 39, 38)).toBe(true);      // low 39, trip 38, prox 4 -> 39 <= 42
  });

  it('does NOT trip when the night is not radiative', () => {
    expect(radiativeTrips({ ...rad, radiative: false }, 39, 38)).toBe(false);
  });

  it('does NOT trip when the dewpoint floor is above the trip point', () => {
    // The floor is what makes reaching the trip point physically possible at all.
    expect(radiativeTrips({ ...rad, minDewpointF: 44 }, 39, 38)).toBe(false);
  });

  it('THE PROXIMITY TERM: does not trip when the forecast is far above the trip point', () => {
    // This is the condition that killed the measured false alarms — a 47.3F night with a low
    // dewpoint is dry air, not frost risk. Without this term the call below returns true.
    expect(radiativeTrips(rad, 47, 38)).toBe(false);     // 47 > 38 + 4
    expect(radiativeTrips(rad, 42, 38)).toBe(true);      // 42 == 38 + 4, inclusive
    expect(radiativeTrips(rad, 43, 38)).toBe(false);
  });

  it('honours an explicit proximity override', () => {
    expect(radiativeTrips(rad, 47, 38, { proximityF: 10 })).toBe(true);
    expect(radiativeTrips(rad, 47, 38, { proximityF: 1 })).toBe(false);
  });

  it('returns false — never throws — on any missing input', () => {
    expect(radiativeTrips(null, 39, 38)).toBe(false);
    expect(radiativeTrips(undefined, 39, 38)).toBe(false);
    expect(radiativeTrips(rad, null, 38)).toBe(false);
    expect(radiativeTrips(rad, 39, null)).toBe(false);
    expect(radiativeTrips({ ...rad, minDewpointF: null }, 39, 38)).toBe(false);
  });

  it('nightFor finds by date and returns null (not undefined) for a miss', () => {
    const nights = [rad];
    expect(nightFor(nights, '2026-10-09')).toBe(rad);
    expect(nightFor(nights, '2026-10-10')).toBeNull();
    expect(nightFor(null, '2026-10-09')).toBeNull();
  });
});
