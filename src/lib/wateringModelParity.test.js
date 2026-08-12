// BUG-TODAYWATER-001 — THE ANTI-DIVERGENCE GUARD.
//
// This is the test that matters more than the fix. Today has always rendered two watering models on
// one screen: WeatherWidget's headline (computeWateringScale, this repo's src/lib) and CareNeeded's
// list (the daily-plan engine's per-planting verdicts, lambda/daily-plan/engine.js). Nothing ever
// compared them, so they drifted, and twice they straddled the same number — 0.98" on 2026-08-03 and
// 0.99" on 2026-08-08 — printing "All set — no watering needed today." above a full watering list.
//
// Two suites already existed for these modules and BOTH were green throughout: wateringScale.test.js
// and the engine goldens. Neither could see the bug, because no test crossed the module boundary.
// That is the gap this file closes. It is deliberately NOT a source-text regex over the two files
// (much of this Lambda suite asserts source text and never executes anything — that pattern would
// have passed here too, since each module's text was internally consistent). It EXECUTES both models
// over a swept grid of hydrology bags and asserts they return the same verdict on every one.
//
// Consequence, and the whole point: retuning a threshold in one module and not the other cannot be
// green. Either change wateringThresholds.json — which both modules read, so both move together —
// or this test fails.
import { describe, it, expect } from 'vitest'
import { computeWateringScale, SOAK_CAP_IN, SOAK_WET_FLOOR_IN, SOAK_FCST_QPF_IN, SOAK_FCST_POP_PCT } from './wateringScale.js'
import THRESHOLDS from '../../lambda/daily-plan/wateringThresholds.json'
import engine from '../../lambda/daily-plan/engine.js'

const { saturationSuppressed } = engine

// ── The shared source ──────────────────────────────────────────────────────────────────────────
describe('one threshold source, two consumers', () => {
  it('the engine and the widget read the SAME file, not two copies that happen to agree', () => {
    // Identity, not equality of hand-written literals: engine.js requires this JSON and re-exports
    // SOAK_CAP_IN from it, wateringScale.js imports the same path. If either reintroduces a private
    // literal, it can still pass THIS assertion only by accident of value — which is why the
    // behavioural sweep below, not this check, is the real guard.
    expect(engine.SOAK_CAP_IN).toBe(THRESHOLDS.SOAK_CAP_IN)
    expect(SOAK_CAP_IN).toBe(THRESHOLDS.SOAK_CAP_IN)
    expect(SOAK_WET_FLOOR_IN).toBe(THRESHOLDS.SOAK_WET_FLOOR_IN)
    expect(SOAK_FCST_QPF_IN).toBe(THRESHOLDS.SOAK_FCST_QPF_IN)
    expect(SOAK_FCST_POP_PCT).toBe(THRESHOLDS.SOAK_FCST_POP_PCT)
  })

  it('the shared file carries every threshold the two models gate on — no silent partial migration', () => {
    for (const k of ['SOAK_CAP_IN', 'SOAK_WET_FLOOR_IN', 'SOAK_FCST_QPF_IN', 'SOAK_FCST_POP_PCT']) {
      expect(typeof THRESHOLDS[k]).toBe('number')
      expect(Number.isFinite(THRESHOLDS[k])).toBe(true)
    }
  })
})

// ── The behavioural sweep ──────────────────────────────────────────────────────────────────────
// Build a hydrology bag the way station.mergeStationHydrology does, so today_precip_in is always
// today_observed_in + today_remaining_in. Feeding the two models an internally inconsistent bag would
// make them disagree for a reason that has nothing to do with thresholds.
const hy = (recent, observed, remaining, todayPop, tmrw, tmrwPop) => ({
  recent_precip_in: recent,
  today_observed_in: observed,
  today_remaining_in: remaining,
  today_precip_in: observed + remaining,
  today_pop: todayPop,
  tomorrow_precip_in: tmrw,
  tomorrow_pop: tmrwPop,
})

// Values chosen to sit ON, just under, and just over every bar in the model — the 0.02-class
// near-miss is exactly how this defect expressed itself twice, so the grid is dense at the edges.
const AMOUNTS = [0, 0.02, 0.49, 0.5, 0.51, 0.9, 0.97, 0.99, 1.0, 1.01, 2.5, 4.32]
const POPS = [null, 0, 28, 59, 60, 84, 92]

