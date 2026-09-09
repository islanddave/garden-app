// V5-LEAFWETNESS-001 — foliar infection windows from precipitation_hours.
//
// WHY THIS COLUMN AND NOT THE OTHER FOUR. `precipitation_hours` was one of five quantities added to
// the Open-Meteo daily fetch 2026-09-07 and read by nothing. A correlation pass over the 122 stored
// days (2026-05-10..2026-09-08) found it is the ONLY one carrying substantial information the plan
// did not already consume: r=+0.650 / R²=0.42 against `precip_in`, i.e. 58% of its variance is in no
// column the engine reads. The other four are near-redundant here — solar_mj_m2 is R²=0.874 against
// et0_in (a one-term fit reproduces et0 to sd 0.021 in/day against a 0.174 mean), sunshine_s is
// R²=0.876 against solar_mj_m2, daylight_s is the calendar, and wind_max_mph never exceeded
// 19.4 mph in 122 days so it never crosses a biological threshold at this site. Surfacing those four
// would add numbers, not information.
//
// WHAT IT IS AND IS NOT. Hours-wet inside a temperature band is the classical infection-period shape
// for Septoria leaf spot, late blight and basil downy mildew — the pathogens that actually end a
// tomato block at 42.5°N. It is a SCOUTING PROMPT, not a prediction, and the copy must never imply
// otherwise: `loss_cause` is populated on exactly ONE plant in the whole database, so there is no
// disease-observation record to score this against. It ships unfalsifiable. That is a real limit,
// stated rather than hidden.
//
// IT IS A FLOOR, NOT A MEASUREMENT OF WETNESS. precipitation_hours misses DEW, and dew dominates
// September leaf wetness here — 2026-09-07 (tmin 45.6°F, 11.1 h sunshine, 0 precip hours) almost
// certainly carried heavy dew and scores bone dry. So this UNDER-warns on the clear-cool-night
// regime that is peak Septoria weather. The fix needs no new capture: hourly `dew_point_2m` is
// already fetched (radiativeFrost.js:108). Deliberately NOT included in this first cut — a dew term
// changes what the cue means and wants its own evidence pass.
//
// NEVER TREAT precip_hours AS A DECOMPOSITION OF precip_in. They are separate instruments and they
// contradict: 2026-09-02 gauge 1.12 in over 0 modelled hours; 2026-09-05 gauge 0.01 in over 12
// modelled hours. `precip_in` is the on-site Ambient station (`gauge_merged`); `precip_hours` is
// Open-Meteo's grid cell. Dividing one by the other to get an intensity is meaningless, and a
// readout juxtaposing them renders "1.12 in of rain over 0 hours". Both seats that looked at this
// reached that conclusion independently.

// Septoria / late-blight / downy-mildew infection band. Below 59°F the pathogens are too slow to
// matter over a single wet period; above 80°F leaf surfaces dry fast enough that the hours-wet count
// stops meaning what it means in the band.
const INFECTION_MIN_F = 59;
const INFECTION_MAX_F = 80;

// 8 h is the conventional minimum continuous-wetness period for a Septoria infection event. Measured
// against the live archive it selects 28 of 122 days (23%); the 6 h variant selects 41 (34%). 8 was
// chosen because 6 fires on a third of all days, which is a cue nobody reads.
const WET_HOURS_MIN = 8;

// precipitation_hours is a whole-day total, so an 8 h day is NOT proven to be 8 CONTINUOUS hours —
// the classical infection period is continuous. This is the second reason the cue is a prompt to go
// and look rather than a claim about what happened.

function meanTempF(d) {
  if (!d || !Number.isFinite(d.tmax_f) || !Number.isFinite(d.tmin_f)) return null;
  return (d.tmax_f + d.tmin_f) / 2;
}

// A day qualifies on BOTH legs or neither. Missing data is never coerced: a null precip_hours is
// "unknown", not "dry" — the same rule the ingest applies at index.js, where an absent value is
// stored null precisely because 0 hours is a real dry day and would be indistinguishable.
function dayQualifies(d) {
  if (!d || !Number.isFinite(d.precip_hours)) return false;
  if (d.precip_hours < WET_HOURS_MIN) return false;
  const tm = meanTempF(d);
  if (tm == null) return false;
  return tm >= INFECTION_MIN_F && tm <= INFECTION_MAX_F;
}

// `days` is the D-2..D+3 window lifted from the live Open-Meteo fetch, each {date, precip_hours,
// tmax_f, tmin_f}. `today` is the plan date. Past/future are split because they ask different things
// of Dave: behind him is "go and look at what already happened", ahead is "act before it does".
//
// The forecast half is only reachable from the in-memory fetch — `weather_daily` stores COMPLETED
// days and has no future rows at all, and by design never even holds today. A cue built on that
// table could not say "tomorrow".
function assessLeafWetness(days, today) {
  if (!Array.isArray(days) || !days.length || !today) return null;
  const behind = [];
  const ahead = [];
  for (const d of days) {
    if (!d || !d.date) continue;
    if (!dayQualifies(d)) continue;
    if (d.date < today) behind.push(d.date);
    else if (d.date > today) ahead.push(d.date);
    else behind.push(d.date); // today counts as observed-so-far, not forecast
  }
  if (!behind.length && !ahead.length) return null;
  return {
    recent_wet_days: behind.length,
    ahead_wet_days: ahead.length,
    recent_dates: behind,
    ahead_dates: ahead,
    wet_hours_min: WET_HOURS_MIN,
    band_f: [INFECTION_MIN_F, INFECTION_MAX_F],
    basis: 'modelled_precip_hours',
  };
}

module.exports = {
  assessLeafWetness,
  dayQualifies,
  meanTempF,
  INFECTION_MIN_F,
  INFECTION_MAX_F,
  WET_HOURS_MIN,
};
