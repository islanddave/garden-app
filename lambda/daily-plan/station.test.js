import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import station from './station.js';
const { deriveStation, gaugeWindow, bindStationToSpace, mergeStationHydrology, mergeStationWeather, remainingHourlyIn, effectiveHour } = station;

const MAC = 'AA:BB:CC:DD:EE:FF';
const LAT = 41.8888;
const LNG = -70.7777;

// station.js ships an EMPTY DEFAULT_STATIONS on purpose — the real record (gauge MAC + site coordinate)
// lives only in the deployed env, because this repo is public. So these tests must supply their own
// config; they used to inherit the shipped default, which silently coupled every assertion here to
// production values. Synthetic on both sides asserts exactly the same behaviour.
let prevStations;
beforeEach(() => {
  prevStations = process.env.AWN_STATIONS_JSON;
  process.env.AWN_STATIONS_JSON = JSON.stringify([
    { mac: MAC, tz: 'America/New_York', lat: LAT, lng: LNG, schema_version: 1 },
  ]);
});
afterEach(() => {
  if (prevStations === undefined) delete process.env.AWN_STATIONS_JSON;
  else process.env.AWN_STATIONS_JSON = prevStations;
});
// ET is EDT (-04:00) for all July fixtures. rec(day,'HH',dailyrainin,tempf) at that ET wall-clock.
const rec = (day, hh, dailyrainin, tempf) => ({ dateutc: Date.parse(`${day}T${hh}:00:00-04:00`), dailyrainin, tempf });
const NOW = Date.parse('2026-07-06T06:10:00Z'); // 02:10 ET on 2026-07-06 -> D0=07-06 D1=07-05 D2=07-04

// Fresh, full 2-day lookback: D1 peak 0.30, D2 peak 0.20, coverage anchor on 07-03. recent => 0.50.
const freshFull = { mac: MAC, records: [
  rec('2026-07-06', '02', 0.01, 62),   // D0 newest (age ~10min)
  rec('2026-07-05', '18', 0.30, 70),   // D1 peak
  rec('2026-07-05', '12', 0.10, 68),   // D1 earlier/lower (tests max-per-day)
  rec('2026-07-04', '18', 0.20, 72),   // D2 peak
  rec('2026-07-03', '18', 0.00, 65),   // coverage anchor (day < D2)
]};

describe('deriveStation', () => {
  it('present + fresh + full lookback -> recent = D1+D2 max-per-day, tempF = newest', () => {
    const s = deriveStation(freshFull, { nowMs: NOW });
    expect(s).toBeTruthy();
    expect(s.fresh).toBe(true);
    expect(s.coversLookback).toBe(true);
    expect(s.recentPrecipIn).toBe(0.5);   // 0.30 (max of 0.30/0.10) + 0.20
    expect(s.tempF).toBe(62);
    expect(s.uncertainty).toBeNull();
    expect(s.dataAgeMin).toBeLessThan(90);
  });

  it('offline / empty -> null', () => {
    expect(deriveStation(null, { nowMs: NOW })).toBeNull();
    expect(deriveStation({ mac: MAC, records: [] }, { nowMs: NOW })).toBeNull();
    expect(deriveStation({ mac: MAC }, { nowMs: NOW })).toBeNull();
  });

  it('stale (newest older than freshness window) -> fresh=false, uncertainty=stale', () => {
    const late = Date.parse('2026-07-06T10:00:00Z'); // newest record now ~4h old
    const s = deriveStation(freshFull, { nowMs: late });
    expect(s.fresh).toBe(false);
    expect(s.uncertainty).toBe('stale');
  });

  it('malformed dailyrainin is skipped, never poisons a bucket', () => {
    const bad = { mac: MAC, records: [...freshFull.records, rec('2026-07-05', '20', '99', 70), { dateutc: Date.parse('2026-07-05T21:00:00-04:00'), dailyrainin: NaN, tempf: 70 }] };
    const s = deriveStation(bad, { nowMs: NOW });
    expect(s.recentPrecipIn).toBe(0.5); // unchanged; string/NaN ignored
  });

  it('missing dailyrainin field is not coerced to 0.0', () => {
    // A day whose only record lacks dailyrainin gets NO bucket (not a 0 bucket).
    const s = deriveStation({ mac: MAC, records: [ rec('2026-07-06', '02', 0.01, 62), { dateutc: Date.parse('2026-07-05T18:00:00-04:00'), tempf: 70 }, rec('2026-07-04', '18', 0.20, 72), rec('2026-07-03', '18', 0.0, 65) ] }, { nowMs: NOW });
    // D1 has no finite dailyrainin -> not covered -> recent null (fall back), NOT 0.20.
    expect(s.coversLookback).toBe(false);
    expect(s.recentPrecipIn).toBeNull();
  });

  it('truthful 0.0 across the window -> recent = 0 (valid), distinct from unavailable', () => {
    const dry = { mac: MAC, records: [ rec('2026-07-06', '02', 0.0, 62), rec('2026-07-05', '18', 0.0, 70), rec('2026-07-04', '18', 0.0, 72), rec('2026-07-03', '18', 0.0, 65) ] };
    const s = deriveStation(dry, { nowMs: NOW });
    expect(s.coversLookback).toBe(true);
    expect(s.recentPrecipIn).toBe(0);
  });

  it('warm-up (only today, station just online) -> coversLookback=false, uncertainty=warmup', () => {
    const s = deriveStation({ mac: MAC, records: [ rec('2026-07-06', '02', 0.01, 62), rec('2026-07-06', '01', 0.0, 61) ] }, { nowMs: NOW });
    expect(s.coversLookback).toBe(false);
    expect(s.recentPrecipIn).toBeNull();
    expect(s.uncertainty).toBe('warmup');
  });

  // ── BUG-RAINACTUAL-001 H1 — the D0 / D-1 buckets were already computed and thrown away ──
  it('H1 exposes the D0 and D-1 buckets + their civil-day labels', () => {
    const s = deriveStation(freshFull, { nowMs: NOW });
    expect(s.day0).toBe('2026-07-06');
    expect(s.day1).toBe('2026-07-05');
    expect(s.day2).toBe('2026-07-04');
    expect(s.todayPrecipIn).toBe(0.01);
    expect(s.yesterdayPrecipIn).toBe(0.3);          // max of the two D-1 records, not the newest
  });

  it('H1 an absent D0 bucket is null, NEVER 0 (no record today != no rain today)', () => {
    const noToday = { mac: MAC, records: [ rec('2026-07-05', '18', 0.30, 70), rec('2026-07-04', '18', 0.20, 72), rec('2026-07-03', '18', 0.0, 65) ] };
    const s = deriveStation(noToday, { nowMs: NOW });
    expect(s.todayPrecipIn).toBeNull();
    expect(s.yesterdayPrecipIn).toBe(0.3);
  });

  it('H1 warm-up station still reports today truthfully (dailyrainin is a since-midnight accumulator)', () => {
    // Online only since 01:00 today: the 2-day LOOKBACK is unusable, but the station's own accumulator
    // already carries the whole civil day to that point. Warm-up must not suppress today.
    const s = deriveStation({ mac: MAC, records: [ rec('2026-07-06', '02', 0.41, 62), rec('2026-07-06', '01', 0.0, 61) ] }, { nowMs: NOW });
    expect(s.coversLookback).toBe(false);
    expect(s.todayPrecipIn).toBe(0.41);
    expect(s.yesterdayPrecipIn).toBeNull();
  });
});

