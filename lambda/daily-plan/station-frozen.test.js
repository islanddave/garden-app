// DRG-WXSTATION-003 / BUG-GAUGEFROZENZERO-001 — a frozen tipping bucket reads a false zero, so a civil day on
// which the station's own thermometer was at or below 32.0F has no trusted gauge total: the bucket is deleted
// and every field falls back to the labelled forecast figure, the way an implausible day already does.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import station from './station.js';
import handler from './handler.js';
import rainLog from './rainLog.js';
const { deriveStation, gaugeWindow, mergeStationHydrology, mergeStationWeather, overnightMins, GAUGE_FROZEN_MAX_F } = station;

const MAC = 'AA:BB:CC:DD:EE:FF';
const TZ = 'America/New_York';
const STATIONS = JSON.stringify([{ mac: MAC, tz: TZ, lat: 41.8888, lng: -70.7777, schema_version: 1 }]);

let prevStations;
beforeEach(() => { prevStations = process.env.AWN_STATIONS_JSON; process.env.AWN_STATIONS_JSON = STATIONS; });
afterEach(() => {
  if (prevStations === undefined) delete process.env.AWN_STATIONS_JSON;
  else process.env.AWN_STATIONS_JSON = prevStations;
});

// Same shape and the same July instants as station.test.js, so the clean fixture below IS that file's
// `freshFull`. The dates are arbitrary: the rule reads the thermometer, never the calendar.
const rec = (day, hh, dailyrainin, tempf) => ({ dateutc: Date.parse(`${day}T${hh}:00:00-04:00`), dailyrainin, tempf });
const NOW = Date.parse('2026-07-06T06:10:00Z'); // 02:10 ET on 2026-07-06 -> D0=07-06 D1=07-05 D2=07-04
const D0 = '2026-07-06', D1 = '2026-07-05', D2 = '2026-07-04', D3 = '2026-07-03';

// temps: { [day]: tempf } overrides one day's records; everything else is the clean fixture.
const fixture = (temps = {}) => ({ mac: MAC, records: [
  rec(D0, '02', 0.01, D0 in temps ? temps[D0] : 62),
  rec(D1, '18', 0.30, D1 in temps ? temps[D1] : 70),
  rec(D1, '12', 0.10, D1 in temps ? temps[D1] : 68),
  rec(D2, '18', 0.20, D2 in temps ? temps[D2] : 72),
  rec(D3, '18', 0.00, D3 in temps ? temps[D3] : 65),
] });
const om = () => ({ recent_precip_in: 0.9, today_precip_in: 0.4, today_pop: 60, upcoming_precip_in: 1.1,
  tomorrow_precip_in: 0.2, tomorrow_pop: 30, yesterday_precip_actual_in: 0.7 });

// Captured from station.js at dev 72c24167, BEFORE the rule existed, over exactly `fixture()` and `om()`.
const GOLDEN_DERIVE = '{"mac":"AA:BB:CC:DD:EE:FF","lat":41.8888,"lng":-70.7777,"tz":"America/New_York","fresh":true,"dataAgeMin":10,"tempF":62,"nightMins":{},"recentPrecipIn":0.5,"coversLookback":true,"buckets":{"2026-07-06":0.01,"2026-07-05":0.3,"2026-07-04":0.2,"2026-07-03":0},"uncertainty":null,"day0":"2026-07-06","day1":"2026-07-05","day2":"2026-07-04","hour0":2,"todayPrecipIn":0.01,"yesterdayPrecipIn":0.3,"implausibleDays":[],"negativeDays":[],"arraySilence":{"windowMin":1440,"records":3,"gaps":{"tempf":{"missing":0,"longestMin":0,"fromMs":null,"toMs":null,"missingNow":false},"dailyrainin":{"missing":0,"longestMin":0,"fromMs":null,"toMs":null,"missingNow":false}},"silent":[]}}';
const GOLDEN_MERGE = '{"merged":{"recent_precip_in":0.5,"today_precip_in":0.4,"today_pop":60,"upcoming_precip_in":1.1,"tomorrow_precip_in":0.2,"tomorrow_pop":30,"yesterday_precip_actual_in":0.3,"today_observed_in":0.01,"today_remaining_in":0.39},"prov":{"recent_source":"station","today_remaining_basis":"wholeday","today_remaining_fallback":"no_hourly","today_source":"station+forecast","yesterday_actual_source":"station","station_age_min":10,"station_fresh":true,"station_mac":"AA:BB:CC:DD:EE:FF"}}';

