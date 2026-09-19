// BUG-FROSTADVISORYNIGHTWORDING-001 — which NIGHT a frost advisory names.
//
// THE DEFECT. evalAdvisory picks the coldest CIVIL DAY of D1..D3 (Open-Meteo daily temperature_2m_min) and
// the copy named the night from its dayOffset: D1 -> "tomorrow night". But a civil day's minimum usually falls
// before dawn, at the END of the night that started the evening before (78% of <= 40F days at this site, ERA5
// 2021-2025), so D1's minimum is usually TONIGHT's and most advisories named their night one day late.
//
// THE FIX, pinned here: frostEval.locateNight reads the hour of the picked day's minimum out of the hourly
// series index.js now carries (hourly_temp) — before noon -> the night that ended that morning, noon or later
// -> the night that starts that evening — and falls back to the base rate (the morning night) whenever the
// series cannot vouch for the printed figure. The handler persists `nightOffset` so the Today line
// (src/lib/frostAlertLine.js) words the same night the SNS text did.
//
// INSTRUMENTS. The pure half calls the exported functions. The end-to-end half compiles the REAL fetchPrecip
// out of index.js (it cannot be imported: AWS SDK + neon at load — the openmeteo-indices.test.js method),
// hands it an Open-Meteo-shaped body through a stubbed fetch, drives the real handler.run(), captures the SNS
// publish and the written row, and words the row's alerts_sent with the real client builder. Run under
// TZ=UTC and TZ=America/New_York: the weekday names must not move with the process zone.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import fe from './frostEval.js';
import h from './handler.js';
import _cf from './_coverFlags.js';
import { buildFrostAlertLine, resolveNight, nightPhrase as clientNightPhrase } from '../../src/lib/frostAlertLine.js';

const { frostEval, locateNight, advisoryNight, nightPhrase, weekdayOf } = fe;
const { run, frostWeatherFacts } = h;
const { withCoverFlags } = _cf;

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8');

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
// 24 hourly stamps for a date, in Open-Meteo's local ISO form.
const stamps = (date) => Array.from({ length: 24 }, (_, i) => `${date}T${pad(i)}:00`);
// A day whose single coldest hour is `hour` at `low`; every other hour is warmer. Mirrors the real shape:
// the daily figure is the minimum of the day's hours.
const dayCurve = (low, hour) => Array.from({ length: 24 }, (_, i) => (i === hour ? low : low + 4 + Math.abs(i - hour) * 0.5));
const hourlyFor = (days) => ({
  time: days.flatMap(([date]) => stamps(date)),
  temperature_2m: days.flatMap(([, temps]) => temps),
  timezone: 'America/New_York',
});
const rec = (dayOffset, date, minLowF) => ({ dayOffset, date, minLowF });

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// ── the locator ─────────────────────────────────────────────────────────────────────────────────────
describe('locateNight — the hour of the minimum decides the night', () => {
  // Plan date 2026-09-20 (a Sunday). D1 = Mon 09-21, D2 = Tue 09-22, D3 = Wed 09-23.
  const at = (dayOffset, date, hour, low = 37) => locateNight(rec(dayOffset, date, low), hourlyFor([[date, dayCurve(low, hour)]]));

  it('D1 minimum at 05:00 is TONIGHT — the night that ends on D1\'s morning', () => {
    expect(at(1, '2026-09-21', 5)).toEqual({ nightOffset: 0, nightDate: '2026-09-20', nightBasis: 'hourly', minHour: 5 });
  });

  it('D1 minimum at 23:00 is TOMORROW NIGHT — the night that starts on D1\'s evening', () => {
    expect(at(1, '2026-09-21', 23)).toEqual({ nightOffset: 1, nightDate: '2026-09-21', nightBasis: 'hourly', minHour: 23 });
  });

  it('D2 and D3 shift the same way, one night per civil day', () => {
    expect(at(2, '2026-09-22', 6)).toMatchObject({ nightOffset: 1, nightDate: '2026-09-21' });
    expect(at(2, '2026-09-22', 22)).toMatchObject({ nightOffset: 2, nightDate: '2026-09-22' });
    expect(at(3, '2026-09-23', 7)).toMatchObject({ nightOffset: 2, nightDate: '2026-09-22' });
    expect(at(3, '2026-09-23', 23)).toMatchObject({ nightOffset: 3, nightDate: '2026-09-23' });
  });

  it('the split is at noon: 11:00 is the morning night, 12:00 the evening one', () => {
    expect(at(1, '2026-09-21', 11).nightOffset).toBe(0);
    expect(at(1, '2026-09-21', 12).nightOffset).toBe(1);
    expect(at(1, '2026-09-21', 0).nightOffset).toBe(0);    // midnight belongs to the night in progress
  });

  it('a tie goes to the EARLIEST hour — the safe direction for frost', () => {
    const temps = dayCurve(37, 6);
    temps[22] = 37;                                          // the same minimum again at 22:00
    const r = locateNight(rec(1, '2026-09-21', 37), hourlyFor([['2026-09-21', temps]]));
    expect(r).toMatchObject({ nightOffset: 0, minHour: 6 });
  });

  it('only the picked date\'s hours count — a colder neighbouring day is not this day\'s minimum', () => {
    const hourly = hourlyFor([['2026-09-21', dayCurve(37, 23)], ['2026-09-22', dayCurve(30, 5)]]);
    expect(locateNight(rec(1, '2026-09-21', 37), hourly)).toMatchObject({ nightOffset: 1, nightBasis: 'hourly', minHour: 23 });
  });
});