describe('gaugeWindow — buckets addressed by civil-day LABEL (replay correctness)', () => {
  it('with no planDay it reproduces deriveStation exactly (live-run byte-parity)', () => {
    const s = deriveStation(freshFull, { nowMs: NOW });
    const gw = gaugeWindow(s, null);
    expect(gw.day).toBe(s.day0);
    expect(gw.observed).toBe(s.todayPrecipIn);
    expect(gw.yesterday).toBe(s.yesterdayPrecipIn);
    expect(gw.recent).toBe(s.recentPrecipIn);         // 0.5
    expect(gw.coversLookback).toBe(s.coversLookback); // true
  });

  it('an explicit planDay reads THAT day, not the day the fetch happened on', () => {
    const s = deriveStation(freshFull, { nowMs: NOW });
    const gw = gaugeWindow(s, '2026-07-05');
    expect(gw.day).toBe('2026-07-05');
    expect(gw.observed).toBe(0.3);   // D-1's bucket becomes "today" for that replay
    expect(gw.yesterday).toBe(0.2);
    // Coverage is re-evaluated for the replayed day: the payload's earliest record IS 07-03, so 07-03's
    // midnight-to-midnight is not fully captured -> recent falls back rather than under-reporting.
    expect(gw.coversLookback).toBe(false);
    expect(gw.recent).toBeNull();
  });

  it('no station / no buckets -> all null, never 0', () => {
    for (const st of [null, undefined, {}, { buckets: null }]) {
      const gw = gaugeWindow(st, '2026-07-06');
      expect(gw.observed).toBeNull();
      expect(gw.yesterday).toBeNull();
      expect(gw.recent).toBeNull();
      expect(gw.coversLookback).toBe(false);
    }
  });
});

describe('mergeStationHydrology (B2 field-granular)', () => {
  const om = { recent_precip_in: 0.9, today_precip_in: 0.1, today_pop: 40, upcoming_precip_in: 0.3, tomorrow_precip_in: 0.2, tomorrow_pop: 55 };
  it('fresh+covered station overrides recent ONLY; forecast fields preserved', () => {
    const s = deriveStation(freshFull, { nowMs: NOW });
    const { merged, prov } = mergeStationHydrology(om, s);
    expect(merged.recent_precip_in).toBe(0.5);        // station wins
    expect(merged.tomorrow_precip_in).toBe(0.2);      // Open-Meteo forecast preserved
    expect(merged.upcoming_precip_in).toBe(0.3);
    expect(prov.recent_source).toBe('station');
  });
  it('warm-up station does NOT override; keeps Open-Meteo recent + flags uncertainty', () => {
    const warm = deriveStation({ mac: MAC, records: [ rec('2026-07-06', '02', 0.01, 62) ] }, { nowMs: NOW });
    const { merged, prov } = mergeStationHydrology(om, warm);
    expect(merged.recent_precip_in).toBe(0.9);        // Open-Meteo retained
    expect(prov.recent_source).toBe('forecast');
    expect(prov.station_uncertainty).toBe('warmup');
  });
  it('null Open-Meteo + fresh station -> recent from station, forecast fields null', () => {
    const s = deriveStation(freshFull, { nowMs: NOW });
    const { merged, prov } = mergeStationHydrology(null, s);
    expect(merged.recent_precip_in).toBe(0.5);
    expect(merged.tomorrow_precip_in).toBeNull();
    expect(prov.recent_source).toBe('station');
  });
});

