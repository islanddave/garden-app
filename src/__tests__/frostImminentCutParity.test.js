// V5-TODAYFROSTLINEGAPS-001 residue G3 — the imminent trip point sits under the freeze cue (PARITY).
//
// A threshold "Frost protect tonight" email is sent when tonight's low is AT OR BELOW the Lambda's imminent trip
// (frostEval.js evalImminent `low <= T.IMMINENT_LOW_F`, 38 by default; per crop band in frostClass.js). Today says
// nothing of its own about that email: the weather cue's "Freeze tonight" covers it while the low is under
// FREEZE_BELOW_F (40, engine computeCallout `low < 40`), and once the plan low is at or above it frostAlertLine.js
// prints "Forecast warmed to N°F since the … frost email." The two meet with no hole only while every trip point
// is BELOW the cut.
//
// WHAT BREAKS IF THIS REDS. Someone raised FROST_IMMINENT_LOW_F's default (or a band's), or lowered
// FREEZE_BELOW_F. Then there is a band of lows, from the cut up to the trip point, where the email has gone out
// and the forecast has not moved: the cue reads "Cool night", not "Freeze tonight"; the warmed line does not
// print, because nothing warmed; and Today is silent about a frost email Dave is holding. Fix the constant, or
// give that band a line, before moving either number.
//
// ADVISORY_TRIP_F has the same kind of test (frostWatchLine.test.jsx, "PARITY"); this is the imminent tier's.
// A Lambda env override (the rehearsal's raised trip) is out of reach of a unit test: this holds the SHIPPED
// defaults, which is what a real, un-forced email is sent at.
import { describe, it, expect } from 'vitest'
import { buildFrostAlertLines, FREEZE_BELOW_F } from '../lib/frostAlertLine.js'
import { PLAN_DATE, imminent, planFor } from './helpers/twoLowsFixtures.js'
import frostEval from '../../lambda/daily-plan/frostEval.js'
import frostClass from '../../lambda/daily-plan/frostClass.js'

const WARMED = /^Forecast warmed to [\d.]+°F since the 3 PM frost email\.$/
// handler-shaped threshold imminent entry (frostWeatherFacts), sent on the 3 PM ET run.
const thr = (lowF) => ({ ...imminent(lowF), run: 'intraday-pm', at: `${PLAN_DATE}T19:00:00.000Z` })
// Every imminent trip the Lambda can send a threshold email at: the site-level one and each crop band's.
const trips = () => {
  const bands = Object.entries(frostClass.resolveBandThresholds()).filter(([, t]) => t)
  return [['site', frostEval.resolveThresholds().IMMINENT_LOW_F], ...bands.map(([b, t]) => [`band ${b}`, t.IMMINENT_LOW_F])]
}

describe('FROST_IMMINENT_LOW_F sits under the freeze cue (PARITY)', () => {
  it('reads the shipped defaults: no env override is in play', () => {
    for (const k of ['FROST_IMMINENT_LOW_F', 'FROST_BAND_THRESHOLDS_JSON', 'FROST_THRESHOLD_OFFSET_F']) {
      expect(process.env[k], k).toBeUndefined()
    }
    const all = trips()
    expect(all.length).toBeGreaterThan(2)                           // the site trip and more than one band
    for (const [name, t] of all) expect(Number.isFinite(t), name).toBe(true)
  })

  it('no imminent trip point exceeds the page\'s cut', () => {
    for (const [name, t] of trips()) expect(t, name).toBeLessThanOrEqual(FREEZE_BELOW_F)
    expect(Math.max(...trips().map(([, t]) => t))).toBe(frostEval.resolveThresholds().IMMINENT_LOW_F)
  })

  // The same property, on the real cue and the real line. This one is strict where the comparison above is not:
  // the email fires AT the trip point (`<=`) and the cue freezes only BELOW the cut (`<`), so a trip point equal
  // to the cut would leave that one whole-degree low uncovered.
  it('NO HOLE: an email sent at any trip point is on Today at every plan low from there up, as the cue or the warmed line', () => {
    for (const [name, t] of trips()) {
      for (let tenths = Math.round(t * 10); tenths <= 500; tenths++) {
        const low = tenths / 10
        const cue = planFor(low, []).weather.callout
        const lines = buildFrostAlertLines([thr(t)], { planLow: low }).map((l) => l.text)
        const freezes = !!cue && cue.icon === 'freeze'
        expect(freezes || lines.length === 1, `${name}: email at ${t}°F, plan low now ${low}°F`).toBe(true)
        for (const text of lines) expect(text, `${name} @ ${low}`).toMatch(WARMED)
        // ...and never both: the warmed line starts exactly where the cue lets go.
        expect(freezes && lines.length > 0, `${name} @ ${low}: cue and warmed line together`).toBe(false)
      }
    }
  })
})