describe('DRG-WXSTATION-003 — a clean above-freezing day is untouched', () => {
  it('deriveStation is byte-identical to the pre-rule output, plus one empty frozenDays list', () => {
    const { frozenDays, ...rest } = deriveStation(fixture(), { nowMs: NOW });
    expect(frozenDays).toEqual([]);
    expect(JSON.stringify(rest)).toBe(GOLDEN_DERIVE);
  });

  it('mergeStationHydrology is byte-identical to the pre-rule output (no new provenance key)', () => {
    const out = mergeStationHydrology(om(), deriveStation(fixture(), { nowMs: NOW }));
    expect(JSON.stringify(out)).toBe(GOLDEN_MERGE);
    expect('station_frozen_days' in out.prov).toBe(false);
  });
});

describe('DRG-WXSTATION-003 — a day at or below 32.0F loses its gauge total', () => {
  it('the threshold is 32 and a garbage override falls back to it rather than to NaN', async () => {
    expect(GAUGE_FROZEN_MAX_F).toBe(32);
    const prev = process.env.AWN_GAUGE_FROZEN_MAX_F;
    try {
      process.env.AWN_GAUGE_FROZEN_MAX_F = 'nonsense';
      vi.resetModules();
      expect((await import('./station.js?frozen-garbage')).default.GAUGE_FROZEN_MAX_F).toBe(32);
      // A real override IS read, which is what proves the line above re-evaluated the module at all.
      process.env.AWN_GAUGE_FROZEN_MAX_F = '28';
      vi.resetModules();
      const colder = (await import('./station.js?frozen-28')).default;
      expect(colder.GAUGE_FROZEN_MAX_F).toBe(28);
      expect(colder.deriveStation(fixture({ [D1]: 30 }), { nowMs: NOW }).frozenDays).toEqual([]);
      expect(colder.deriveStation(fixture({ [D1]: 28 }), { nowMs: NOW }).frozenDays).toEqual([D1]);
    } finally {
      if (prev === undefined) delete process.env.AWN_GAUGE_FROZEN_MAX_F; else process.env.AWN_GAUGE_FROZEN_MAX_F = prev;
      vi.resetModules();
    }
  });

  it('a frozen D-1 is DELETED (never zeroed) and listed on its own, not as an implausible reading', () => {
    const s = deriveStation(fixture({ [D1]: 30 }), { nowMs: NOW });
    expect(D1 in s.buckets).toBe(false);
    expect(s.buckets).toEqual({ [D0]: 0.01, [D2]: 0.2, [D3]: 0 });
    expect(s.frozenDays).toEqual([D1]);
    expect(s.implausibleDays).toEqual([]);
    expect(s.yesterdayPrecipIn).toBeNull();
    expect(s.coversLookback).toBe(false);
    expect(s.recentPrecipIn).toBeNull();
    expect(s.uncertainty).toBe('frozen');
  });

  it('exactly 32.0F is frozen; 32.1F is not, and that day is published as before', () => {
    const at = deriveStation(fixture({ [D1]: 32.0 }), { nowMs: NOW });
    expect(at.frozenDays).toEqual([D1]);
    expect(D1 in at.buckets).toBe(false);

    const above = deriveStation(fixture({ [D1]: 32.1 }), { nowMs: NOW });
    expect(above.frozenDays).toEqual([]);
    expect(above.buckets[D1]).toBe(0.3);
    expect(above.recentPrecipIn).toBe(0.5);
    expect(above.uncertainty).toBeNull();
  });

  it('a mixed day is dropped: a frozen dawn is enough, whatever the afternoon read', () => {
    const raw = fixture();
    raw.records.push(rec(D1, '05', 0.00, 27.5));          // D-1 dawn frozen; its 12:00 and 18:00 records are 68F / 70F
    const s = deriveStation(raw, { nowMs: NOW });
    expect(s.frozenDays).toEqual([D1]);
    expect(D1 in s.buckets).toBe(false);
    expect(s.buckets[D2]).toBe(0.2);                       // the neighbouring day is not touched
  });

  it('several frozen days come back sorted, whatever order the records arrived in', () => {
    const s = deriveStation(fixture({ [D2]: 20, [D0]: 31, [D3]: 10 }), { nowMs: NOW });
    expect(s.frozenDays).toEqual([D3, D2, D0]);
    expect(s.buckets).toEqual({ [D1]: 0.3 });
  });

  it('a non-finite tempf never makes a day frozen: unknown is not frozen', () => {
    for (const bad of [undefined, null, NaN, '30', -Infinity]) {
      const s = deriveStation(fixture({ [D1]: bad }), { nowMs: NOW });
      expect(s.frozenDays).toEqual([]);
      expect(s.buckets[D1]).toBe(0.3);
      expect(s.recentPrecipIn).toBe(0.5);
    }
    // No finite tempf anywhere in the feed (the outdoor thermometer is dead): nothing is frozen.
    const raw = fixture();
    for (const r of raw.records) delete r.tempf;
    const s = deriveStation(raw, { nowMs: NOW });
    expect(s.frozenDays).toEqual([]);
    expect(Object.keys(s.buckets).sort()).toEqual([D3, D2, D1, D0]);
  });

  it('a frozen record with no usable dailyrainin still marks its day', () => {
    const raw = fixture();
    raw.records.push({ dateutc: Date.parse(`${D2}T04:00:00-04:00`), tempf: 25 });   // thermometer only
    const s = deriveStation(raw, { nowMs: NOW });
    expect(s.frozenDays).toEqual([D2]);
    expect(D2 in s.buckets).toBe(false);
  });
});