// ── BUG-RAINACTUAL-001 H2/H3 — gauge-driven today + gauge-sourced yesterday actual ──────────────────
// Fixtures are the REAL 2026-08-03 numbers: the WS-2902 measured 2.22" while Open-Meteo's forecast-model
// hindcast (what the app stored as the "actual") said 4.63".
describe('mergeStationHydrology — today split + yesterday actual (BUG-RAINACTUAL-001)', () => {
  const aug = (day, hh, dailyrainin, tempf = 70) => ({ dateutc: Date.parse(`${day}T${hh}:00:00-04:00`), dailyrainin, tempf });
  const NOW_PM = Date.parse('2026-08-04T19:30:00Z');   // 15:30 ET on 08-04 -> D0=08-04 D1=08-03 D2=08-02
  const NOW_AM = Date.parse('2026-08-04T06:05:00Z');   // 02:05 ET on 08-04, the nightly run

  // Fully covered payload; `d0` parameterizes how much has fallen so far TODAY.
  const payload = (d0, hh = '15') => ({ mac: MAC, records: [
    aug('2026-08-04', hh, d0),
    aug('2026-08-03', '23', 2.22),   // D-1 peak — the on-site truth for 08-03
    aug('2026-08-03', '12', 1.10),   // earlier/lower: max-per-day, not newest-per-day
    aug('2026-08-02', '18', 0.05),
    aug('2026-08-01', '18', 0.00),   // coverage anchor (day < D-2)
  ]});
  // Open-Meteo as it actually was: 4.63" claimed for 08-03, carried in BOTH the today slot (for an 08-03
  // plan) and the yesterday-actual slot (for an 08-04 plan).
  const om = (over = {}) => ({ recent_precip_in: 5.1, today_precip_in: 0.40, today_pop: 55,
    upcoming_precip_in: 0.3, tomorrow_precip_in: 0.2, tomorrow_pop: 60, yesterday_precip_actual_in: 4.63, ...over });

  it('H3 THE BUG: yesterday_precip_actual_in comes from the gauge (2.22), not the hindcast (4.63)', () => {
    const st = deriveStation(payload(0.10), { nowMs: NOW_PM });
    const { merged, prov } = mergeStationHydrology(om(), st, { planDay: '2026-08-04' });
    expect(merged.yesterday_precip_actual_in).toBe(2.22);
    expect(prov.yesterday_actual_source).toBe('station');
  });

  it('H2 mid-day: today splits into measured + still-expected, summing to today_precip_in', () => {
    const st = deriveStation(payload(0.10), { nowMs: NOW_PM });
    const { merged, prov } = mergeStationHydrology(om(), st, { planDay: '2026-08-04' });
    expect(merged.today_observed_in).toBe(0.1);
    expect(merged.today_remaining_in).toBe(0.3);
    expect(merged.today_precip_in).toBe(0.4);
    expect(merged.today_precip_in).toBe(merged.today_observed_in + merged.today_remaining_in);
    expect(prov.today_source).toBe('station+forecast');
    expect(merged.tomorrow_precip_in).toBe(0.2);           // a gauge cannot forecast — untouched
    expect(merged.today_pop).toBe(55);
  });

  it('H2 gauge EXCEEDS forecast -> remaining clamps to 0; real water is never subtracted', () => {
    const st = deriveStation(payload(2.22), { nowMs: NOW_PM });
    const { merged, prov } = mergeStationHydrology(om({ today_precip_in: 1.00 }), st, { planDay: '2026-08-04' });
    expect(merged.today_observed_in).toBe(2.22);
    expect(merged.today_remaining_in).toBe(0);             // NOT -1.22
    expect(merged.today_precip_in).toBe(2.22);             // the busted-low forecast loses to the gauge
    expect(prov.today_source).toBe('station');
  });

  it('H2 02:00 run (observed ~0) is behaviourally identical to the pre-change forecast-only path', () => {
    const st = deriveStation(payload(0.0, '02'), { nowMs: NOW_AM });
    const base = om({ today_precip_in: 4.63 });
    const { merged, prov } = mergeStationHydrology(base, st, { planDay: '2026-08-04' });
    expect(merged.today_observed_in).toBe(0);
    expect(merged.today_remaining_in).toBe(4.63);
    expect(merged.today_precip_in).toBe(base.today_precip_in);  // the whole point: nothing has fallen yet
    expect(prov.today_source).toBe('station+forecast');
  });

  it('H2/H3 STALE station: nothing is overridden and every field is labelled forecast', () => {
    const st = deriveStation(payload(0.10), { nowMs: NOW_PM + 6 * 3600 * 1000 }); // newest ~6.5h old
    expect(st.fresh).toBe(false);
    const { merged, prov } = mergeStationHydrology(om(), st, { planDay: '2026-08-04' });
    expect(merged.today_observed_in).toBeUndefined();
    expect(merged.today_remaining_in).toBeUndefined();
    expect(merged.today_precip_in).toBe(0.4);              // Open-Meteo retained verbatim
    expect(merged.yesterday_precip_actual_in).toBe(4.63);  // fallback allowed...
    expect(prov.yesterday_actual_source).toBe('forecast'); // ...but NEVER silently
    expect(prov.today_source).toBe('forecast');
    expect(prov.station_uncertainty).toBe('stale');
  });

  it('H2/H3 WARM-UP station: today is gauge-driven, but yesterday stays a labelled forecast', () => {
    // Online since 01:00 today only. The accumulator is truthful for today; D-1 was never observed.
    const warm = deriveStation({ mac: MAC, records: [aug('2026-08-04', '15', 0.75), aug('2026-08-04', '01', 0.0)] }, { nowMs: NOW_PM });
    expect(warm.coversLookback).toBe(false);
    const { merged, prov } = mergeStationHydrology(om(), warm, { planDay: '2026-08-04' });
    expect(merged.today_observed_in).toBe(0.75);
    expect(merged.today_remaining_in).toBe(0);             // clamped: 0.40 forecast < 0.75 measured
    expect(merged.today_precip_in).toBe(0.75);
    expect(prov.today_source).toBe('station');
    expect(merged.yesterday_precip_actual_in).toBe(4.63);
    expect(prov.yesterday_actual_source).toBe('forecast');
    expect(prov.recent_source).toBe('forecast');
    expect(prov.station_uncertainty).toBe('warmup');
  });

  it('H2/H3 ABSENT station: hydrology passes through untouched, still labelled', () => {
    const base = om();
    const { merged, prov } = mergeStationHydrology(base, null, { planDay: '2026-08-04' });
    expect(merged).toEqual(base);
    expect(prov.today_source).toBe('forecast');
    expect(prov.yesterday_actual_source).toBe('forecast');
    expect(prov.station_mac).toBeUndefined();
  });

  it('H2/H3 no station AND no forecast -> unavailable, never a fabricated 0', () => {
    const { merged, prov } = mergeStationHydrology(null, null, { planDay: '2026-08-04' });
    expect(prov.today_source).toBe('unavailable');
    expect(prov.yesterday_actual_source).toBe('unavailable');
    expect(prov.recent_source).toBe('unavailable');
    expect(merged.today_observed_in).toBeUndefined();
    expect(merged.yesterday_precip_actual_in).toBeUndefined();
  });

  it('H3 station present but Open-Meteo down -> the actual still lands, from the gauge', () => {
    const st = deriveStation(payload(0.10), { nowMs: NOW_PM });
    const { merged, prov } = mergeStationHydrology(null, st, { planDay: '2026-08-04' });
    expect(merged.yesterday_precip_actual_in).toBe(2.22);
    expect(prov.yesterday_actual_source).toBe('station');
    expect(merged.today_observed_in).toBe(0.1);
    expect(merged.today_remaining_in).toBe(0);             // no forecast to add
    expect(merged.today_precip_in).toBe(0.1);
    expect(prov.today_source).toBe('station');
  });

  it('replay: planDay 08-03 reads 08-03s gauge (2.22), not the day the fetch happened on', () => {
    const st = deriveStation(payload(0.10), { nowMs: NOW_PM });     // fetched on 08-04
    const { merged } = mergeStationHydrology(om(), st, { planDay: '2026-08-03' });
    expect(merged.today_observed_in).toBe(2.22);
    expect(merged.today_remaining_in).toBe(0);
    expect(merged.today_precip_in).toBe(2.22);
  });

  it('an observed DRY day is 0 (real data), distinct from an unobserved day (absent)', () => {
    const st = deriveStation(payload(0.0), { nowMs: NOW_PM });
    const { merged, prov } = mergeStationHydrology(om({ today_precip_in: 0 }), st, { planDay: '2026-08-04' });
    expect(merged.today_observed_in).toBe(0);
    expect(merged.today_precip_in).toBe(0);
    expect(prov.today_source).toBe('station');
  });
});

