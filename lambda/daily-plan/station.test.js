import { describe, it, expect } from 'vitest';
import station from './station.js';
const { deriveStation, bindStationToSpace, mergeStationHydrology, mergeStationWeather } = station;

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