describe('DRG-WXSTATION-003 — the fallback is the existing absent-bucket path, labelled', () => {
  it('frozen D-1: recent and yesterday take the forecast figure, today stays on the gauge', () => {
    const { merged, prov } = mergeStationHydrology(om(), deriveStation(fixture({ [D1]: 30 }), { nowMs: NOW }));
    expect(merged.recent_precip_in).toBe(0.9);                   // Open-Meteo's, not 0 and not the gauge's 0.5
    expect(prov.recent_source).toBe('forecast');
    expect(merged.yesterday_precip_actual_in).toBe(0.7);
    expect(prov.yesterday_actual_source).toBe('forecast');
    expect(merged.today_observed_in).toBe(0.01);
    expect(prov.today_source).toBe('station+forecast');
    expect(prov.station_uncertainty).toBe('frozen');
    expect(prov.station_frozen_days).toEqual([D1]);
    expect(prov.station_rejected_days).toBeUndefined();          // frozen is not "reading impossible"
    expect(prov.station_fresh).toBe(true);
  });

  it('frozen D0: today is the forecast figure, with no observed/remaining split and no crash', () => {
    const s = deriveStation(fixture({ [D0]: 31 }), { nowMs: NOW });
    expect(s.todayPrecipIn).toBeNull();
    expect(s.frozenDays).toEqual([D0]);
    expect(gaugeWindow(s).observed).toBeNull();
    expect(gaugeWindow(s).recent).toBe(0.5);                     // the completed days are still measured

    const hourly = { timezone: TZ, time: [`${D0}T01:00`, `${D0}T05:00`, `${D0}T09:00`], precipitation: [0.1, 0.2, 0.1] };
    for (const base of [om(), { ...om(), hourly_precip: hourly }]) {
      const { merged, prov } = mergeStationHydrology(base, s);
      expect(merged.today_precip_in).toBe(0.4);                  // the whole-day forecast, untouched
      expect(prov.today_source).toBe('forecast');
      expect('today_observed_in' in merged).toBe(false);         // absent, never 0
      expect('today_remaining_in' in merged).toBe(false);
      expect('today_next_in' in merged).toBe(false);
      expect(merged.recent_precip_in).toBe(0.5);
      expect(prov.recent_source).toBe('station');
      expect(prov.yesterday_actual_source).toBe('station');
      // station_uncertainty is only written on the recent-fallback branch, which did not run: the
      // unconditional key is what keeps a D0-only drop visible.
      expect(prov.station_uncertainty).toBeUndefined();
      expect(prov.station_frozen_days).toEqual([D0]);
    }
  });

  it('frozen D0 with no forecast for today reads unavailable, not a dry day', () => {
    const s = deriveStation(fixture({ [D0]: 31 }), { nowMs: NOW });
    const { merged, prov } = mergeStationHydrology({ ...om(), today_precip_in: null }, s);
    expect(merged.today_precip_in).toBeNull();
    expect(prov.today_source).toBe('unavailable');
  });

  it('the rain autologger writes no rain event for a frozen yesterday, as for a rejected one', async () => {
    const TODAY = D0;
    const settled = [{ date: D1, et0_in: 0.1, tmax_f: 40, tmin_f: 28, precip_in: 0.7 }];
    const sourceFor = async (raw) => {
      const { merged, prov } = mergeStationHydrology({ ...om(), settled_days: settled }, deriveStation(raw, { nowMs: NOW }));
      const calls = [];
      const pg = { query: async (sql, params) => { calls.push(params); return { rows: [], rowCount: 1 }; } };
      expect(await handler.writeWeatherDaily(pg, 'space-1', TODAY, merged, prov)).toBe(1);
      return { precip_in: calls[0][5], precip_source: calls[0][6] };
    };
    const rejected = fixture();
    rejected.records[1] = rec(D1, '18', 99, 70);                 // D-1 over RAIN_MAX_DAILY_IN

    const frozenRow = await sourceFor(fixture({ [D1]: 30 }));
    expect(frozenRow).toEqual(await sourceFor(rejected));       // identical row to the rejected-day case
    expect(frozenRow).toEqual({ precip_in: 0.7, precip_source: 'openmeteo_live' });
    expect(rainLog.rainDecision(frozenRow)).toMatchObject({ log: false, reason: 'not_gauge_sourced:openmeteo_live' });

    // Control: the same day unfrozen IS gauge-sourced and does log, so the refusal above is the rule's doing.
    const cleanRow = await sourceFor(fixture());
    expect(cleanRow).toEqual({ precip_in: 0.3, precip_source: 'gauge_merged' });
    expect(rainLog.rainDecision(cleanRow).log).toBe(true);
  });
});