// ── H5: remaining = the forecast for the hours NOT YET ELAPSED ────────────────────────────────────
// The H2 form (`max(0, wholeDay - observed)`) made today_precip_in unable to drop BELOW the whole-day
// forecast, so on the very event that started this work — gauge 2.22", forecast 4.63" — it reproduced the
// broken number exactly. Every number in the REAL fixture below is live Open-Meteo/AWN data for 2026-08-03.
describe('H5 remaining-from-hourly (BUG-RAINACTUAL-001)', () => {
  // Live Open-Meteo hourly `precipitation` (inch) for 2026-08-03 at 41.8888,-70.7777, fetched 2026-08-04.
  // Sums to 4.635 == the 4.634 daily total the app recorded as "actual" for a day the gauge measured at 2.22.
  const AUG3_HOURLY = { 2: 0.028, 3: 0.016, 4: 0.169, 5: 3.358, 6: 0.028, 7: 0.016, 8: 0.665, 12: 0.028, 16: 0.327 };
  const AUG3_DAILY = 4.634;
  const H2_NUMBER = 4.63;          // what the shipped whole-day subtraction produces: the broken number
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const GAUGE_AUG3 = 2.22;
  // Build the verbatim Open-Meteo hourly shape for a run of days (24 rows/day, local ISO strings).
  const hourly = (days, perDay, tz = 'America/New_York') => {
    const time = [], precipitation = [];
    for (const d of days) for (let h = 0; h < 24; h++) {
      time.push(`${d}T${String(h).padStart(2, '0')}:00`);
      precipitation.push((perDay[d] && perDay[d][h]) || 0);
    }
    return { time, precipitation, timezone: tz };
  };
  const AUG_HOURLY = hourly(['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04'], { '2026-08-03': AUG3_HOURLY });
  const at = (day, hh, dailyrainin) => ({ dateutc: Date.parse(`${day}T${hh}:00-04:00`), dailyrainin, tempf: 70 });
  // Gauge payload with `d0` inches accumulated so far on 08-03, newest record at `hh` ET.
  const aug3Station = (d0, hh) => deriveStation({ mac: MAC, records: [
    at('2026-08-03', hh, d0), at('2026-08-02', '18:00', 0.0), at('2026-08-01', '18:00', 0.0), at('2026-07-31', '18:00', 0.0),
  ] }, { nowMs: Date.parse(`2026-08-03T${hh}:00-04:00`) });
  // Open-Meteo as it actually was for an 08-03 plan: 4.634" claimed for the day.
  const om = (over = {}) => ({ recent_precip_in: 0.0, today_precip_in: AUG3_DAILY, today_pop: 90,
    upcoming_precip_in: 0.0, tomorrow_precip_in: 0.0, tomorrow_pop: 5, yesterday_precip_actual_in: 0.0,
    hourly_precip: AUG_HOURLY, ...over });

  it('THE FIX, real 08-03 numbers at 15:30: the gauge drives the total DOWN off the busted forecast', () => {
    const st = aug3Station(GAUGE_AUG3, '15:30');
    expect(st.hour0).toBe(15);
    const { merged, prov } = mergeStationHydrology(om(), st, { planDay: '2026-08-03' });
    expect(merged.today_observed_in).toBe(2.22);
    expect(merged.today_remaining_in).toBe(0.33);          // only the 16:00 hour is still ahead
    expect(merged.today_precip_in).toBe(2.55);             // NOT 4.63
    expect(prov.today_remaining_basis).toBe('hourly');
    expect(prov.today_remaining_from_hour).toBe(15);
    // The regression this test exists for: H2 produced observed + (4.634 - 2.22) == the whole-day forecast.
    expect(merged.today_precip_in).toBeLessThan(AUG3_DAILY);
    expect(Math.abs(merged.today_precip_in - GAUGE_AUG3)).toBeLessThan(0.4);   // lands near the gauge
  });

  it('02:00 nightly keeps parity: nearly the whole day is still ahead, so remaining ~= the forecast', () => {
    const st = aug3Station(0.0, '02:05');
    expect(st.hour0).toBe(2);
    const { merged, prov } = mergeStationHydrology(om(), st, { planDay: '2026-08-03' });
    expect(merged.today_observed_in).toBe(0);
    expect(merged.today_remaining_in).toBe(4.61);          // 4.635 less the 0.028 that fell in hour 02
    expect(Math.abs(merged.today_precip_in - AUG3_DAILY)).toBeLessThan(0.05);  // the nightly baseline is unmoved
    expect(prov.today_remaining_basis).toBe('hourly');
  });

  it('decays monotonically through the day — the whole point of driving it hourly', () => {
    const totals = ['02:05', '05:30', '09:30', '15:30', '21:30'].map((hh, i) => {
      const observed = [0, 0.2, 2.2, GAUGE_AUG3, GAUGE_AUG3][i];   // gauge as it would have read at that hour
      const st = aug3Station(observed, hh);
      return mergeStationHydrology(om(), st, { planDay: '2026-08-03' }).merged.today_remaining_in;
    });
    for (let i = 1; i < totals.length; i++) expect(totals[i]).toBeLessThanOrEqual(totals[i - 1]);
    expect(totals[totals.length - 1]).toBe(0);              // after the last wet hour nothing is left to come
  });

  it('late-day: with no hours left, today_precip_in IS the gauge, exactly', () => {
    const st = aug3Station(GAUGE_AUG3, '21:30');
    const { merged, prov } = mergeStationHydrology(om(), st, { planDay: '2026-08-03' });
    expect(merged.today_remaining_in).toBe(0);
    expect(merged.today_precip_in).toBe(GAUGE_AUG3);
    expect(prov.today_source).toBe('station');
  });

  it('FALLBACK no hourly array -> H2 whole-day behaviour, LABELLED, never a silent zero', () => {
    const st = aug3Station(GAUGE_AUG3, '15:30');
    const { merged, prov } = mergeStationHydrology(om({ hourly_precip: null }), st, { planDay: '2026-08-03' });
    expect(merged.today_remaining_in).toBe(round2(AUG3_DAILY - GAUGE_AUG3));  // 2.41 — exactly what ships today
    expect(merged.today_precip_in).toBe(H2_NUMBER);        // the pre-H5 number, reproduced exactly
    expect(prov.today_remaining_basis).toBe('wholeday');
    expect(prov.today_remaining_fallback).toBe('no_hourly');
  });

  it('FALLBACK plan day outside the hourly window -> whole-day, NOT remaining=0', () => {
    const st = aug3Station(GAUGE_AUG3, '15:30');
    const short = hourly(['2026-08-05', '2026-08-06'], {});   // hourly window misses 08-03 entirely
    const { merged, prov } = mergeStationHydrology(om({ hourly_precip: short }), st, { planDay: '2026-08-03' });
    expect(merged.today_remaining_in).toBeGreaterThan(0);
    expect(prov.today_remaining_fallback).toBe('hourly_unusable');
  });

  it('FALLBACK day present but every future value null -> whole-day, NOT remaining=0', () => {
    const st = aug3Station(GAUGE_AUG3, '15:30');
    const nulled = hourly(['2026-08-03'], { '2026-08-03': AUG3_HOURLY });
    nulled.precipitation = nulled.precipitation.map((v, i) => (Number(nulled.time[i].slice(11, 13)) > 15 ? null : v));
    const { merged, prov } = mergeStationHydrology(om({ hourly_precip: nulled }), st, { planDay: '2026-08-03' });
    expect(merged.today_remaining_in).toBe(round2(AUG3_DAILY - GAUGE_AUG3));
    expect(prov.today_remaining_fallback).toBe('hourly_unusable');
  });

  it('FALLBACK hourly tz != station tz -> refuse to read a misaligned day boundary', () => {
    const st = aug3Station(GAUGE_AUG3, '15:30');
    const other = { ...AUG_HOURLY, timezone: 'America/Denver' };
    const { merged, prov } = mergeStationHydrology(om({ hourly_precip: other }), st, { planDay: '2026-08-03' });
    expect(merged.today_precip_in).toBe(H2_NUMBER);
    expect(prov.today_remaining_fallback).toBe('tz_mismatch');
  });

  it('the fallback is never WORSE than what ships today (identical to the H2 number)', () => {
    const st = aug3Station(0.10, '15:30');
    const base = om({ today_precip_in: 0.40, hourly_precip: null });
    const { merged } = mergeStationHydrology(base, st, { planDay: '2026-08-03' });
    expect(merged.today_observed_in).toBe(0.1);
    expect(merged.today_remaining_in).toBe(0.3);
    expect(merged.today_precip_in).toBe(0.4);
  });

  it('replay of a PAST plan day: fully elapsed, so remaining is 0 and the gauge stands alone', () => {
    const st = aug3Station(0.0, '15:30');                                  // station clock is on 08-03
    const withAug2 = om({ hourly_precip: hourly(['2026-08-02', '2026-08-03'], { '2026-08-02': { 14: 0.9 } }) });
    const { merged, prov } = mergeStationHydrology(withAug2, st, { planDay: '2026-08-02' });
    expect(prov.today_remaining_basis).toBe('hourly');
    expect(prov.today_remaining_from_hour).toBe(23);
    expect(merged.today_remaining_in).toBe(0);
  });

  describe('remainingHourlyIn — pure window math', () => {
    it('sums strictly AFTER the current hour; the current hour is already in the gauge', () => {
      const h = hourly(['2026-08-03'], { '2026-08-03': { 15: 1.0, 16: 0.5, 17: 0.25 } });
      expect(remainingHourlyIn(h, '2026-08-03', 15)).toBe(0.75);
      expect(remainingHourlyIn(h, '2026-08-03', 14)).toBe(1.75);
      expect(remainingHourlyIn(h, '2026-08-03', 23)).toBe(0);
    });

    it('DST fall-back (25 rows, two 01:00): BOTH repeated hours count — both are still ahead', () => {
      const time = [], precipitation = [];
      for (const [hh, v] of [['00', 0], ['01', 0.2], ['01', 0.3], ['02', 0.1], ['03', 0.4]]) {
        time.push(`2026-11-01T${hh}:00`); precipitation.push(v);
      }
      const h = { time, precipitation, timezone: 'America/New_York' };
      expect(remainingHourlyIn(h, '2026-11-01', 0)).toBe(1);       // 0.2 + 0.3 + 0.1 + 0.4
      expect(remainingHourlyIn(h, '2026-11-01', 1)).toBe(0.5);     // both 01:00 rows drop out together
    });

    it('DST spring-forward (23 rows, no 02:00) needs no special case', () => {
      const time = [], precipitation = [];
      for (const hh of [0, 1, 3, 4, 5]) { time.push(`2026-03-08T${String(hh).padStart(2, '0')}:00`); precipitation.push(0.1); }
      const h = { time, precipitation, timezone: 'America/New_York' };
      expect(remainingHourlyIn(h, '2026-03-08', 1)).toBe(0.3);     // hours 3,4,5
    });

    it('matches by DATE STRING, so an hourly array starting on a different day than daily is fine', () => {
      // daily starts D-2 (08-01) but hourly here starts a day later — index math would read the wrong day.
      const h = hourly(['2026-08-02', '2026-08-03'], { '2026-08-02': { 20: 9.9 }, '2026-08-03': { 20: 0.4 } });
      expect(remainingHourlyIn(h, '2026-08-03', 15)).toBe(0.4);    // NOT 9.9
    });

    it('returns null (never 0) for every unusable input — absence is not "no rain coming"', () => {
      const h = hourly(['2026-08-03'], { '2026-08-03': { 20: 0.4 } });
      expect(remainingHourlyIn(null, '2026-08-03', 15)).toBeNull();
      expect(remainingHourlyIn({ time: [], precipitation: [] }, '2026-08-03', 15)).toBeNull();
      expect(remainingHourlyIn({ time: ['x'] }, '2026-08-03', 15)).toBeNull();
      expect(remainingHourlyIn(h, '2026-08-09', 15)).toBeNull();   // day not in window
      expect(remainingHourlyIn(h, '2026-08-03', NaN)).toBeNull();
      const allNull = { ...h, precipitation: h.precipitation.map(() => null) };
      expect(remainingHourlyIn(allNull, '2026-08-03', 15)).toBeNull();
    });

    it('a partially-null day still sums the values it does have', () => {
      const h = hourly(['2026-08-03'], { '2026-08-03': { 18: 0.2, 20: 0.4 } });
      h.precipitation[h.time.indexOf('2026-08-03T18:00')] = null;
      expect(remainingHourlyIn(h, '2026-08-03', 15)).toBe(0.4);
    });
  });

  describe('effectiveHour — replay awareness', () => {
    const st = { day0: '2026-08-04', hour0: 9 };
    it('same day -> the station clock', () => expect(effectiveHour(st, '2026-08-04')).toBe(9));
    it('past day -> fully elapsed', () => expect(effectiveHour(st, '2026-08-03')).toBe(23));
    it('future day -> entirely ahead', () => expect(effectiveHour(st, '2026-08-05')).toBe(-1));
    it('no station clock -> null, routing to the fallback', () => {
      expect(effectiveHour({ day0: '2026-08-04' }, '2026-08-04')).toBeNull();
      expect(effectiveHour(null, '2026-08-04')).toBeNull();
    });
  });
});

