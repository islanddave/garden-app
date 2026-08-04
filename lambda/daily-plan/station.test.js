import { describe, it, expect } from 'vitest';
import station from './station.js';
const { deriveStation, gaugeWindow, bindStationToSpace, mergeStationHydrology, mergeStationWeather } = station;

const MAC = 'F8:B3:B7:82:1F:0D';
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

describe('bindStationToSpace', () => {
  const s = { mac: MAC, lat: 42.5089, lng: -72.6466 };
  it('matches a Space whose stored coords are within tolerance', () => {
    expect(bindStationToSpace({ weather_lat: 42.5089, weather_lng: -72.6466 }, s)).toBe(s);
  });
  it('does not bind a far Space', () => {
    expect(bindStationToSpace({ weather_lat: 40.0, weather_lng: -74.0 }, s)).toBeNull();
  });
  it('null coords -> no bind', () => {
    expect(bindStationToSpace({ weather_lat: null, weather_lng: null }, s)).toBeNull();
  });
});