describe('DRG-WXSTATION-003 — uncertainty precedence: stale > implausible > frozen > warmup', () => {
  it('stale outranks frozen', () => {
    const s = deriveStation(fixture({ [D1]: 30 }), { nowMs: Date.parse('2026-07-06T10:00:00Z') });
    expect(s.fresh).toBe(false);
    expect(s.frozenDays).toEqual([D1]);
    expect(s.uncertainty).toBe('stale');
  });

  it('implausible outranks frozen, and both lists stay complete', () => {
    const raw = fixture({ [D1]: 30 });
    raw.records[3] = rec(D2, '18', 99, 72);                      // D-2 impossible, D-1 frozen
    const s = deriveStation(raw, { nowMs: NOW });
    expect(s.implausibleDays).toEqual([D2]);
    expect(s.frozenDays).toEqual([D1]);
    expect(s.uncertainty).toBe('implausible');
    const { prov } = mergeStationHydrology(om(), s);
    expect(prov.station_rejected_days).toEqual([D2]);
    expect(prov.station_frozen_days).toEqual([D1]);
  });

  it('an impossible total ON a frozen day is still reported as rejected', () => {
    const raw = fixture();
    raw.records[1] = rec(D1, '18', 99, 30);
    const s = deriveStation(raw, { nowMs: NOW });
    expect(s.implausibleDays).toEqual([D1]);
    expect(s.frozenDays).toEqual([D1]);
    expect(s.uncertainty).toBe('implausible');
  });

  it('a frozen day that kept a plausible record beside a negative one is not called rejected', () => {
    const raw = fixture({ [D1]: 30 });
    raw.records.push(rec(D1, '09', -0.5, 30));
    const s = deriveStation(raw, { nowMs: NOW });
    expect(s.negativeDays).toEqual([D1]);
    expect(s.implausibleDays).toEqual([]);                       // its bucket was dropped for frost, not for being negative-only
    expect(s.uncertainty).toBe('frozen');
  });

  it('frozen outranks warmup: the dropped day is what broke the lookback', () => {
    const s = deriveStation(fixture({ [D1]: 30 }), { nowMs: NOW });
    expect(s.coversLookback).toBe(false);
    expect(s.uncertainty).toBe('frozen');                        // NOT 'warmup'
    // and a warm-up with no freeze in it is still a warm-up
    const warm = deriveStation({ mac: MAC, records: [rec(D0, '02', 0.01, 62)] }, { nowMs: NOW });
    expect(warm.uncertainty).toBe('warmup');
  });
});