describe('locateNight — when the series cannot vouch for the figure, the base rate (errs a night EARLY)', () => {
  const evening = hourlyFor([['2026-09-21', dayCurve(37, 23)]]);
  const BASE = { nightOffset: 0, nightDate: '2026-09-20', nightBasis: 'base_rate' };

  it('no hourly block at all', () => {
    expect(locateNight(rec(1, '2026-09-21', 37), null)).toEqual(BASE);
    expect(locateNight(rec(1, '2026-09-21', 37), undefined)).toEqual(BASE);
    // NEAR-MISS CONTROL: the same record with the series present is located, and to a DIFFERENT night.
    expect(locateNight(rec(1, '2026-09-21', 37), evening)).toMatchObject({ nightOffset: 1, nightBasis: 'hourly' });
  });

  it('a block with no temperature array (an Open-Meteo that dropped the field)', () => {
    expect(locateNight(rec(1, '2026-09-21', 37), { time: evening.time })).toEqual(BASE);
  });

  it('MISALIGNED: no hour of that date holds the printed minimum', () => {
    // The daily figure says 35, the hours say 37 at 23:00. The hour cannot be trusted to be the hour of
    // the minimum the message prints, so it is not used.
    expect(locateNight(rec(1, '2026-09-21', 35), evening)).toEqual(BASE);
    expect(locateNight(rec(1, '2026-09-21', 37), evening).nightBasis).toBe('hourly');   // control
  });

  it('no hours for the picked date (a series that starts or ends early)', () => {
    const other = hourlyFor([['2026-09-22', dayCurve(37, 23)]]);
    expect(locateNight(rec(1, '2026-09-21', 37), other)).toEqual(BASE);
  });

  it('time and temperature arrays of different lengths cannot be paired', () => {
    expect(locateNight(rec(1, '2026-09-21', 37), { time: evening.time, temperature_2m: evening.temperature_2m.slice(1) })).toEqual(BASE);
  });

  it('a stamp with no hour is skipped, never read as midnight (Number("") is 0)', () => {
    const bad = { time: ['2026-09-21'], temperature_2m: [37] };
    expect(locateNight(rec(1, '2026-09-21', 37), bad)).toEqual(BASE);
    const good = { time: ['2026-09-21', '2026-09-21T23:00'], temperature_2m: [37, 37] };
    expect(locateNight(rec(1, '2026-09-21', 37), good)).toMatchObject({ nightOffset: 1, minHour: 23 });
  });

  it('null hours are skipped, never read as 0F', () => {
    const temps = dayCurve(37, 23).map((v, i) => (i < 6 ? null : v));
    expect(locateNight(rec(1, '2026-09-21', 37), hourlyFor([['2026-09-21', temps]]))).toMatchObject({ nightOffset: 1, minHour: 23 });
  });

  it('no pick at all -> no night, never a default', () => {
    expect(locateNight({ fires: false, minLowF: null }, evening)).toEqual({ nightOffset: null, nightDate: null, nightBasis: null });
  });
});

