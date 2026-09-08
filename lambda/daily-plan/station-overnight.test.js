// V5-RADIATIVEFROST-001 — the observed overnight minimum, which is the corpus's TRUTH column.
//
// WHY IT NEEDED WRITING AT ALL. The station object already carried `tempF`, and `tempF` is
// `newest.tempf` — the reading at FETCH time. The daily-plan runs land at 02:00, 05:30 and 15:30 ET,
// so none of them observes the night's actual minimum, which falls shortly after sunrise. The full
// 5-minute series was fetched every run and discarded down to that one value.
//
// AND IT CANNOT BE BACKFILLED: `weather_daily.tmin_f` is Open-Meteo's model value, and the AWN API
// serves a rolling ~3-day window. A night not recorded here is gone.
import { describe, it, expect } from 'vitest';
import st from './station.js';

const { overnightMins, OVERNIGHT_MIN_SAMPLES } = st;
const TZ = 'America/New_York';

// 5-minute records across a local night, as the AWN API serves them (epoch ms + tempf).
function night(dateISO, { from = 18, to = 8, tempAt = () => 45, stepMin = 5 } = {}) {
  const recs = [];
  const base = Date.parse(`${dateISO}T00:00:00-04:00`);
  for (let h = from; h < 24; h++) {
    for (let m = 0; m < 60; m += stepMin) recs.push({ dateutc: base + (h * 60 + m) * 60000, tempf: tempAt(h) });
  }
  for (let h = 0; h <= to; h++) {
    for (let m = 0; m < 60; m += stepMin) recs.push({ dateutc: base + ((24 + h) * 60 + m) * 60000, tempf: tempAt(h) });
  }
  return recs;
}

describe('overnightMins — the site-truth minimum the corpus is fitted against', () => {
  it('keys a night by the date it STARTS on, matching radiativeFrost.nightsFrom', () => {
    // The join key between observed minimum and forecast conditions. If these two disagreed the
    // corpus would pair every night with the wrong night's weather — the exact 36%-error class that
    // an off-by-one in the advisory path already produced once in this feature.
    const out = overnightMins(night('2026-10-09'), TZ);
    expect(Object.keys(out)).toEqual(['2026-10-09']);
  });

  it('reports the MINIMUM, not the newest reading — the whole point', () => {
    // Falls through the night and bottoms at 04:00, which is where a real radiative minimum lands and
    // is exactly the hour no scheduled run is awake for.
    const temps = { 18: 52, 19: 50, 20: 48, 21: 46, 22: 44, 23: 43, 0: 42, 1: 41, 2: 40, 3: 38, 4: 34, 5: 36, 6: 38, 7: 41, 8: 45 };
    const out = overnightMins(night('2026-10-09', { tempAt: (h) => temps[h] }), TZ);
    expect(out['2026-10-09'].minF).toBe(34);
    expect(out['2026-10-09'].endHour).toBe(8);
    expect(out['2026-10-09'].samples).toBeGreaterThan(150);
  });

  it('drops a night observed too briefly rather than publishing a number that reads like a measurement', () => {
    const short = night('2026-10-09', { from: 23, to: 0 }).slice(0, OVERNIGHT_MIN_SAMPLES - 1);
    expect(overnightMins(short, TZ)).toEqual({});
  });

  it('separates consecutive nights', () => {
    const recs = [...night('2026-10-09', { tempAt: () => 40 }), ...night('2026-10-10', { tempAt: () => 30 })];
    const out = overnightMins(recs, TZ);
    expect(out['2026-10-09'].minF).toBe(40);
    expect(out['2026-10-10'].minF).toBe(30);
  });

  it('ignores daytime records — they belong to no night', () => {
    const day = [];
    const base = Date.parse('2026-10-09T00:00:00-04:00');
    for (let h = 9; h <= 17; h++) for (let m = 0; m < 60; m += 5) day.push({ dateutc: base + (h * 60 + m) * 60000, tempf: 12 });
    const out = overnightMins([...night('2026-10-09', { tempAt: () => 40 }), ...day], TZ);
    expect(out['2026-10-09'].minF).toBe(40);   // NOT 12
    // MUTATION THIS CLOSES: dropping the `hour <= 8` guard so EVERY non-evening hour buckets as
    // dayBefore(day). The line above still passed, because the daytime records landed in a DIFFERENT
    // key (2026-10-08) that nothing asserted on. Asserting the minimum of one bucket says nothing
    // about what leaked into its neighbours.
    expect(Object.keys(out)).toEqual(['2026-10-09']);
  });

  it('skips malformed records instead of poisoning the minimum, and never throws', () => {
    const recs = [...night('2026-10-09', { tempAt: () => 40 }),
      { dateutc: NaN, tempf: -999 }, { dateutc: Date.parse('2026-10-10T03:00:00-04:00'), tempf: null },
      null, {}, { tempf: 5 }];
    expect(overnightMins(recs, TZ)['2026-10-09'].minF).toBe(40);
    for (const bad of [null, undefined, [], 'x', [null]]) expect(overnightMins(bad, TZ)).toEqual({});
    expect(overnightMins(night('2026-10-09'), null)).toEqual({});
  });
});

describe('the DURABLE write — provenance carries the minima into the stored plan', () => {
  // MUTATION THIS CLOSES: deleting the `prov.station_overnight_mins` assignment. Every test above
  // still passed, because they all test the derivation and none tests that the derived value ever
  // LEAVES the module. Same seam class as the hourly_frost delivery bug this feature already shipped
  // once: computing correctly and never travelling.
  //
  // This matters more here than for the observability copy, because the CloudWatch line is subject to
  // retention and daily_plan.items is not. This is the half of the corpus that cannot be rebuilt.
  // Written in mergeStationHydrology rather than mergeStationWeather, DELIBERATELY: handler.js:1280
  // merges both provs (`{ ...mh.prov, ...mw.prov }`) so either reaches the payload, but
  // mergeStationWeather early-returns when `wx` is null — an NWS outage — and that would drop the
  // observed minima on exactly the nights the corpus most needs them.
  const station = (nightMins) => ({
    mac: 'AA:BB', tz: TZ, fresh: true, dataAgeMin: 1, tempF: 44, nightMins,
    recentPrecipIn: 0, buckets: {}, coversLookback: true,
  });
  const merge = (nightMins) =>
    st.mergeStationHydrology({ recent_precip_in: 0, today_precip_in: 0 }, station(nightMins),
      { planDay: '2026-10-09' });

  it('writes station_overnight_mins onto prov when the station has them', () => {
    const { prov } = merge({ '2026-10-08': { minF: 34.2, samples: 168, endHour: 8 } });
    expect(prov.station_overnight_mins).toEqual({
      '2026-10-08': { minF: 34.2, samples: 168, endHour: 8 },
    });
  });

  it('omits the key entirely when there is nothing observed — never an empty placeholder', () => {
    for (const empty of [undefined, null, {}]) {
      expect(merge(empty)).not.toHaveProperty('prov.station_overnight_mins');
      expect(merge(empty).prov).not.toHaveProperty('station_overnight_mins');
    }
  });

  it('survives an NWS outage — the minima are not gated on a weather payload', () => {
    // mergeStationWeather returns early on a null wx; this path does not.
    const { prov } = merge({ '2026-10-08': { minF: 34.2, samples: 168, endHour: 8 } });
    expect(prov.station_overnight_mins['2026-10-08'].minF).toBe(34.2);
    expect(prov.station_mac).toBe('AA:BB');
  });
});