describe('mergeStationWeather (B4 conservative floor)', () => {
  it('colder station floors the forecast low (protective), never warms it', () => {
    const cold = { mac: MAC, fresh: true, tempF: 38, recentPrecipIn: null, coversLookback: false, uncertainty: null };
    const { merged, prov } = mergeStationWeather({ tonightLow: 42, highToday: 55 }, cold);
    expect(merged.tonightLow).toBe(38);
    expect(prov.low_source).toBe('station_floor');
    expect(prov.microclimate_offset).toBe(-4);
  });
  it('warmer station is inert (summer) — low unchanged', () => {
    const warm = { mac: MAC, fresh: true, tempF: 65, recentPrecipIn: null, coversLookback: false, uncertainty: null };
    const { merged, prov } = mergeStationWeather({ tonightLow: 60, highToday: 85 }, warm);
    expect(merged.tonightLow).toBe(60);
    expect(prov.low_source).toBe('forecast');
  });
  it('stale station never calibrates the low', () => {
    const stale = { mac: MAC, fresh: false, tempF: 38, recentPrecipIn: null, coversLookback: false, uncertainty: 'stale' };
    const { merged } = mergeStationWeather({ tonightLow: 42 }, stale);
    expect(merged.tonightLow).toBe(42);
  });
});