describe('DST — string arithmetic on the stamps, so 23- and 25-hour days locate the same way', () => {
  it('fall-back 2026-11-01 as Open-Meteo really serves it (ONE fixed offset, 24 stamps)', () => {
    // Measured 2026-09-18: a response spanning the change keeps utc_offset_seconds -14400 throughout.
    const r = locateNight(rec(2, '2026-11-02', 30), hourlyFor([['2026-11-01', dayCurve(33, 6)], ['2026-11-02', dayCurve(30, 23)]]));
    expect(r).toMatchObject({ nightOffset: 2, nightDate: '2026-11-02', nightBasis: 'hourly' });
    expect(nightPhrase(r)).toBe('Monday night');
  });

  it('a true-local 25-stamp fall-back day (01:00 twice) still finds its minimum', () => {
    const time = ['00', '01', '01', ...Array.from({ length: 22 }, (_, i) => pad(i + 2))].map((hh) => `2026-11-01T${hh}:00`);
    const temps = time.map((_, i) => (i === 2 ? 31 : 36));          // the SECOND 01:00 is the coldest
    const r = locateNight(rec(1, '2026-11-01', 31), { time, temperature_2m: temps });
    expect(r).toMatchObject({ nightOffset: 0, nightDate: '2026-10-31', minHour: 1 });
    expect(nightPhrase(r)).toBe('tonight');
  });

  it('a true-local 23-stamp spring-forward day (no 02:00) still finds its minimum', () => {
    const time = ['00', '01', ...Array.from({ length: 21 }, (_, i) => pad(i + 3))].map((hh) => `2027-03-14T${hh}:00`);
    expect(time).toHaveLength(23);
    const lateMin = time.map((t) => (t.endsWith('T23:00') ? 28 : 33));
    const earlyMin = time.map((t) => (t.endsWith('T03:00') ? 28 : 33));
    // Plan date 2027-03-12 (Fri): D2 = Sun 03-14.
    expect(nightPhrase(locateNight(rec(2, '2027-03-14', 28), { time, temperature_2m: lateMin }))).toBe('Sunday night');
    expect(nightPhrase(locateNight(rec(2, '2027-03-14', 28), { time, temperature_2m: earlyMin }))).toBe('tomorrow night');
  });
});

describe('nightPhrase + weekdayOf — the words', () => {
  it('0 tonight, 1 tomorrow night, 2+ the weekday the night STARTS on', () => {
    expect(nightPhrase({ nightOffset: 0, nightDate: '2026-09-20' })).toBe('tonight');
    expect(nightPhrase({ nightOffset: 1, nightDate: '2026-09-21' })).toBe('tomorrow night');
    expect(nightPhrase({ nightOffset: 2, nightDate: '2026-09-22' })).toBe('Tuesday night');
    expect(nightPhrase({ nightOffset: 3, nightDate: '2026-09-23' })).toBe('Wednesday night');
  });

  it('the weekday is read from the label, not from the process zone (run under TZ=America/New_York too)', () => {
    // A local-zone read of the UTC anchor is the PREVIOUS day anywhere west of UTC: under New York these
    // would read Saturday / Sunday / Thursday.
    expect(weekdayOf('2026-11-01')).toBe('Sunday');
    expect(weekdayOf('2026-11-02')).toBe('Monday');
    expect(weekdayOf('2027-01-01')).toBe('Friday');
    expect(weekdayOf('2026-02-30')).toBeNull();
    expect(weekdayOf('Sunday')).toBeNull();
  });

  it('a 2+ night with no date says how far, rather than naming a wrong day', () => {
    expect(nightPhrase({ nightOffset: 2, nightDate: null })).toBe('in 2 days');
  });

  it('an unusable offset words nothing', () => {
    expect(nightPhrase({ nightOffset: -1, nightDate: '2026-09-20' })).toBeNull();
    expect(nightPhrase({ nightOffset: null })).toBeNull();
    expect(nightPhrase(null)).toBeNull();
  });

  it('advisoryNight — a record without a night takes the base rate, one that carries one keeps it', () => {
    expect(advisoryNight({ dayOffset: 3, date: '2026-09-23' })).toEqual({ nightOffset: 2, nightDate: '2026-09-22' });
    expect(advisoryNight({ dayOffset: 3, date: '2026-09-23', nightOffset: 3, nightDate: '2026-09-23' }))
      .toEqual({ nightOffset: 3, nightDate: '2026-09-23' });
  });
});

