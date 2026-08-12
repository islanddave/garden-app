// BUG-TODAYWATER-001 (2026-08-12) — this suite was rewritten against the HARMONIZED model.
// computeWateringScale no longer owns thresholds; it imports them from the same
// lambda/daily-plan/wateringThresholds.json the engine requires, and it reproduces the engine's
// three suppression branches instead of its own 0.8"/0.3"/no-PoP set. Every expectation that moved
// is annotated with why. All movement is in the same direction — toward WATERING — because the
// engine is the more conservative model and containers are now exempt from forecast suppression.
import { describe, it, expect } from 'vitest'
import {
  computeWateringScale, canRail, pillState, measuredWater, todayForecastIn,
  SOAK_CAP_IN, SOAK_WET_FLOOR_IN, SOAK_FCST_QPF_IN, SOAK_FCST_POP_PCT,
} from './wateringScale.js'

describe('computeWateringScale', () => {
  it("a DRY bed with rain coming tomorrow is watered today (the engine's wet-floor prerequisite)", () => {
    // WAS: containers 2, beds 0 — the widget zeroed beds on its private "0.3\" at 50%" bar with no
    // regard for whether the media was already wet. The engine requires BOTH: already moist
    // (windowPrecip >= SOAK_WET_FLOOR_IN) AND >= SOAK_FCST_QPF_IN more coming. The reasoning is a
    // drying window — wet soil plus more rain has none; dry soil plus rain tomorrow is just dry soil
    // today. windowPrecip here is 0.05, so nothing is suppressed and the bed gets watered.
    const s = computeWateringScale(
      { recent_precip_in: 0.05, tomorrow_precip_in: 0.74, tomorrow_pop: 63, rain_coming: true },
      { hot: false, highToday: 78 },
    )
    expect(s.containers).toBe(2)
    expect(s.beds).toBe(1.5)
    expect(s.rainComing).toBe(false)
  })

  it("honours the engine's incoming branch once the media IS already wet", () => {
    // The same tomorrow forecast, now on top of 0.6" that actually fell: wet + more coming = no
    // drying window = hold the beds. Containers only ease by one can — measured 0.6 is over
    // SOAK_WET_FLOOR_IN but under SOAK_CAP_IN — and are never zeroed by the forecast half.
    const s = computeWateringScale(
      { recent_precip_in: 0.6, tomorrow_precip_in: 0.6, tomorrow_pop: 70 },
      { hot: false },
    )
    expect(s.beds).toBe(0)
    expect(s.containers).toBe(1)
    expect(s.rainComing).toBe(true)
  })

  it('hot + dry deep-soaks both lanes', () => {
    const s = computeWateringScale({ recent_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 }, { hot: true })
    expect(s.containers).toBe(3)
    expect(s.beds).toBe(2.5)
  })

  it('MEASURED rain at SOAK_CAP_IN zeroes both lanes — the one thing that still zeroes containers', () => {
    const s = computeWateringScale({ recent_precip_in: SOAK_CAP_IN }, { hot: false })
    expect(s.containers).toBe(0)
    expect(s.beds).toBe(0)
  })

  it('just under SOAK_CAP_IN no longer zeroes anything (was 0.8 here, and that was half the defect)', () => {
    // 0.9" is the exact band that produced "All set — no watering needed today." over a full list on
    // 2026-08-03 and 2026-08-08: over the widget's old 0.8 bar, under the engine's 1.0 cap. The two
    // models now share one number, so this band cannot exist.
    const s = computeWateringScale({ recent_precip_in: 0.9 }, { hot: false })
    expect(s.containers).toBe(1)
    expect(s.beds).toBe(0.5)
    expect(pillState(s.containers)).toBe('do')
    expect(pillState(s.beds)).toBe('do')
  })

  it('clamps to [0,3] and rounds to nearest 0.5', () => {
    const s = computeWateringScale({ recent_precip_in: 0 }, { hot: true })
    expect(s.containers).toBeLessThanOrEqual(3)
    expect(s.beds % 0.5).toBe(0)
  })

  it('heavy rain FORECAST today holds the beds but leaves containers fully watered', () => {
    // WAS: containers 0. This is BUG-TODAYWATER-001 decision 3 — a pot catches rain only over its own
    // footprint and a canopy sheds water away from it, so a prediction may not suppress a container.
    // Beds present the whole bed area to the sky, so the forecast does hold them.
    const s = computeWateringScale(
      { recent_precip_in: 0, today_precip_in: 0.9, today_pop: 90, tomorrow_precip_in: 0 },
      { hot: false },
    )
    expect(s.beds).toBe(0)
    expect(s.containers).toBe(2)
    expect(s.rainToday).toBe(true)
  })

  it('the same heavy rain, once MEASURED by the gauge, does zero the containers', () => {
    // The complement of the test above, and the reason the split is honest rather than a dodge:
    // containers are exempt from the FORECAST, not from rain. 1.1" on the gauge is water in the bag.
    const s = computeWateringScale(
      { recent_precip_in: 0, today_precip_in: 1.1, today_observed_in: 1.1, today_remaining_in: 0, today_pop: 90 },
      { hot: false },
    )
    expect(s.containers).toBe(0)
    expect(s.beds).toBe(0)
  })

  it('a forecast amount below SOAK_FCST_QPF_IN suppresses nothing at all', () => {
    // WAS: beds 0, containers 1 on a 0.4" forecast. 0.4 is under the engine's bar, so it is not a
    // reason to skip anything.
    const s = computeWateringScale(
      { recent_precip_in: 0, today_precip_in: 0.4, today_pop: 80, tomorrow_precip_in: 0 },
      { hot: false },
    )
    expect(s.beds).toBe(1.5)
    expect(s.containers).toBe(2)
    expect(s.rainToday).toBe(false)
  })

  it('the PoP gate: a qualifying AMOUNT at a low chance suppresses nothing (08-08, verbatim)', () => {
    // Live prod, daily_plan.prior_runs, 2026-08-08 06:01:03Z. 0.97" at 28% — over every amount bar,
    // nowhere near the probability bar. The old widget had NO PoP gate, so it zeroed both lanes and
    // printed "All set" above 78 listed plantings. This single assertion is the defect.
    const s = computeWateringScale(
      { recent_precip_in: 0.02, today_precip_in: 0.97, today_observed_in: 0, today_remaining_in: 0.97, today_pop: 28, tomorrow_precip_in: 0, tomorrow_pop: 6 },
      { hot: false },
    )
    expect(s.beds).toBe(1.5)
    expect(s.containers).toBe(2)
    expect(s.rainToday).toBe(false)
    expect(s.rainComing).toBe(false)
  })

  it('a null today PoP fails CLOSED toward watering; a null tomorrow PoP stays permissive', () => {
    // Both directions mirror the engine deliberately. Open-Meteo really does omit today_pop, and
    // unknown probability is a data problem, not a certainty — but tomorrow gets re-evaluated
    // overnight before anyone acts on it, so there the permissive branch is tolerable.
    const todayNullPop = computeWateringScale(
      { recent_precip_in: 0, today_precip_in: 2.0, today_pop: null, tomorrow_precip_in: 0 }, { hot: false })
    expect(todayNullPop.beds).toBe(1.5)
    expect(todayNullPop.rainToday).toBe(false)

    const tmrwNullPop = computeWateringScale(
      { recent_precip_in: 0.6, today_precip_in: 0, today_pop: 0, tomorrow_precip_in: 0.6, tomorrow_pop: null }, { hot: false })
    expect(tmrwNullPop.beds).toBe(0)
    expect(tmrwNullPop.rainComing).toBe(true)
  })

  it('rain_coming off the plan is NOT honoured as a lane override', () => {
    // The engine emits rain_coming on a 0.3"/50% bar for DISPLAY only — it reaches no engine gate.
    // Letting it zero a lane would smuggle a third threshold set into the module whose entire defect
    // was owning more than one. Dry media, rain_coming true, and the beds still get watered.
    const s = computeWateringScale(
      { recent_precip_in: 0, today_precip_in: 0.1, today_pop: 55, tomorrow_precip_in: 0.35, tomorrow_pop: 55, rain_coming: true },
      { hot: false },
    )
    expect(s.beds).toBe(1.5)
    expect(s.containers).toBe(2)
  })
})