// ── DRG-GAUGESANITY-001 — upper plausibility bound on dailyrainin ─────────────────────────────────────
// FRESHNESS_MAX_MIN established only that the gauge was REPORTING, never that the number was POSSIBLE. A
// phantom-tipping bucket (spider, debris, hail) reads as real rain, and real rain SUPPRESSES watering —
// outranking both the bagHeatGate and freshTransplant carve-outs — so an over-reading gauge kills plants.
// The bound is anchored on the MA 24-hour record (18.15", Hurricane Diane 1955), NOT on this site's 94-day
// distribution (max 2.23", p99 1.31"), so it can never reject a storm that actually happened.
describe('DRG-GAUGESANITY-001 — an implausible dailyrainin is rejected like a stale reading', () => {
  const { RAIN_MAX_DAILY_IN } = station;
  const om = { recent_precip_in: 0.9, today_precip_in: 0.1, today_pop: 40, upcoming_precip_in: 0.3,
    tomorrow_precip_in: 0.2, tomorrow_pop: 55, yesterday_precip_actual_in: 0.45 };
  // freshFull with only D0's accumulator swapped — the one knob every case below turns.
  const withToday = (d0) => ({ mac: MAC, records: [rec('2026-07-06', '02', d0, 62), ...freshFull.records.slice(1)] });

  it('the bound is a PHYSICAL ceiling, comfortably above the regional record', () => {
    expect(RAIN_MAX_DAILY_IN).toBe(20);
    expect(RAIN_MAX_DAILY_IN).toBeGreaterThan(18.15);   // MA 24h record: a real event must never be rejected
  });

  it('plausible readings pass untouched, including ones far above anything this site has seen', () => {
    for (const v of [0.01, 2.23, 8.0]) {   // 2.23 == the 94-day site max; 8.0 == a tropical remnant, still real
      const s = deriveStation(withToday(v), { nowMs: NOW });
      expect(s.todayPrecipIn).toBe(v);
      expect(s.implausibleDays).toEqual([]);
      expect(s.uncertainty).toBeNull();
      expect(mergeStationHydrology(om, s).merged.today_observed_in).toBe(v);
    }
  });

  it('the boundary is strictly-greater: exactly the bound is real rain, a hundredth over is not', () => {
    const at = deriveStation(withToday(RAIN_MAX_DAILY_IN), { nowMs: NOW });
    expect(at.todayPrecipIn).toBe(RAIN_MAX_DAILY_IN);
    expect(at.implausibleDays).toEqual([]);
    const over = deriveStation(withToday(RAIN_MAX_DAILY_IN + 0.01), { nowMs: NOW });
    expect(over.todayPrecipIn).toBeNull();
    expect(over.implausibleDays).toEqual(['2026-07-06']);
  });

  it('a rejected day is DROPPED — never clamped to the bound, never zeroed into a fake dry day', () => {
    const s = deriveStation(withToday(64.0), { nowMs: NOW });    // stuck bucket
    expect(s.todayPrecipIn).toBeNull();                          // not 0, and not 20
    expect(s.buckets['2026-07-06']).toBeUndefined();
    expect(s.uncertainty).toBe('implausible');
    const { merged, prov } = mergeStationHydrology(om, s);
    expect(merged.today_observed_in).toBeUndefined();
    expect(merged.today_precip_in).toBe(0.1);                    // Open-Meteo retained verbatim
    expect(prov.today_source).toBe('forecast');
    expect(prov.station_rejected_days).toEqual(['2026-07-06']);
  });

  it('an all-day fault yields the IDENTICAL merged hydrology a stale station does — no new failure mode', () => {
    const bad = deriveStation({ mac: MAC, records: freshFull.records.map((r) => ({ ...r, dailyrainin: 99.9 })) }, { nowMs: NOW });
    const stale = deriveStation(freshFull, { nowMs: NOW + 6 * 3600 * 1000 });
    expect(bad.fresh).toBe(true);      // freshness is untouched: the feed is current, one number in it was not
    expect(stale.fresh).toBe(false);
    expect(mergeStationHydrology(om, bad).merged).toEqual(mergeStationHydrology(om, stale).merged);
    expect(mergeStationHydrology(om, bad).prov.station_uncertainty).toBe('implausible');
    expect(mergeStationHydrology(om, stale).prov.station_uncertainty).toBe('stale');
  });

  it('a fault on ONE day keeps the others, and is still labelled where nothing else would show it', () => {
    const s = deriveStation(withToday(41.0), { nowMs: NOW });
    expect(s.recentPrecipIn).toBe(0.5);                          // D-1 + D-2 survive intact
    expect(s.yesterdayPrecipIn).toBe(0.3);
    const { merged, prov } = mergeStationHydrology(om, s);
    expect(merged.recent_precip_in).toBe(0.5);
    expect(prov.recent_source).toBe('station');                  // the station_uncertainty branch never runs...
    expect(prov.station_uncertainty).toBeUndefined();
    expect(prov.station_rejected_days).toEqual(['2026-07-06']);  // ...so this is what keeps the drop visible
    expect(merged.yesterday_precip_actual_in).toBe(0.3);
  });

  it('"implausible" outranks "warmup" — the rejection IS what broke coverage, so it names the cause', () => {
    const s = deriveStation({ mac: MAC, records: [
      rec('2026-07-06', '02', 0.01, 62), rec('2026-07-05', '18', 77.0, 70),
      rec('2026-07-04', '18', 0.20, 72), rec('2026-07-03', '18', 0.0, 65),
    ] }, { nowMs: NOW });
    expect(s.implausibleDays).toEqual(['2026-07-05']);
    expect(s.coversLookback).toBe(false);
    expect(s.recentPrecipIn).toBeNull();                         // not 0.20, and not 0
    expect(s.uncertainty).toBe('implausible');                   // NOT 'warmup'
  });

  it('"stale" still outranks it — an old feed is the larger problem', () => {
    expect(deriveStation(withToday(99.0), { nowMs: NOW + 6 * 3600 * 1000 }).uncertainty).toBe('stale');
  });

  it('a rain-gauge fault must NOT disarm the frost path (this is why fresh is left alone)', () => {
    const s = deriveStation({ mac: MAC, records: [rec('2026-07-06', '02', 88.0, 38), ...freshFull.records.slice(1)] }, { nowMs: NOW });
    expect(s.uncertainty).toBe('implausible');
    const { merged, prov } = mergeStationWeather({ tonightLow: 42 }, s);
    expect(merged.tonightLow).toBe(38);                          // the station still floors the low
    expect(prov.low_source).toBe('station_floor');
  });

  it('AWN_RAIN_MAX_DAILY_IN overrides the bound; a garbage override falls back to 20, never to NaN', async () => {
    const prev = process.env.AWN_RAIN_MAX_DAILY_IN;
    try {
      for (const [env, expected] of [['3', 3], ['not-a-number', 20], ['', 20]]) {
        process.env.AWN_RAIN_MAX_DAILY_IN = env;
        vi.resetModules();
        const ns = await import('./station.js');
        const m = ns.default || ns;
        expect(m.RAIN_MAX_DAILY_IN).toBe(expected);
        // 8" is real rain under the default bound and a fault under a 3" one: proves the value is live-wired,
        // and that a NaN bound (which would compare false forever, silently disabling the gate) cannot happen.
        expect(m.deriveStation(withToday(8.0), { nowMs: NOW }).todayPrecipIn).toBe(expected === 3 ? null : 8);
      }
    } finally {
      if (prev === undefined) delete process.env.AWN_RAIN_MAX_DAILY_IN; else process.env.AWN_RAIN_MAX_DAILY_IN = prev;
      vi.resetModules();
    }
  });
});