// ── frostEval: the message ──────────────────────────────────────────────────────────────────────────
describe('frostEval — the advisory message names the located night; nothing else moves', () => {
  const dates = ['2026-09-21', '2026-09-22', '2026-09-23'];
  const exposure = { tender: 10, unknown: 0, tenderContainers: 2 };
  const hourly = (d1Hour, d2Hour = 12, d3Hour = 12) => hourlyFor([
    ['2026-09-21', dayCurve(37, d1Hour)], ['2026-09-22', dayCurve(50, d2Hour)], ['2026-09-23', dayCurve(52, d3Hour)],
  ]);
  const ev = (forecastHourly, over = {}) => frostEval({
    tonightLow: 55, forecastLows: [37, 50, 52], forecastDates: dates, exposure, forecastHourly, spaceId: 'S', eventDate: '2026-09-20', ...over,
  });

  it('D1 minimum before dawn -> "frost possible tonight", date suffix unchanged', () => {
    expect(ev(hourly(5)).message).toBe('FROST ADVISORY — frost possible tonight (low 37°F, 2026-09-21). ' +
      '~10 tender plantings, 2 in containers. Harvest ahead and stage row cover.');
  });

  it('D1 minimum late evening -> "frost possible tomorrow night"', () => {
    expect(ev(hourly(23)).message).toMatch(/^FROST ADVISORY — frost possible tomorrow night \(low 37°F, 2026-09-21\)\. /);
  });

  it('no hourly series -> the base rate names tonight', () => {
    const r = ev(null);
    expect(r.message).toMatch(/frost possible tonight \(low 37°F, 2026-09-21\)/);
    expect(r.advisory).toMatchObject({ nightOffset: 0, nightBasis: 'base_rate' });
  });

  it('the TRIGGER is untouched: tier, level, dedup key and fire decision are identical located or not', () => {
    const a = ev(hourly(5)); const b = ev(hourly(23)); const c = ev(null);
    for (const r of [b, c]) {
      expect(r.tier).toBe(a.tier);
      expect(r.level).toBe(a.level);
      expect(r.dedupKey).toBe(a.dedupKey);
      expect(r.alert).toBe(a.alert);
      expect(r.advisory.dayOffset).toBe(a.advisory.dayOffset);
      expect(r.advisory.minLowF).toBe(a.advisory.minLowF);
    }
    // and a mild window stays silent whatever the hours say
    expect(ev(hourly(5), { forecastLows: [45, 50, 52] }).alert).toBe(false);
  });

  it('the imminent tier is untouched: it still speaks about TONIGHT', () => {
    expect(ev(hourly(23), { tonightLow: 36 }).message).toMatch(/^FROST PROTECT TONIGHT — low 36°F\./);
  });

  it('observability records the located night and how it was found', () => {
    expect(ev(hourly(23)).observability).toMatchObject({ forecastMinHour: 23, advisoryNightOffset: 1, advisoryNightBasis: 'hourly' });
    expect(ev(null).observability).toMatchObject({ forecastMinHour: null, advisoryNightOffset: 0, advisoryNightBasis: 'base_rate' });
  });
});

// ── the radiative seams: the Colder-ahead clause and the radiative-only copy ─────────────────────────
describe('frostEval — the two radiative sentences name the right night', () => {
  const T = { ADVISORY_LOW_F: 40, IMMINENT_LOW_F: 38, HARD_FREEZE_LOW_F: 33 };
  const tender = { slug: 'pepper', label: 'peppers', band: 'tender', count: 5, containers: 1, thresholds: T };
  const RAD = { minDewpointF: 33, meanCloudPct: 5, meanWindMph: 2, radiative: true };
  const base = (over) => frostEval({
    highToday: 60, forecastDates: ['2026-10-10', '2026-10-11', '2026-10-12'], lowSource: 'forecast',
    exposure: { tender: 5, unknown: 0, tenderContainers: 1, atRisk: 5, byCropType: [tender] },
    spaceId: 'S1', eventDate: '2026-10-09', ...over,
  }, { frostSeason: true, radiativeEnabled: true });

  it('"Colder ahead" names the advisory\'s LOCATED night, not "tomorrow night" by offset', () => {
    // Imminent fires radiatively on tonight (39 > 38, clear and calm); the advisory's D1 (35F) is colder and
    // its minimum falls at 04:00 — i.e. it is tonight's own minimum, on the other model.
    const args = {
      tonightLow: 39, forecastLows: [35, 50, 51],
      radiativeNights: [{ ...RAD, date: '2026-10-09' }],
      forecastHourly: hourlyFor([['2026-10-10', dayCurve(35, 4)]]),
    };
    const r = base(args);
    expect(r.tier).toBe('imminent');
    expect(r.message).toMatch(/Colder ahead: 35°F tonight, 2026-10-10 — harvest ahead and stage row cover\.$/);
    // CONTROL: the same inputs with the minimum at 22:00 name tomorrow night, so the clause reads the locator.
    const late = base({ ...args, forecastHourly: hourlyFor([['2026-10-10', dayCurve(35, 22)]]) });
    expect(late.message).toMatch(/Colder ahead: 35°F tomorrow night, 2026-10-10/);
  });

  it('the radiative-only advisory judges and names the night the hours put the minimum in', () => {
    // CHANGED by BUG-RADIATIVEPAIRINGNIGHT-001 (lane radiativefix, 2026-09-19). This case used to pin the defect:
    // the civil-day minimum (42F) falls at 23:00 on 10-10, i.e. in the night that STARTS 10-10, yet the trigger
    // judged night 10-09's clear sky and the copy said "tonight looks clear and calm". Now the night judged is
    // the minimum's own, and the copy names it.
    const evening = hourlyFor([['2026-10-10', dayCurve(42, 23)]]);
    const r = base({
      tonightLow: 55, forecastLows: [42, 50, 51],
      radiativeNights: [{ ...RAD, date: '2026-10-10', minDewpointF: 34 }],
      forecastHourly: evening,
    });
    expect(r.tier).toBe('advisory');
    expect(r.message).toMatch(/^FROST ADVISORY — tomorrow night looks clear and calm \(low 42°F, 2026-10-10, dewpoint 34°F\)/);
    expect(r.advisory).toMatchObject({ nightOffset: 1, nightDate: '2026-10-10', nightBasis: 'hourly' });
    expect(frostWeatherFacts(r)).toMatchObject({ nightOffset: 1 });
    // ...and the previous night's clear sky, the old pairing, no longer fires for this evening minimum.
    const wrongNight = base({
      tonightLow: 55, forecastLows: [42, 50, 51],
      radiativeNights: [{ ...RAD, date: '2026-10-09', minDewpointF: 34 }],
      forecastHourly: evening,
    });
    expect(wrongNight.tier).toBeNull();
  });
});

