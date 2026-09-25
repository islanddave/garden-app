// BUG-RAINFCSTONEMODEL-001 — CLIENT MIRROR of lambda/daily-plan/rainForecast.js: tomorrow's and the day
// after's rain from five weather models (amount = their mean, chance = the share forecasting measurable rain),
// replacing Open-Meteo best_match for those fields only. The evidence and every rule are in the Lambda file's
// header; read it there, not here.
//
// WHY A COPY. The Today card prints the live overlay (src/lib/liveWeather.js) whenever Open-Meteo answers,
// so the engine switching alone would have left the card on the old source, beside a callout on the new one.
// The Lambda module is CommonJS and ships in its own zip; the SPA bundle does not import Lambda code. So the
// logic exists twice, and src/__tests__/rainForecastParity.test.js runs both on the same payloads — change
// one and that test reds until the other matches.

export const RAIN_FCST_MODELS = Object.freeze(['gfs_global', 'ecmwf_ifs025', 'gem_seamless', 'icon_seamless', 'ncep_nbm_conus'])
export const WET_MEMBER_IN = 0.01
export const RAIN_FCST_SOURCE = 'mean5-v1'

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100

export function rainForecastUrl(lat, lng) {
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&daily=precipitation_sum&models=${RAIN_FCST_MODELS.join(',')}` +
    '&precipitation_unit=inch&timezone=America/New_York&forecast_days=3'
}

export function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function dayFromModels(daily, date) {
  const i = Array.isArray(daily.time) ? daily.time.indexOf(date) : -1
  if (i < 0) return null
  const members = []
  for (const m of RAIN_FCST_MODELS) {
    const col = daily[`precipitation_sum_${m}`]
    const v = Array.isArray(col) ? col[i] : undefined
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null
    members.push(v)
  }
  const wet = members.filter((v) => v >= WET_MEMBER_IN).length
  return {
    date,
    precip_in: round2(members.reduce((a, v) => a + v, 0) / members.length),
    pop: Math.round((100 * wet) / members.length),
  }
}

export function fromOpenMeteoModels(json, today) {
  const daily = json && json.daily
  if (!daily || typeof daily !== 'object' || typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null
  const d1 = dayFromModels(daily, addDays(today, 1))
  const d2 = dayFromModels(daily, addDays(today, 2))
  if (!d1 || !d2) return null
  return { d1, d2, source: RAIN_FCST_SOURCE }
}

export function applyRainForecast(hy, rf) {
  if (!hy || !rf) return hy
  return {
    ...hy,
    bm_tomorrow_precip_in: hy.tomorrow_precip_in ?? null,
    bm_tomorrow_pop: hy.tomorrow_pop ?? null,
    tomorrow_precip_in: rf.d1.precip_in,
    tomorrow_pop: rf.d1.pop,
    upcoming_precip_in: round2(rf.d1.precip_in + rf.d2.precip_in),
    upcoming_pop: rf.d2.pop,
    day2_precip_in: rf.d2.precip_in,
    day2_pop: rf.d2.pop,
    day2_date: rf.d2.date,
    forecast_source: rf.source,
  }
}