// The engine's verdict for an ordinary outdoor IN-GROUND planting (smallVessel:false), under the
// today-aware path — the configuration live in prod (CARE_TODAY_AWARE_ENABLED=true since the Lambda
// config update at 2026-08-11T14:07:58Z). The widget's bed lane is the surface that must agree with
// it: both answer "should an outdoor bed be watered today, given this sky?".
const engineHolds = (h) => saturationSuppressed('outdoor', h, { todayAware: true, smallVessel: false }) !== null
const widgetHoldsBeds = (h) => computeWateringScale(h, { hot: false }).beds === 0

describe('the bed lane and the engine reach the same verdict on every bag in the sweep', () => {
  it('agrees across the full measured × forecast × probability grid', () => {
    const disagreements = []
    let bags = 0
    for (const recent of AMOUNTS) {
      for (const observed of [0, 0.5, 0.9, 1.0]) {
        for (const remaining of AMOUNTS) {
          for (const todayPop of POPS) {
            for (const tmrw of [0, 0.49, 0.5, 0.74]) {
              for (const tmrwPop of POPS) {
                const h = hy(recent, observed, remaining, todayPop, tmrw, tmrwPop)
                bags++
                const e = engineHolds(h)
                const w = widgetHoldsBeds(h)
                if (e !== w) {
                  disagreements.push({ recent, observed, remaining, todayPop, tmrw, tmrwPop, engine: e, widget: w })
                }
              }
            }
          }
        }
      }
    }
    // Report the actual straddling bag, not just a count — the two incidents were each ONE number,
    // and "3 disagreements" would send the next reader back to a debugger for no reason.
    expect({ bags: bags > 20000, disagreements: disagreements.slice(0, 5) })
      .toEqual({ bags: true, disagreements: [] })
  })

  it('and specifically on the two bags that actually shipped the contradiction', () => {
    // 2026-08-08 06:01:03Z, live prod daily_plan.prior_runs: 0.02 recent + 0.97 still expected @ 28%.
    const aug8 = hy(0.02, 0, 0.97, 28, 0, 6)
    expect(engineHolds(aug8)).toBe(false)
    expect(widgetHoldsBeds(aug8)).toBe(false)

    // 2026-08-03 nightly, per todaywater-diagnosis-V100: 0.98" @ 84%. Both models now suppress —
    // they agree on the ANSWER too, not merely on each other.
    const aug3 = hy(0, 0, 0.98, 84, 0, 1)
    expect(engineHolds(aug3)).toBe(true)
    expect(widgetHoldsBeds(aug3)).toBe(true)
  })

  it('a missing recent_precip_in bails on BOTH sides — uncertainty resolves toward watering', () => {
    const blind = { recent_precip_in: null, today_precip_in: 4.32, today_pop: 92, tomorrow_precip_in: 0.74, tomorrow_pop: 63 }
    expect(engineHolds(blind)).toBe(false)
    expect(widgetHoldsBeds(blind)).toBe(false)
  })
})

describe('containers are exempt from forecast-based suppression — the deliberate, asymmetric difference', () => {
  // Decision 3 (Dave, 2026-08-12): a pot catches rain only over its own footprint and a mature canopy
  // sheds water away from it, so a PREDICTION may never suppress a container. This is the one place
  // the widget's two lanes are allowed to differ, and it differs in the safe direction: a false WATER
  // on a free-draining bag costs nothing, a false SKIP in August aborts flowers within 24h.
  //
  // Asserted as a property over the whole grid rather than one example, so the exemption cannot be
  // eroded by a later edit that only happens to keep one case working.
  it('no forecast, at any amount or probability, ever zeroes the container lane', () => {
    const offenders = []
    for (const remaining of AMOUNTS) {
      for (const todayPop of POPS) {
        for (const tmrw of [0, 0.5, 0.74, 4.0]) {
          for (const tmrwPop of POPS) {
            // recent 0 and observed 0 => not one drop has been MEASURED. Everything below is forecast.
            const h = hy(0, 0, remaining, todayPop, tmrw, tmrwPop)
            const { containers } = computeWateringScale(h, { hot: false })
            if (containers !== 2) offenders.push({ remaining, todayPop, tmrw, tmrwPop, containers })
          }
        }
      }
    }
    expect(offenders.slice(0, 5)).toEqual([])
  })

  it('MEASURED rain still governs containers — the exemption is from the forecast, not from rain', () => {
    // The complement, and the reason this is agronomy rather than a loophole.
    expect(computeWateringScale(hy(0, 1.0, 0, 92, 0, 0), { hot: false }).containers).toBe(0)
    expect(computeWateringScale(hy(1.0, 0, 0, 0, 0, 0), { hot: false }).containers).toBe(0)
    expect(computeWateringScale(hy(0.5, 0, 0, 0, 0, 0), { hot: false }).containers).toBe(1)
  })
})