// ── the persisted entry ─────────────────────────────────────────────────────────────────────────────
describe('frostWeatherFacts — nightOffset rides on the alerts_sent entry', () => {
  const decision = (advisory) => ({ tier: 'advisory', level: 'advisory', advisory: { fires: true, minLowF: 37, dayOffset: 1, date: '2026-09-21', ...advisory } });

  it('carries the night the message named, 0 included', () => {
    expect(frostWeatherFacts(decision({ nightOffset: 0 }))).toEqual({ lowF: 37, dayOffset: 1, date: '2026-09-21', nightOffset: 0 });
    expect(frostWeatherFacts(decision({ nightOffset: 1 }))).toEqual({ lowF: 37, dayOffset: 1, date: '2026-09-21', nightOffset: 1 });
  });

  it('omits it rather than writing a non-night', () => {
    for (const nightOffset of [null, undefined, -1, 0.5, '0']) {
      expect(frostWeatherFacts(decision({ nightOffset }))).not.toHaveProperty('nightOffset');
    }
  });

  it('the imminent entry is unchanged', () => {
    expect(frostWeatherFacts({ tier: 'imminent', level: 'protect', imminentGlobal: { lowF: 36 }, advisory: { nightOffset: 0 } }))
      .toEqual({ lowF: 36, dayOffset: 0 });
  });
});

// ── end to end: real fetchPrecip -> real run() -> SNS text + stored entry -> Today line ───────────────
const compiled = (() => {
  const start = SRC.indexOf('async function fetchPrecip');
  if (start < 0) throw new Error('fetchPrecip not found in index.js');
  const tail = SRC.slice(start);
  const end = tail.indexOf('\n}\n');
  if (end < 0) throw new Error('fetchPrecip closing brace not found');
  const body = tail.slice(0, end + 3);
  if (!/hourly_temp:/.test(body) || !/fetchPrecip failed/.test(body)) throw new Error('fetchPrecip extraction truncated');
  const r2 = SRC.match(/^const round2 = .*$/m);
  const r3 = SRC.match(/^const round3 = .*$/m);
  if (!r2 || !r3) throw new Error('round2/round3 not found in index.js');
  return new Function('fetch', 'AbortSignal', 'console', `${r2[0]}\n${r3[0]}\n${body}\nreturn fetchPrecip;`);
})();

// An Open-Meteo forecast body for plan date `today`: six local days D-2..D3, 24 hourly stamps each, the
// daily minimum computed FROM the hours exactly as the real API aggregates it (0 of 380 days differ).
// Overcast and breezy throughout, so the radiative path has nothing to say.
function openMeteoBody(days, { withTemp = true, dailyMinOverride = null } = {}) {
  const time = days.map(([d]) => d);
  const temps = days.flatMap(([, t]) => t);
  const z = (v) => time.map(() => v);
  const tmin = dailyMinOverride || days.map(([, t]) => Math.min(...t));
  const hourly = {
    time: days.flatMap(([d]) => stamps(d)), precipitation: temps.map(() => 0),
    dew_point_2m: temps.map(() => 30), cloud_cover: temps.map(() => 95), wind_speed_10m: temps.map(() => 12),
  };
  if (withTemp) hourly.temperature_2m = temps;
  return {
    timezone: 'America/New_York',
    daily: {
      time, precipitation_sum: z(0), precipitation_probability_max: z(0), temperature_2m_min: tmin,
      et0_fao_evapotranspiration: z(0.1), temperature_2m_max: days.map(([, t]) => Math.max(...t)),
      daylight_duration: z(45000), sunshine_duration: z(1000), shortwave_radiation_sum: z(5),
      wind_speed_10m_max: z(15), precipitation_hours: z(0),
    },
    hourly,
  };
}