describe('DRG-WXSTATION-003 — a rain-gauge rule never weakens the frost floor', () => {
  // A hard-freeze night observed every 20 minutes from 18:00 on D-1 to 02:00 on D0, bottoming at 24F.
  const night = () => {
    const out = [];
    const start = Date.parse(`${D1}T18:00:00-04:00`);
    for (let i = 0; i <= 24; i++) out.push({ dateutc: start + i * 20 * 60000, dailyrainin: 0, tempf: i === 24 ? 25 : 31 - i * 0.25 });
    return out;
  };
  const cold = () => ({ mac: MAC, records: [...night(), rec(D2, '18', 0.20, 40), rec(D3, '18', 0.00, 41)] });

  it('fresh, tempF, dataAgeMin and nightMins are exactly what the thermometer says', () => {
    const raw = cold();
    const s = deriveStation(raw, { nowMs: NOW });
    expect(s.frozenDays).toEqual([D1, D0]);                      // the rule did fire on this fixture
    expect(s.todayPrecipIn).toBeNull();
    expect(s.fresh).toBe(true);
    expect(s.dataAgeMin).toBe(10);
    expect(s.tempF).toBe(25);
    const sorted = [...raw.records].sort((a, b) => b.dateutc - a.dateutc);
    expect(s.nightMins).toEqual(overnightMins(sorted, TZ));
    expect(s.nightMins[D1].minF).toBe(25);
  });

  it('mergeStationWeather still floors tonightLow from a station whose gauge days are all frozen', () => {
    const s = deriveStation(cold(), { nowMs: NOW });
    const { merged, prov } = mergeStationWeather({ tonightLow: 34 }, s);
    expect(merged.tonightLow).toBe(25);
    expect(prov).toEqual({ station_temp_f: 25, microclimate_offset: -9, low_source: 'station_floor' });
    // and the observed minima still reach the stored plan
    expect(mergeStationHydrology(om(), s).prov.station_overnight_mins).toEqual(s.nightMins);
  });
});

