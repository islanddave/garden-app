// V5-WXCALLOUTRENDER-001 — the display model for the daily weather cue (src/lib/weatherCue.js).
//
// THE WRITER->READER HALF IS THE POINT. The engine's computeCallout and this reader are two modules
// that have never met: the callout has had zero client consumers since it was written, so nothing
// has ever asserted that what the engine emits is what a renderer can consume. Every case below
// drives the REAL computeCallout — imported from lambda/daily-plan/engine.js, not a fixture of what
// its strings are believed to look like — so an engine copy change reds a test here instead of
// silently darkening the cue on Today via buildCueLine's fail-closed branch.
import { describe, it, expect } from 'vitest'
import engine from '../../lambda/daily-plan/engine.js'
import {
  buildCueLine, CUE_FORM, CHECK_CLAUSE, CUE_SEPARATOR, WX_CUE_MODEL_VERSION,
} from '../lib/weatherCue.js'

const { computeCallout } = engine

// Inputs chosen to reach each of computeCallout's five priority-ordered branches, and its silence
// branch. Temperatures are set past each gate rather than at it — this file is about the reader,
// and pinning the engine's own boundaries here would duplicate engine.test.js and make an engine
// retune red in two places for one reason.
const MILD = { tonightLow: 55, highToday: 70 }
const DRY = { recent_precip_in: 0.05, today_precip_in: 0, today_pop: 0, tomorrow_precip_in: 0.0, tomorrow_pop: 0 }

const CASES = {
  freeze: [{ ...MILD, tonightLow: 34 }, DRY],
  cold: [{ ...MILD, tonightLow: 43 }, DRY],
  heat: [{ ...MILD, highToday: 91 }, DRY],
  rain: [MILD, { ...DRY, tomorrow_precip_in: 0.45, tomorrow_pop: 80 }],
  wet: [MILD, { ...DRY, recent_precip_in: 0.6 }],
}

const calloutFor = (cue) => computeCallout(...CASES[cue])

describe('the engine still emits exactly the five cues this reader words', () => {
  it('each case reaches its intended branch — otherwise every assertion below is about the wrong cue', () => {
    for (const cue of Object.keys(CASES)) expect(calloutFor(cue).icon).toBe(cue)
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(CUE_FORM).sort())
  })

  it('is silent on a mild dry day — 56% of archived days, and the silence is the design', () => {
    expect(computeCallout(MILD, DRY)).toBeNull()
    expect(buildCueLine(null)).toBeNull()
  })
})

describe('condition (b) — imperative rules render in CHECK-FORM, freeze and cold do not', () => {
  it.each(['heat', 'rain', 'wet'])('%s: the engine commands, the rendered line asks', (cue) => {
    const callout = calloutFor(cue)
    const line = buildCueLine(callout)

    expect(line.form).toBe('check')
    expect(line.text).not.toBe(callout.text)
    // The condition half is the ENGINE's, verbatim — including the probability-weighted rain figure
    // DRG-WXPROB-001 computes. Only the action half is replaced.
    const condition = callout.text.slice(0, callout.text.indexOf(CUE_SEPARATOR))
    expect(condition.length).toBeGreaterThan(0)
    expect(line.text).toBe(`${condition}${CUE_SEPARATOR}${CHECK_CLAUSE[cue]}`)
    // Asks whether it was done / offers it as a check, and does not carry the imperative over.
    expect(line.text).toMatch(/\?|worth checking/)
  })

  it.each(['freeze', 'cold'])('%s stays imperative and untouched — deterministic on tonight\'s low', (cue) => {
    const callout = calloutFor(cue)
    const line = buildCueLine(callout)
    expect(line.form).toBe('imperative')
    expect(line.text).toBe(callout.text)
    expect(line.text).not.toMatch(/\?/)
  })

  it('the freeze line keeps the whole engine sentence, action clause included', () => {
    // The specific regression this guards: a check-form transform applied to every cue would strip
    // "cover or bring peppers & tomatoes in", which is the one instruction with a dead plant behind it.
    expect(buildCueLine(calloutFor('freeze')).text).toMatch(/cover or bring/)
  })
})

describe('buildCueLine fails CLOSED — it never reverts to the imperative string', () => {
  it('renders nothing for a check-form cue whose text has lost the separator', () => {
    expect(buildCueLine({ icon: 'heat', text: 'Hot day (91F) deep-water thirsty crops' })).toBeNull()
    expect(buildCueLine({ icon: 'rain', text: '' })).toBeNull()
  })

  it('renders nothing for a cue outside the closed set, so a sixth engine rule cannot ship unworded', () => {
    expect(buildCueLine({ icon: 'hail', text: 'Hail tonight — bring it all in' })).toBeNull()
    expect(buildCueLine({ text: 'no icon at all — do something' })).toBeNull()
    expect(buildCueLine(undefined)).toBeNull()
  })

  it('an imperative cue with no separator still renders — nothing is being substituted into it', () => {
    expect(buildCueLine({ icon: 'freeze', text: 'Freeze tonight' })).toEqual({
      cue: 'freeze', form: 'imperative', text: 'Freeze tonight',
    })
  })
})

describe('no threshold and no forecast-amount gate lives in the reader', () => {
  it('buildCueLine reads only icon and text — never a weather number', () => {
    // Any gate on this surface must key on probability (PoP is skilful here at the >0.10in event —
    // POD 0.727 / FAR 0.11 / BSS +0.589 — forecast AMOUNT is not, FAR 0.61). The reader keys on
    // NOTHING, which is the only way to be sure it introduced neither.
    const src = buildCueLine.toString()
    expect(src).not.toMatch(/precip|pop|tonightLow|highToday|[0-9]+\.[0-9]/)
  })

  it('pins the model version the impression rows are partitioned by', () => {
    expect(WX_CUE_MODEL_VERSION).toBe('wxcue-v1')
  })
})