// THE REAL SERIES: the live forecast at this Space's coordinates, fetched 2026-09-18 (the Lambda URL with
// temperature_2m appended), D-2..D3 = 09-16..09-21. Shifted -10F so it crosses the 40F trip point; a constant
// shift cannot move the hour of any day's minimum. Its own minima: D1 47.5 at 07:00, D2 47.8 at 02:00,
// D3 44.7 at 23:00 — one of each case, from one real payload.
const LIVE_0918 = [
  ['2026-09-16', [53.0, 52.0, 51.1, 50.3, 50.1, 50.4, 51.1, 52.0, 54.8, 57.4, 62.1, 66.3, 68.4, 71.8, 73.5, 75.0, 75.0, 75.0, 73.7, 70.8, 70.0, 68.4, 67.4, 66.4]],
  ['2026-09-17', [65.3, 64.7, 64.4, 64.7, 63.9, 63.6, 63.6, 63.7, 65.8, 67.4, 70.0, 71.6, 73.2, 75.4, 75.2, 74.2, 75.3, 73.4, 71.5, 70.5, 71.1, 70.9, 70.5, 69.2]],
  ['2026-09-18', [69.2, 68.4, 68.0, 67.2, 67.8, 67.8, 66.7, 65.6, 67.6, 69.2, 70.1, 72.3, 73.3, 74.7, 75.7, 74.9, 74.2, 72.8, 70.0, 65.9, 63.1, 61.0, 58.9, 57.0]],
  ['2026-09-19', [55.9, 54.8, 53.9, 52.7, 51.7, 49.7, 48.3, 47.5, 48.8, 50.8, 53.0, 55.6, 57.8, 60.0, 61.6, 62.8, 63.3, 62.7, 61.2, 58.4, 55.9, 53.9, 52.8, 51.5]],
  ['2026-09-20', [49.6, 48.6, 47.8, 49.4, 50.1, 50.3, 48.5, 48.0, 50.5, 50.8, 51.7, 51.5, 51.1, 51.1, 50.8, 50.6, 51.3, 51.9, 52.0, 52.0, 52.0, 52.0, 52.0, 51.9]],
  ['2026-09-21', [51.7, 51.5, 51.5, 51.7, 51.7, 51.7, 49.5, 48.6, 50.4, 52.9, 55.5, 58.2, 60.5, 61.9, 61.0, 61.0, 62.3, 62.8, 58.2, 52.9, 50.2, 48.3, 46.1, 44.7]],
];
const round1 = (n) => Math.round(n * 10) / 10;
// Shift the named days only, so the picked day is chosen by which days are cold.
const shifted = (coldDays, by = -10) => LIVE_0918.map(([d, t]) => [d, coldDays.includes(d) ? t.map((v) => round1(v + by)) : t]);

const USER = 'user_dave';
const SPACE = 'sp1';
const planting = (id, slug) => withCoverFlags({
  id, name: `${slug} ${id}`, project_id: 'pj1', status: 'fruiting', container_type: 'pot',
  container_size: '5gal', rain_exposed: null, variety: slug, genus: null, project: 'Garden',
  project_status: 'active', workspace_id: SPACE, crop_type_slug: slug, covered: false,
  assignee_user_id: USER, db_cadence: null, last_water: '2026-09-17', last_fert: '2026-09-01',
  substrate_start: '2026-05-01', transplant_at: null,
});
const PLANTINGS = [planting('p1', 'pepper'), planting('p2', 'tomato'), planting('p3', 'basil')];

function pgStub() {
  const writes = [];
  const query = vi.fn(async (sql, params) => {
    if (/insert into daily_plan/.test(sql)) { writes.push(JSON.parse(params[2])); return { rows: [] }; }
    if (/from plants/.test(sql)) return { rows: PLANTINGS };
    if (/from spaces/.test(sql)) return { rows: [{ id: SPACE, postal_code: null, weather_lat: 42.5, weather_lng: -72.6 }] };
    return { rows: [] };
  });
  return { query, writes };
}