// ── DRG-GAUGENEG-001 — lower plausibility bound on dailyrainin ────────────────────────────────────────
// The other half of the same rule. dailyrainin is a since-midnight TIP COUNTER, so a negative is never
// weather — but it was not merely believed, it was LAUNDERED: `Math.max(bucket ?? 0, v)` floors every bucket
// at 0, so an all-negative day published a confident 0.00" "no rain". That is the same fabricated dry day
// GAUGESANITY closed from the top, arriving as the modal value of today_observed_in (80 of 82 stored plans),
// and a dry day is what RELEASES watering suppression.
describe('DRG-GAUGENEG-001 — a negative dailyrainin is dropped, never laundered into a dry day', () => {
  const { RAIN_MIN_DAILY_IN } = station;
  const om = { recent_precip_in: 0.9, today_precip_in: 0.1, today_pop: 40, upcoming_precip_in: 0.3,
    tomorrow_precip_in: 0.2, tomorrow_pop: 55, yesterday_precip_actual_in: 0.45 };
  const withToday = (d0) => ({ mac: MAC, records: [rec('2026-07-06', '02', d0, 62), ...freshFull.records.slice(1)] });

  it('the floor is the instrument\'s own, not a weather judgement: exactly 0', () => {
    expect(RAIN_MIN_DAILY_IN).toBe(0);
  });

  it('a day with only negative records is ABSENT, not 0 — the fabricated dry day is the whole defect', () => {
    const s = deriveStation(withToday(-0.02), { nowMs: NOW });   // a hair under zero is already impossible
    expect(s.todayPrecipIn).toBeNull();                          // pre-fix this was 0, published as "no rain"
    expect(s.buckets['2026-07-06']).toBeUndefined();
    expect(s.negativeDays).toEqual(['2026-07-06']);
    expect(s.implausibleDays).toEqual(['2026-07-06']);           // no bucket left => rejected, same as too-high
    expect(s.uncertainty).toBe('implausible');
    const { merged, prov } = mergeStationHydrology(om, s);
    expect(merged.today_observed_in).toBeUndefined();
    expect(merged.today_precip_in).toBe(0.1);                    // Open-Meteo retained verbatim
    expect(prov.today_source).toBe('forecast');
  });

  it('zero rain is LEGITIMATE and stays distinguishable from a rejected day', () => {
    const dry = deriveStation(withToday(0), { nowMs: NOW });
    expect(dry.todayPrecipIn).toBe(0);                           // a real dry day still reports 0
    expect(dry.negativeDays).toEqual([]);
    expect(dry.implausibleDays).toEqual([]);
    expect(dry.uncertainty).toBeNull();
    expect(mergeStationHydrology(om, dry).merged.today_observed_in).toBe(0);
    // ...and the boundary is strictly-below, matching the upper bound's strictly-above.
    expect(deriveStation(withToday(-0.01), { nowMs: NOW }).todayPrecipIn).toBeNull();
  });

  it('a mixed day drops the bad SAMPLES and keeps the day — a good record is not lost to a bad one', () => {
    // Newest record is the corrupt one, which is the adversarial order: it also supplies tempF.
    const s = deriveStation({ mac: MAC, records: [
      rec('2026-07-06', '02', -9999, 62), rec('2026-07-06', '01', 0.42, 61), ...freshFull.records.slice(1),
    ] }, { nowMs: NOW });
    expect(s.todayPrecipIn).toBe(0.42);                          // the real total, from the records that were fine
    expect(s.negativeDays).toEqual(['2026-07-06']);
    expect(s.implausibleDays).toEqual([]);                       // the day survived, so nothing was rejected
    expect(s.uncertainty).toBeNull();                            // and its coverage is intact, so not 'implausible'
    expect(s.recentPrecipIn).toBe(0.5);
    expect(mergeStationHydrology(om, s).merged.today_observed_in).toBe(0.42);
  });

  it('an all-negative D-1 breaks coverage and says so, instead of summing a phantom 0 into recent', () => {
    const s = deriveStation({ mac: MAC, records: [
      rec('2026-07-06', '02', 0.01, 62), rec('2026-07-05', '18', -0.5, 70),
      rec('2026-07-04', '18', 0.20, 72), rec('2026-07-03', '18', 0.0, 65),
    ] }, { nowMs: NOW });
    expect(s.negativeDays).toEqual(['2026-07-05']);
    expect(s.coversLookback).toBe(false);
    expect(s.recentPrecipIn).toBeNull();                         // not 0.20, and not 0
    expect(s.yesterdayPrecipIn).toBeNull();
    expect(s.uncertainty).toBe('implausible');                   // NOT 'warmup' — the drop is what broke coverage
  });

  it('an all-negative station yields the IDENTICAL merged hydrology a stale one does — no new failure mode', () => {
    const bad = deriveStation({ mac: MAC, records: freshFull.records.map((r) => ({ ...r, dailyrainin: -1 })) }, { nowMs: NOW });
    const stale = deriveStation(freshFull, { nowMs: NOW + 6 * 3600 * 1000 });
    expect(bad.fresh).toBe(true);      // freshness untouched: the feed is current, the numbers in it were not
    expect(mergeStationHydrology(om, bad).merged).toEqual(mergeStationHydrology(om, stale).merged);
    expect(mergeStationHydrology(om, bad).prov.station_uncertainty).toBe('implausible');
  });

  it('provenance tells the two bounds apart, and a day that trips both is listed once', () => {
    // negative only -> the day survived; the sample loss is still never silent.
    const mixed = deriveStation({ mac: MAC, records: [
      rec('2026-07-06', '02', -3, 62), rec('2026-07-06', '01', 0.42, 61), ...freshFull.records.slice(1),
    ] }, { nowMs: NOW });
    const mp = mergeStationHydrology(om, mixed).prov;
    expect(mp.station_negative_days).toEqual(['2026-07-06']);
    expect(mp.station_rejected_days).toBeUndefined();
    // over the ceiling only -> rejected, and not misreported as a negative.
    const high = mergeStationHydrology(om, deriveStation(withToday(64.0), { nowMs: NOW })).prov;
    expect(high.station_rejected_days).toEqual(['2026-07-06']);
    expect(high.station_negative_days).toBeUndefined();
    // both on one day -> rejected AND flagged, with no duplicate entry.
    const both = deriveStation({ mac: MAC, records: [
      rec('2026-07-06', '02', 64.0, 62), rec('2026-07-06', '01', -3, 61), ...freshFull.records.slice(1),
    ] }, { nowMs: NOW });
    expect(both.implausibleDays).toEqual(['2026-07-06']);
    expect(both.negativeDays).toEqual(['2026-07-06']);
  });

  it('a negative gauge reading must NOT disarm the frost path (fresh is left alone, as with the upper bound)', () => {
    const s = deriveStation({ mac: MAC, records: [rec('2026-07-06', '02', -9999, 38), ...freshFull.records.slice(1)] }, { nowMs: NOW });
    expect(s.uncertainty).toBe('implausible');
    const { merged, prov } = mergeStationWeather({ tonightLow: 42 }, s);
    expect(merged.tonightLow).toBe(38);
    expect(prov.low_source).toBe('station_floor');
  });

  it('the floor is NOT env-tunable — an override could only ever re-open the hole', async () => {
    const prev = process.env.AWN_RAIN_MIN_DAILY_IN;
    try {
      process.env.AWN_RAIN_MIN_DAILY_IN = '-100';
      vi.resetModules();
      const ns = await import('./station.js');
      const m = ns.default || ns;
      expect(m.RAIN_MIN_DAILY_IN).toBe(0);
      expect(m.deriveStation(withToday(-0.5), { nowMs: NOW }).todayPrecipIn).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.AWN_RAIN_MIN_DAILY_IN; else process.env.AWN_RAIN_MIN_DAILY_IN = prev;
      vi.resetModules();
    }
  });
});

describe('bindStationToSpace', () => {
  const s = { mac: MAC, lat: 41.8888, lng: -70.7777 };
  it('matches a Space whose stored coords are within tolerance', () => {
    expect(bindStationToSpace({ weather_lat: 41.8888, weather_lng: -70.7777 }, s)).toBe(s);
  });
  it('does not bind a far Space', () => {
    expect(bindStationToSpace({ weather_lat: 40.0, weather_lng: -74.0 }, s)).toBeNull();
  });
  it('null coords -> no bind', () => {
    expect(bindStationToSpace({ weather_lat: null, weather_lng: null }, s)).toBeNull();
  });
});