describe('measuredWater / todayForecastIn — the actuals-vs-forecast split', () => {
  it('measuredWater counts recent actuals plus what the gauge has already caught today', () => {
    expect(measuredWater({ recent_precip_in: 0.3, today_observed_in: 0.4 })).toBeCloseTo(0.7)
  })

  it('degrades to recent-only on a plan with no bound station (today_observed_in absent)', () => {
    // Not a bug: with no gauge the whole D0 term is a forecast, and it is judged as one below.
    expect(measuredWater({ recent_precip_in: 0.3, today_precip_in: 4.32 })).toBeCloseTo(0.3)
  })

  it('todayForecastIn prefers the REMAINDER, and a real 0 remaining does not fall back', () => {
    // `??` not `||`. A gauge reporting "0.9 fell, nothing more expected" must not be re-read as 0.9
    // still coming — that would double-count the measured share under a probability gate.
    expect(todayForecastIn({ today_remaining_in: 0, today_precip_in: 0.9 })).toBe(0)
    expect(todayForecastIn({ today_precip_in: 0.9 })).toBe(0.9)
    expect(todayForecastIn({})).toBe(0)
  })
})

describe('thresholds are imported, not owned', () => {
  it('re-exports the shared constants so a drift guard can compare them', () => {
    expect(SOAK_CAP_IN).toBe(1.0)
    expect(SOAK_WET_FLOOR_IN).toBe(0.5)
    expect(SOAK_FCST_QPF_IN).toBe(0.5)
    expect(SOAK_FCST_POP_PCT).toBe(60)
  })
})

describe('canRail', () => {
  it('fills cans left-to-right with a half step', () => {
    expect(canRail(0)).toEqual([0, 0, 0])
    expect(canRail(1.5)).toEqual([1, 0.5, 0])
    expect(canRail(3)).toEqual([1, 1, 1])
  })
})

describe('pillState', () => {
  it('0 -> wait, >=0.5 -> do', () => {
    expect(pillState(0)).toBe('wait')
    expect(pillState(0.5)).toBe('do')
    expect(pillState(2)).toBe('do')
  })
})