async function driveReal(body, { today = '2026-09-18', tonightLow = 55 } = {}) {
  vi.stubEnv('FROST_ALERT_ENABLED', 'true');
  const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => structuredClone(body) }));
  const fetchPrecip = compiled(fetchImpl, { timeout: () => undefined }, { warn() {}, log() {}, error() {} });
  const pg = pgStub();
  const publishAlert = vi.fn(async () => ({ messageId: 'mid-1' }));
  await run({
    pg, today, dryRun: false, geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
    fetchNWS: async () => ({ tonightLow, highToday: 70, code: 3, unit: 'F', short: 'Cloudy' }),
    fetchPrecip, fetchStation: async () => null, publishAlert, etHour: 15, event: {},
  });
  const frost = publishAlert.mock.calls.map(([a]) => a).filter((a) => a.topic === 'frost');
  const row = pg.writes[pg.writes.length - 1];
  const evalLine = logs.mock.calls.map(([l]) => { try { return JSON.parse(l); } catch { return null; } })
    .find((l) => l && l.msg === 'frost-eval');
  return { frost, row, evalLine, url: fetchImpl.mock.calls.length ? String(fetchImpl.mock.calls[0][0]) : null };
}

const snsNight = (msg) => (/FROST ADVISORY — frost possible (.+?) \(low /.exec(msg) || [])[1];
const todayNight = (text) => (/^Frost possible (.+?) — low /.exec(text) || [])[1];

describe('END TO END on the real 2026-09-18 series — SNS text and Today line name the same night', () => {
  it('the URL the real fetchPrecip builds asks for hourly temperature_2m, APPENDED — daily untouched', async () => {
    const { url } = await driveReal(openMeteoBody(shifted(['2026-09-19'])));
    const list = (k) => (new RegExp(`[?&]${k}=([a-z0-9_,]+)`).exec(url) || [])[1].split(',');
    expect(list('hourly')).toEqual(['precipitation', 'dew_point_2m', 'cloud_cover', 'wind_speed_10m', 'temperature_2m']);
    expect(list('daily')).not.toContain('temperature_2m');
    expect(list('daily').slice(0, 3)).toEqual(['precipitation_sum', 'precipitation_probability_max', 'temperature_2m_min']);
    expect(url).toMatch(/temperature_unit=fahrenheit/);
    expect(url).toMatch(/timezone=America\/New_York&past_days=2&forecast_days=4/);
  });

  it('D1 cold, minimum 07:00 -> TONIGHT on both surfaces', async () => {
    const { frost, row, evalLine } = await driveReal(openMeteoBody(shifted(['2026-09-19'])));
    expect(frost).toHaveLength(1);
    expect(frost[0].message).toMatch(/^FROST ADVISORY — frost possible tonight \(low 37\.5°F, 2026-09-19\)\. At risk: /);
    const entry = row.alerts_sent.at(-1);
    expect(entry).toMatchObject({ tier: 'advisory', lowF: 37.5, dayOffset: 1, date: '2026-09-19', nightOffset: 0 });
    expect(buildFrostAlertLine(row.alerts_sent).text).toBe('Frost possible tonight — low 38°F. Plan cover for tender plants.');
    expect(evalLine).toMatchObject({ forecastMinHour: 7, advisoryNightOffset: 0, advisoryNightBasis: 'hourly' });
  });

  it('D2 cold, minimum 02:00 -> TOMORROW NIGHT on both surfaces (the old copy said "in 2 days")', async () => {
    const { frost, row, evalLine } = await driveReal(openMeteoBody(shifted(['2026-09-20'])));
    expect(snsNight(frost[0].message)).toBe('tomorrow night');
    expect(row.alerts_sent.at(-1)).toMatchObject({ dayOffset: 2, nightOffset: 1 });
    expect(todayNight(buildFrostAlertLine(row.alerts_sent).text)).toBe('tomorrow night');
    // located, not guessed: the base rate would give the same words here, so the basis is what proves it
    expect(evalLine).toMatchObject({ forecastMinHour: 2, advisoryNightBasis: 'hourly' });
  });

  it('D3 cold, minimum 23:00 -> MONDAY NIGHT on both surfaces (the old copy said "in 3 days")', async () => {
    const { frost, row } = await driveReal(openMeteoBody(shifted(['2026-09-21'])));
    expect(frost[0].message).toMatch(/^FROST ADVISORY — frost possible Monday night \(low 34\.7°F, 2026-09-21\)\. /);
    expect(row.alerts_sent.at(-1)).toMatchObject({ dayOffset: 3, nightOffset: 3 });
    expect(buildFrostAlertLine(row.alerts_sent).text).toBe('Frost possible Monday night — low 35°F. Plan cover for tender plants.');
  });

  it('the hourly temperature MISSING from the body -> base rate on both surfaces, and it says so', async () => {
    // D3 alone would be located to Monday night (its minimum is at 23:00); without the series it cannot be,
    // so both surfaces name the base-rate night — Sunday night, one EARLY, never one late.
    const { frost, row, evalLine } = await driveReal(openMeteoBody(shifted(['2026-09-21']), { withTemp: false }));
    expect(snsNight(frost[0].message)).toBe('Sunday night');
    expect(row.alerts_sent.at(-1)).toMatchObject({ dayOffset: 3, nightOffset: 2 });
    expect(todayNight(buildFrostAlertLine(row.alerts_sent).text)).toBe('Sunday night');
    expect(evalLine).toMatchObject({ advisoryNightBasis: 'base_rate', forecastMinHour: null });
  });

  it('a daily minimum the hours do not hold -> base rate (the misaligned series is not trusted)', async () => {
    const days = shifted(['2026-09-21']);
    const tmin = days.map(([, t]) => Math.min(...t));
    tmin[5] = round1(tmin[5] - 1.5);                       // D3's daily figure is 1.5F below any of its hours
    const { frost, evalLine } = await driveReal(openMeteoBody(days, { dailyMinOverride: tmin }));
    expect(snsNight(frost[0].message)).toBe('Sunday night');
    expect(evalLine.advisoryNightBasis).toBe('base_rate');
  });
});

describe('END TO END across the fall-back — weekday names do not move with DST or the process zone', () => {
  it('plan date Sat 2026-10-31, D2 = Mon 11-02 minimum at 23:00 -> "Monday night" on both surfaces', async () => {
    const mild = (d) => [d, dayCurve(55, 6)];
    const days = [mild('2026-10-29'), mild('2026-10-30'), mild('2026-10-31'), mild('2026-11-01'),
      ['2026-11-02', dayCurve(33, 23)], mild('2026-11-03')];
    const { frost, row } = await driveReal(openMeteoBody(days), { today: '2026-10-31' });
    expect(frost[0].message).toMatch(/frost possible Monday night \(low 33°F, 2026-11-02\)/);
    expect(buildFrostAlertLine(row.alerts_sent).text).toBe('Frost possible Monday night — low 33°F. Plan cover for tender plants.');
  });
});

// ── parity: the SNS phrase and the Today phrase agree across the whole grid ──────────────────────────
describe('PARITY — frostEval and src/lib/frostAlertLine.js word every night identically', () => {
  it('for every day, every hour of the minimum, across month, year and DST boundaries', () => {
    let n = 0;
    const planDates = ['2026-09-20', '2026-10-30', '2026-10-31', '2026-11-13', '2026-12-30', '2027-03-12', '2027-02-26'];
    const add = (d, k) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + k)).toISOString().slice(0, 10); };
    for (const plan of planDates) {
      for (const day of [1, 2, 3]) {
        for (const hour of [0, 4, 7, 11, 12, 18, 23, null]) {
          const dates = [add(plan, 1), add(plan, 2), add(plan, 3)];
          const lows = [50, 50, 50]; lows[day - 1] = 35;
          const hourly = hour == null ? null : hourlyFor([[dates[day - 1], dayCurve(35, hour)]]);
          const d = frostEval({ tonightLow: 60, forecastLows: lows, forecastDates: dates, forecastHourly: hourly,
            exposure: { tender: 3, unknown: 0, tenderContainers: 0 }, spaceId: 'S', eventDate: plan });
          expect(d.tier).toBe('advisory');
          const entry = { tier: 'advisory', level: 'advisory', at: 'z', ...frostWeatherFacts(d) };
          const sns = snsNight(d.message);
          const app = todayNight(buildFrostAlertLine([entry]).text);
          expect(app, `${plan} D${day} ${hour}:00`).toBe(sns);
          // and an entry that PREDATES nightOffset falls back identically on both sides
          const legacy = { ...entry };
          delete legacy.nightOffset;
          const legacyServer = nightPhrase(advisoryNight({ dayOffset: legacy.dayOffset, date: legacy.date }));
          expect(clientNightPhrase(resolveNight(legacy)), `${plan} D${day} legacy`).toBe(legacyServer);
          n++;
        }
      }
    }
    expect(n).toBe(7 * 3 * 8);
  });
});
