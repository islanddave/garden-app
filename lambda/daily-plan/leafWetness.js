// Foliar infection windows from Open-Meteo `precipitation_hours` (V5-LEAFWETNESS-001).
//
// Why this column: of the extra daily quantities fetched, it is the only one that carries information the
// plan does not already consume. Against `precip_in` it shares well under half its variance; the others
// (solar, sunshine, daylight, wind) are near-redundant with et0 and the calendar, or never reach a
// biological threshold here.
//
// It is a SCOUTING PROMPT, not a prediction, and copy must never imply otherwise: there is no
// disease-observation record (`loss_cause` is populated on one plant) to score it against.
//
// It is a FLOOR, not a measure of wetness. precipitation_hours misses dew, which dominates clear-cool
// September nights, so it UNDER-warns on the peak Septoria regime. Hourly `dew_point_2m` is already
// fetched (see radiativeFrost.js) but deliberately not used: a dew term changes what the cue means and
// wants its own evidence pass.
//
// NEVER TREAT precip_hours AS A DECOMPOSITION OF precip_in. They are separate instruments and they
// contradict (gauge 1.12 in over 0 modelled hours; gauge 0.01 in over 12). `precip_in` is the on-site
// Ambient station (`gauge_merged`); `precip_hours` is Open-Meteo's grid cell. Dividing one by the other
// for an intensity is meaningless.

// Septoria / late-blight / downy-mildew infection band. Below 59°F the pathogens are too slow to
// matter over a single wet period; above 80°F leaf surfaces dry fast enough that the hours-wet count
// stops meaning what it means in the band.
const INFECTION_MIN_F = 59;
const INFECTION_MAX_F = 80;

// 8 h is the conventional minimum continuous-wetness period for a Septoria infection event. 6 h was
// rejected: it fires on about a third of days, a cue nobody reads.
const WET_HOURS_MIN = 8;

// precipitation_hours is a whole-day total, so an 8 h day is NOT proven to be 8 CONTINUOUS hours —
// the classical infection period is continuous. This is the second reason the cue is a prompt to go
// and look rather than a claim about what happened.

function meanTempF(d) {
  if (!d || !Number.isFinite(d.tmax_f) || !Number.isFinite(d.tmin_f)) return null;
  return (d.tmax_f + d.tmin_f) / 2;
}

// A day qualifies on BOTH legs or neither. Missing data is never coerced: a null precip_hours is
// "unknown", not "dry" (the ingest in index.js stores an absent value as null for the same reason).
function dayQualifies(d) {
  if (!d || !Number.isFinite(d.precip_hours)) return false;
  if (d.precip_hours < WET_HOURS_MIN) return false;
  const tm = meanTempF(d);
  if (tm == null) return false;
  return tm >= INFECTION_MIN_F && tm <= INFECTION_MAX_F;
}

// `days` is the D-2..D+3 window lifted from the live Open-Meteo fetch, each {date, precip_hours,
// tmax_f, tmin_f}. `today` is the plan date. Past/future are split because they ask different things
// of the gardener: behind is "go and look at what already happened", ahead is "act before it does".
//
// The forecast half is only reachable from the in-memory fetch: `weather_daily` holds completed days
// only, so a cue built on it could not say "tomorrow".
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