// One frozen day F in a clean week, seen from the 02:00 and 15:30 runs of F-1 .. F+3. THE RULE UNDER TEST: a
// frozen day loses ITS OWN total and nothing else. Before yesterdayCovered, `yesterday` rode coversLookback, so
// F also cost the measured figure for F+1 and F+2 and the 02:00 run on F+3, and the rain autologger wrote no
// event for a wet F+1 the gauge had counted correctly.
describe('DRG-WXSTATION-003 — a frozen day costs its own total only: the six-day sweep', () => {
  // Totals a clean gauge would publish. F reads the frozen funnel's false 0.00; F+1 is the wet, unfrozen day.
  const DAYS = ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10', '2026-07-11', '2026-07-12', '2026-07-13'];
  const RAIN = [0.00, 0.10, 0.20, 0.30, 0.00, 0.45, 0.05, 0.00];
  const F = 4;                                                   // DAYS[F] = 2026-07-10
  const at = (day, hh, mm) => Date.parse(`${day}T${hh}:${mm}:00-04:00`);
  // The 72 h the fetch returns, one record per half hour, newest at the run's own minute. The day's rain all
  // falls by 10:00; the only freezing readings in the week are F's dawn, 04:00-07:00.
  const feed = (day, hh, mm, { frost = true } = {}) => {
    const end = at(day, hh, mm), records = [];
    for (let ms = end; ms > end - 72 * 3600000; ms -= 30 * 60000) {
      const d = station.civilDay(ms, TZ), h = station.civilHour(ms, TZ);
      const cold = frost && d === DAYS[F] && h >= 4 && h <= 7;
      records.push({ dateutc: ms, dailyrainin: h >= 10 ? RAIN[DAYS.indexOf(d)] : 0, tempf: cold ? 30 : 45 });
    }
    return { nowMs: end + 5 * 60000, raw: { mac: MAC, records } };
  };
  const RUNS = [['02', '00'], ['15', '30']];
  const G = 'gauge', FC = 'forecast';
  const src = (s) => (/^station/.test(s) ? G : s);
  const run = (i, [hh, mm], opts) => {
    const { nowMs, raw } = feed(DAYS[i], hh, mm, opts);
    const s = deriveStation(raw, { nowMs });
    const { merged, prov } = mergeStationHydrology(om(), s);
    return { s, merged, prov, row: [src(prov.today_source), src(prov.yesterday_actual_source), merged.yesterday_precip_actual_in,
      src(prov.recent_source), merged.recent_precip_in] };
  };

  //            today  yesterday        recent        (forecast figures are om()'s: yesterday 0.7, recent 0.9)
  const WANT = {
    'F-1 02:00': [G,  G,  0.20, G,  0.30],
    'F-1 15:30': [G,  G,  0.20, G,  0.30],
    'F+0 02:00': [G,  G,  0.30, G,  0.50],                       // the dawn has not happened yet
    'F+0 15:30': [FC, G,  0.30, G,  0.50],                       // F's own total is the only thing lost
    'F+1 02:00': [G,  FC, 0.7,  FC, 0.9],                        // yesterday IS F: no total to publish
    'F+1 15:30': [G,  FC, 0.7,  FC, 0.9],
    'F+2 02:00': [G,  G,  0.45, FC, 0.9],                        // F+1 measured; the sum still lacks F
    'F+2 15:30': [G,  G,  0.45, FC, 0.9],
    'F+3 02:00': [G,  G,  0.05, FC, 0.9],                        // F is the anchor, and a deleted bucket
    'F+3 15:30': [G,  G,  0.05, G,  0.50],                       // F's dawn has left the 72 h window
  };

  it('which figure is the gauge\'s and which the forecast\'s, F-1 .. F+3 at 02:00 and 15:30', () => {
    const got = {};
    for (let off = -1; off <= 3; off++) for (const t of RUNS) {
      got[`F${off < 0 ? off : `+${off}`} ${t.join(':')}`] = run(F + off, t).row;
    }
    expect(got).toEqual(WANT);
  });

  it('the same week with no frost is the gauge throughout: every forecast cell above is the rule\'s doing', () => {
    for (let off = -1; off <= 3; off++) for (const t of RUNS) {
      const { row, s } = run(F + off, t, { frost: false });
      expect(s.frozenDays).toEqual([]);
      expect([row[0], row[1], row[3]], `F${off} ${t.join(':')}`).toEqual([G, G, G]);
    }
  });

  it('`recent` never moves: null whenever either of its days is missing, in step in both gates', () => {
    for (let off = -1; off <= 3; off++) for (const t of RUNS) {
      const { s } = run(F + off, t);
      const gw = gaugeWindow(s);
      expect(gw.coversLookback).toBe(s.coversLookback);
      expect(gw.recent).toBe(s.recentPrecipIn);
      // coversYesterday only ever ADDS to coversLookback, and never without a measured D-1 to publish.
      if (gw.coversLookback) expect(gw.coversYesterday).toBe(true);
      if (gw.coversYesterday) expect(Number.isFinite(s.buckets[s.day1])).toBe(true);
      expect(station.yesterdayCovered(s, s.day1, s.day2)).toBe(gw.coversYesterday);
    }
    const f2 = run(F + 2, RUNS[0]);
    expect([f2.s.coversLookback, gaugeWindow(f2.s).coversYesterday]).toEqual([false, true]);
    expect(f2.s.yesterdayPrecipIn).toBe(0.45);
    expect(f2.s.recentPrecipIn).toBeNull();
    expect(f2.prov.station_uncertainty).toBe('frozen');          // the sum's fallback is still named
  });

  it('the rain autologger logs the MEASURED figure for F+1, and still nothing for F', async () => {
    const rowFor = async (i) => {
      const { nowMs, raw } = feed(DAYS[i], '02', '00');
      const settled = [{ date: DAYS[i - 1], et0_in: 0.1, tmax_f: 45, tmin_f: 40, precip_in: 0.7 }];
      const { merged, prov } = mergeStationHydrology({ ...om(), settled_days: settled }, deriveStation(raw, { nowMs }));
      const calls = [];
      const pg = { query: async (sql, params) => { calls.push(params); return { rows: [], rowCount: 1 }; } };
      expect(await handler.writeWeatherDaily(pg, 'space-1', DAYS[i], merged, prov)).toBe(1);
      return { date: calls[0][1], precip_in: calls[0][5], precip_source: calls[0][6] };
    };
    // The 02:00 run on F+2 is the autolog slot that settles F+1.
    const wet = await rowFor(F + 2);
    expect(wet).toEqual({ date: DAYS[F + 1], precip_in: 0.45, precip_source: 'gauge_merged' });
    expect(rainLog.rainDecision(wet).log).toBe(true);
    // The 02:00 run on F+1 settles F itself: forecast figure, never logged as a rain event.
    const frozen = await rowFor(F + 1);
    expect(frozen).toEqual({ date: DAYS[F], precip_in: 0.7, precip_source: 'openmeteo_live' });
    expect(rainLog.rainDecision(frozen).log).toBe(false);
  });
});

