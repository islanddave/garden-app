// BUG-RAINFCSTONEMODEL-001 — the five-model day-ahead forecast exists TWICE: the engine's copy
// (lambda/daily-plan/rainForecast.js, CommonJS, feeds the watering decisions and the callout) and the client's
// (src/lib/rainForecast.js, feeds the live Today card). The card and the callout sit on adjacent lines, so the two
// must compute the same thing from the same body. This runs both on the recorded live body and on a seeded sweep
// that exercises every branch (wet/dry at the 0.01″ edge, rounding at the hundredth, missing members, missing
// days, shifted dates). Change one copy and this reds until the other matches.
import { describe, it, expect } from 'vitest'
import lambdaRf from '../../lambda/daily-plan/rainForecast.js'
import * as clientRf from '../lib/rainForecast.js'

const TODAY = '2026-09-25'
const LIVE = { daily: {
  time: ['2026-09-25', '2026-09-26', '2026-09-27'],
  precipitation_sum_gfs_global: [0, 0.37, 1.087], precipitation_sum_ecmwf_ifs025: [0, 0.846, 1.043],
  precipitation_sum_gem_seamless: [0, 0.949, 0.611], precipitation_sum_icon_seamless: [0, 0.555, 2.524],
  precipitation_sum_ncep_nbm_conus: [0, 0.165, 0.846] } }

// Deterministic PRNG so a failure reproduces.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) }
const EDGE = [0, 0.005, 0.009, 0.01, 0.011, 0.0949, 0.095, 0.2449, 0.245, 0.3, 0.4951, 0.5, 1.716, 2.31]

function body(r) {
  const shift = r() < 0.2 ? 1 : 0
  const time = ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'].slice(1 - shift)
  const daily = { time }
  for (const m of lambdaRf.RAIN_FCST_MODELS) {
    if (r() < 0.05) continue                                   // a model absent
    daily[`precipitation_sum_${m}`] = time.map(() => {
      const x = r()
      if (x < 0.03) return null                                 // a hole
      if (x < 0.5) return EDGE[Math.floor(r() * EDGE.length)]
      return Math.round(r() * 3000) / 1000
    })
  }
  return { daily }
}

describe('rainForecast — engine copy and client copy agree', () => {
  it('share the constants and the URL', () => {
    expect([...clientRf.RAIN_FCST_MODELS]).toEqual([...lambdaRf.RAIN_FCST_MODELS])
    expect(clientRf.WET_MEMBER_IN).toBe(lambdaRf.WET_MEMBER_IN)
    expect(clientRf.RAIN_FCST_SOURCE).toBe(lambdaRf.RAIN_FCST_SOURCE)
    expect(clientRf.rainForecastUrl(42.508744987687344, -72.64706648619953)).toBe(lambdaRf.rainForecastUrl(42.508744987687344, -72.64706648619953))
  })

  it('read the recorded live body identically', () => {
    const a = lambdaRf.fromOpenMeteoModels(LIVE, TODAY)
    expect(a).not.toBeNull()   // anti-vacuity: two nulls would also be "equal"
    expect(clientRf.fromOpenMeteoModels(LIVE, TODAY)).toEqual(a)
  })

  it('agree on 2,000 generated bodies, and the sweep reaches both the null and the overlay branches', () => {
    const r = rng(20260925)
    let nulls = 0, full = 0
    const hy = { recent_precip_in: 0, today_precip_in: 0, today_pop: 5, tomorrow_precip_in: 0.14, tomorrow_pop: 37, upcoming_precip_in: 1.86 }
    for (let i = 0; i < 2000; i++) {
      const b = body(r)
      const a = lambdaRf.fromOpenMeteoModels(b, TODAY)
      expect(clientRf.fromOpenMeteoModels(b, TODAY), `body ${i}`).toEqual(a)
      expect(clientRf.applyRainForecast(hy, a), `apply ${i}`).toEqual(lambdaRf.applyRainForecast(hy, a))
      a ? full++ : nulls++
    }
    expect(nulls).toBeGreaterThan(50)
    expect(full).toBeGreaterThan(500)
  })
})