describe('DRG-WXSTATION-003 — only a frozen day counts as reporting; a rejected day is still missing', () => {
  // D-2 gone three ways over the same clean fixture. Only the frozen one leaves yesterday on the gauge.
  const yest = (raw) => {
    const s = deriveStation(raw, { nowMs: NOW });
    const { merged, prov } = mergeStationHydrology(om(), s);
    return [prov.yesterday_actual_source, merged.yesterday_precip_actual_in, prov.recent_source, gaugeWindow(s).coversYesterday];
  };
  const withD2 = (dailyrainin, tempf) => { const raw = fixture(); raw.records[3] = rec(D2, '18', dailyrainin, tempf); return raw; };

  it('frozen D-2: yesterday is measured, the two-day sum is not', () => {
    expect(yest(fixture({ [D2]: 30 }))).toEqual(['station', 0.3, 'forecast', true]);
  });

  it('implausible D-2 and negative-only D-2: yesterday is the forecast figure, exactly as before the rule', () => {
    expect(yest(withD2(99, 72))).toEqual(['forecast', 0.7, 'forecast', false]);
    expect(yest(withD2(-1, 72))).toEqual(['forecast', 0.7, 'forecast', false]);
  });

  it('a D-2 that is BOTH frozen and rejected is rejected', () => {
    expect(yest(withD2(99, 30))).toEqual(['forecast', 0.7, 'forecast', false]);
    expect(yest(withD2(-1, 30))).toEqual(['forecast', 0.7, 'forecast', false]);
  });

  it('a frozen ANCHOR (D-3) covers yesterday; a rejected or absent one does not', () => {
    expect(yest(fixture({ [D3]: 30 }))).toEqual(['station', 0.3, 'forecast', true]);
    const rejected = fixture(); rejected.records[4] = rec(D3, '18', 99, 65);
    expect(yest(rejected)).toEqual(['forecast', 0.7, 'forecast', false]);
    const absent = fixture(); absent.records.pop();
    expect(yest(absent)).toEqual(['forecast', 0.7, 'forecast', false]);
  });

  it('a frozen D-1 is never published, whatever else is covered', () => {
    expect(yest(fixture({ [D1]: 30 }))).toEqual(['forecast', 0.7, 'forecast', false]);
    expect(yest(fixture({ [D1]: 30, [D2]: 30, [D3]: 30 }))).toEqual(['forecast', 0.7, 'forecast', false]);
  });

  it('a frozen day cannot stand in for a station that was not there: warm-up is still warm-up', () => {
    // D-1 and a frozen D-2, nothing earlier: D-2 is the first day on record, so it is no anchor for itself.
    const raw = fixture({ [D2]: 30 }); raw.records.pop();
    expect(yest(raw)).toEqual(['forecast', 0.7, 'forecast', false]);
  });

  it('a stale station publishes no yesterday, frozen neighbour or not', () => {
    const s = deriveStation(fixture({ [D2]: 30 }), { nowMs: Date.parse('2026-07-06T10:00:00Z') });
    expect(s.fresh).toBe(false);
    expect(mergeStationHydrology(om(), s).prov.yesterday_actual_source).toBe('forecast');
  });

  it('a replay addresses the same test by plan day, and a hand-built station with no day lists is unchanged', () => {
    const s = deriveStation(fixture({ [D3]: 30 }), { nowMs: NOW });
    expect(gaugeWindow(s, D0).coversYesterday).toBe(true);
    expect(gaugeWindow(s, D1).coversYesterday).toBe(false);      // D-2 has a bucket but nothing stands before D-3
    const bare = { buckets: { [D0]: 0.01, [D1]: 0.3, [D2]: 0.2, [D3]: 0 }, day0: D0 };
    expect(gaugeWindow(bare)).toMatchObject({ coversLookback: true, coversYesterday: true });
    expect(gaugeWindow({ buckets: { [D0]: 0.01, [D1]: 0.3 }, day0: D0 })).toMatchObject({ coversLookback: false, coversYesterday: false });
    expect(gaugeWindow(null).coversYesterday).toBe(false);
  });
});
