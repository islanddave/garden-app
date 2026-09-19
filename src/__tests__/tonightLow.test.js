// V5-FROSTTWOMODELS-001 — one low per night on Today: the pure half (src/lib/tonightLow.js and the
// four modules that consume it). The Today mount is TodayTwoLows.test.jsx.
//
// Every plan here comes out of the REAL engine (helpers/twoLowsFixtures.js): the stored callout is
// computeCallout's, the Protect bucket is coldFor's. The PARITY block is the guard the design leans on
// — agreeCallout carries a COPY of computeCallout's freeze/cold wording, and a copy is only safe while
// something reds the moment the two drift.
import { describe, it, expect, vi } from 'vitest'
import {
  agreedTonightLow, agreeCallout, withoutLowClause, AGREED_CUE_MODEL_VERSION,
} from '../lib/tonightLow.js'
import { buildFrostAlertLine } from '../lib/frostAlertLine.js'
import { buildCueLine, WX_CUE_MODEL_VERSION } from '../lib/weatherCue.js'
import { sendCueImpression, CUE_IMPRESSIONS_PATH } from '../lib/weatherCueImpressions.js'
import { buildCareNeeded } from '../lib/careNeeded.js'
import {
  ROWS, GRID_LOWS, GRID_ENTRIES, DRY, planFor, coldBucket, deepFreeze, tonight, tomorrowNight, imminent,
  computeCallout, freezeText, coldText, BRING, OPTIONAL, TROPICAL,
} from './helpers/twoLowsFixtures.js'

// What Today prints, composed from the same calls Today.jsx makes. `card` is what the moon figure
// prints (WeatherWidget: lowShown ?? weather.tonightLow) — the DOM itself is asserted in the mount file.
function after(plan) {
  const agreed = agreedTonightLow(plan)
  const cue = buildCueLine(agreeCallout(plan.weather?.callout, agreed))
  const line = buildFrostAlertLine(plan.alerts_sent, { lowShown: agreed?.lowF })
  const shown = agreed?.lowF ?? plan.weather?.tonightLow
  return {
    card: shown == null ? '' : String(shown),
    cue: cue ? cue.text : null,
    line: line ? line.text : null,
    protect: buildCareNeeded(plan).filter((r) => r.need === 'cold').map((r) => r.reason),
    cueLine: cue,
  }
}
// What the page printed at the base commit: the engine callout, the one-argument line, raw reasons.
function before(plan) {
  const cue = buildCueLine(plan.weather?.callout)
  const line = buildFrostAlertLine(plan.alerts_sent)
  const low = plan.weather?.tonightLow
  return {
    card: low == null ? '' : String(low),
    cue: cue ? cue.text : null,
    line: line ? line.text : null,
    protect: (plan.cold || []).map((it) => it.text),
  }
}
async function billedModel(cueLine) {
  if (!cueLine) return null
  const apiFetch = vi.fn(async () => ({ accepted: 1 }))
  await sendCueImpression(apiFetch, cueLine, null)
  expect(apiFetch).toHaveBeenCalledTimes(1)
  expect(apiFetch.mock.calls[0][0]).toBe(CUE_IMPRESSIONS_PATH)
  return JSON.parse(apiFetch.mock.calls[0][1].body).model_version
}

describe('the spec table — rows 1-12, before -> after (plan date Fri 2026-10-09)', () => {
  it.each(ROWS.map((r) => [r.n, r]))('row %i', async (_n, row) => {
    const plan = planFor(row.low, row.entries, row.hy)
    expect(before(plan)).toEqual(row.before)
    const a = after(plan)
    expect({ card: a.card, cue: a.cue, line: a.line, protect: a.protect })
      .toEqual({ card: row.after.card, cue: row.after.cue, line: row.after.line, protect: row.after.protect })
    expect(await billedModel(a.cueLine)).toBe(row.after.model)
  })

  it('the impression rows the spec names: 2 agreed, 4 and 12 wxcue-v1, 1/7/10 none', () => {
    const model = (n) => ROWS.find((r) => r.n === n).after.model
    expect(model(2)).toBe(AGREED_CUE_MODEL_VERSION)
    expect(AGREED_CUE_MODEL_VERSION).toBe('wxcue-v1-agreed')
    expect([model(4), model(12)]).toEqual([WX_CUE_MODEL_VERSION, WX_CUE_MODEL_VERSION])
    expect([model(1), model(7), model(10)]).toEqual([null, null, null])
  })

  it('row 2 bills freeze / imperative / wxcue-v1-agreed', async () => {
    const a = after(planFor(43, [tonight(37.6)]))
    expect(a.cueLine).toMatchObject({ cue: 'freeze', form: 'imperative', modelVersion: 'wxcue-v1-agreed' })
    const apiFetch = vi.fn(async () => ({}))
    await sendCueImpression(apiFetch, a.cueLine, '2026-10-09T19:10:00.000Z')
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({
      cue: 'freeze', form: 'imperative', model_version: 'wxcue-v1-agreed', plan_generated_at: '2026-10-09T19:10:00.000Z',
    })
  })
})

describe('agreedTonightLow — the trigger and the shared low', () => {
  it('fires only when the frost line names TONIGHT, and takes the colder low in both directions', () => {
    expect(agreedTonightLow(planFor(55, [tonight(37.6)]))).toEqual({ lowF: 38, lowRaw: 37.6 })
    expect(agreedTonightLow(planFor(36, [tonight(37.6)]))).toEqual({ lowF: 36, lowRaw: 36 })
    expect(agreedTonightLow(planFor(37.8, [tonight(37.6)]))).toEqual({ lowF: 38, lowRaw: 37.6 })
    // NEAR-MISS CONTROLS, one field each: the same entry naming tomorrow night, an imminent entry,
    // and no entry at all — the plan low stays the plan low.
    expect(agreedTonightLow(planFor(55, [tonight(37.6, { nightOffset: 1 })]))).toBeNull()
    expect(agreedTonightLow(planFor(55, [tomorrowNight(36.4)]))).toBeNull()
    expect(agreedTonightLow(planFor(36, [imminent(36)]))).toBeNull()
    expect(agreedTonightLow(planFor(43, []))).toBeNull()
    expect(agreedTonightLow(null)).toBeNull()
  })

  it('a weekday night never triggers', () => {
    const wed = tonight(31, { dayOffset: 3, date: '2026-10-12', nightOffset: 3 })
    expect(buildFrostAlertLine([wed]).text).toMatch(/^Frost possible Monday night/)
    expect(agreedTonightLow(planFor(55, [wed]))).toBeNull()
  })

  it('a missing plan low leaves the line\'s own low', () => {
    expect(agreedTonightLow(planFor(null, [tonight(37.6)]))).toEqual({ lowF: 38, lowRaw: 37.6 })
    expect(agreedTonightLow({ alerts_sent: [tonight(37.6)] })).toEqual({ lowF: 38, lowRaw: 37.6 })
    expect(agreedTonightLow({ weather: { tonightLow: '' }, alerts_sent: [tonight(37.6)] })).toEqual({ lowF: 38, lowRaw: 37.6 })
    // A numeric string is read the way frostAlertLine reads an entry's lowF.
    expect(agreedTonightLow({ weather: { tonightLow: '36' }, alerts_sent: [tonight(37.6)] })).toEqual({ lowF: 36, lowRaw: 36 })
  })

  it('follows whichever line renders: the most recently SENT advisory decides the night', () => {
    const t = tonight(37.6, { at: '2026-10-09T19:05:00.000Z' })
    const m = tomorrowNight(36.4, { at: '2026-10-09T20:05:00.000Z' })
    expect(buildFrostAlertLine([t, m]).nightOffset).toBe(1)
    expect(agreedTonightLow(planFor(55, [t, m]))).toBeNull()
    const later = tonight(37.6, { at: '2026-10-09T21:05:00.000Z' })
    expect(agreedTonightLow(planFor(55, [m, later]))).toEqual({ lowF: 38, lowRaw: 37.6 })
  })

  it('an entry stored before nightOffset existed triggers exactly when its line says "tonight"', () => {
    const legacy = tonight(37.6)
    delete legacy.nightOffset
    expect(buildFrostAlertLine([legacy]).text).toMatch(/^Frost possible tonight/)
    expect(agreedTonightLow(planFor(55, [legacy]))).toEqual({ lowF: 38, lowRaw: 37.6 })
    const legacyD2 = tomorrowNight(36.4)
    delete legacyD2.nightOffset
    expect(buildFrostAlertLine([legacyD2]).text).toMatch(/^Frost possible tomorrow night/)
    expect(agreedTonightLow(planFor(55, [legacyD2]))).toBeNull()
  })
})

describe('agreeCallout — the cue', () => {
  it('rounding never softens freeze into cold: the split is on the RAW low (plan low 39.6 -> freeze, "(40°F)")', () => {
    const plan = planFor(39.6, [tonight(40)])
    expect(plan.weather.callout).toEqual({ icon: 'freeze', text: freezeText(39.6) })
    const agreed = agreedTonightLow(plan)
    expect(agreed).toEqual({ lowF: 40, lowRaw: 39.6 })
    expect(agreeCallout(plan.weather.callout, agreed)).toEqual({ icon: 'freeze', text: freezeText(40), modelVersion: AGREED_CUE_MODEL_VERSION })
  })

  it('cold becomes freeze below 40, and stays cold at 40 and above', () => {
    const cold = computeCallout({ tonightLow: 43, highToday: 70 }, DRY)
    expect(cold.icon).toBe('cold')
    expect(agreeCallout(cold, { lowF: 38, lowRaw: 37.6 })).toEqual({ icon: 'freeze', text: freezeText(38), modelVersion: AGREED_CUE_MODEL_VERSION })
    expect(agreeCallout(cold, { lowF: 40, lowRaw: 40 })).toEqual({ icon: 'cold', text: coldText(40), modelVersion: AGREED_CUE_MODEL_VERSION })
    expect(agreeCallout(cold, { lowF: 42, lowRaw: 42 })).toEqual({ icon: 'cold', text: coldText(42), modelVersion: AGREED_CUE_MODEL_VERSION })
  })

  it('an unchanged cue comes back as the SAME object, un-billed as agreed', () => {
    const freeze = computeCallout({ tonightLow: 36, highToday: 70 }, DRY)
    expect(agreeCallout(freeze, { lowF: 36, lowRaw: 36 })).toBe(freeze)
    expect(agreeCallout(freeze, null)).toBe(freeze)
  })

  it('a silent cue stays silent and heat/rain/wet are untouched (Q1: no)', () => {
    const agreed = { lowF: 38, lowRaw: 37.6 }
    expect(agreeCallout(null, agreed)).toBeNull()
    expect(agreeCallout(undefined, agreed)).toBeUndefined()
    for (const [w, hy] of [
      [{ tonightLow: 55, highToday: 91 }, DRY],
      [{ tonightLow: 55, highToday: 70 }, { ...DRY, tomorrow_precip_in: 0.45, tomorrow_pop: 80 }],
      [{ tonightLow: 55, highToday: 70 }, { ...DRY, recent_precip_in: 0.6 }],
    ]) {
      const c = computeCallout(w, hy)
      expect(['heat', 'rain', 'wet']).toContain(c.icon)
      expect(agreeCallout(c, agreed)).toBe(c)
    }
  })

  it('an inconsistent payload (agreed low above the cold band) keeps the engine\'s cue', () => {
    const cold = computeCallout({ tonightLow: 43, highToday: 70 }, DRY)
    expect(agreeCallout(cold, { lowF: 46, lowRaw: 46 })).toBe(cold)
  })

  it('never writes to what it is given', () => {
    const plan = deepFreeze(planFor(43, [tonight(37.6)]))
    const agreed = deepFreeze(agreedTonightLow(plan))
    expect(() => agreeCallout(plan.weather.callout, agreed)).not.toThrow()
    expect(plan.weather.callout).toEqual({ icon: 'cold', text: coldText(43) })
  })
})

describe('PARITY — agreeCallout words freeze/cold exactly as the REAL engine computeCallout', () => {
  // A freeze input and a cold input: the agreed words depend only on the agreed low.
  const INPUTS = [computeCallout({ tonightLow: 30, highToday: 70 }, DRY), computeCallout({ tonightLow: 44, highToday: 70 }, DRY)]

  it('for every whole-degree low 20..44, the words deep-equal computeCallout({tonightLow:L, highToday:70}, dry)', () => {
    expect(INPUTS.map((c) => c.icon)).toEqual(['freeze', 'cold'])   // control: both branches are inputs
    let n = 0
    for (let L = 20; L <= 44; L++) {
      const engineOut = computeCallout({ tonightLow: L, highToday: 70 }, DRY)
      for (const input of INPUTS) {
        const { modelVersion, ...words } = agreeCallout(input, { lowF: L, lowRaw: L })
        expect(words, `L=${L} from ${input.icon}`).toStrictEqual(engineOut)
        expect(modelVersion, `L=${L} from ${input.icon}`).toBe(words.text === input.text ? undefined : AGREED_CUE_MODEL_VERSION)
        n++
      }
    }
    expect(n).toBe(50)
  })

  it('the engine\'s freeze/cold band ends at 45, where the copy\'s does', () => {
    for (let L = 45; L <= 50; L++) {
      expect(computeCallout({ tonightLow: L, highToday: 70 }, DRY)).toBeNull()
      expect(agreeCallout(INPUTS[1], { lowF: L, lowRaw: L })).toBe(INPUTS[1])
    }
  })

  it('the split keys on the RAW low exactly as the engine\'s does — every tenth of a degree 20.0..44.9', () => {
    for (let t = 200; t < 450; t++) {
      const raw = t / 10
      const engineIcon = computeCallout({ tonightLow: raw, highToday: 70 }, DRY).icon
      for (const input of INPUTS) expect(agreeCallout(input, { lowF: Math.round(raw), lowRaw: raw }).icon, `raw ${raw}`).toBe(engineIcon)
    }
  })
})

describe('the frost line — buildFrostAlertLine(alertsSent, { lowShown })', () => {
  it('prints lowShown when given, and its own figure otherwise', () => {
    expect(buildFrostAlertLine([tonight(37.6)], { lowShown: 36 })).toEqual({
      text: 'Frost possible tonight — low 36°F. Plan cover for tender plants.', tier: 'advisory', dayOffset: 1, nightOffset: 0, lowF: 36,
    })
    expect(buildFrostAlertLine([tonight(37.6)], { lowShown: null }).text).toMatch(/low 38°F/)
  })

  it('an absent lowShown is the one-argument output, which the server PARITY suites call', () => {
    for (const entries of [[tonight(37.6)], [tomorrowNight(36.4)], [imminent(36)], [tonight(42)], [], null]) {
      const one = buildFrostAlertLine(entries)
      expect(buildFrostAlertLine(entries, {})).toStrictEqual(one)
      expect(buildFrostAlertLine(entries, { lowShown: undefined })).toStrictEqual(one)
      expect(buildFrostAlertLine(entries, { lowShown: null })).toStrictEqual(one)
    }
  })
})

describe('buildCueLine carries the model version; the impression bills it', () => {
  it('an engine callout still yields exactly { cue, form, text } — all five rules', () => {
    const cases = [
      [{ tonightLow: 34, highToday: 70 }, DRY], [{ tonightLow: 43, highToday: 70 }, DRY], [{ tonightLow: 55, highToday: 91 }, DRY],
      [{ tonightLow: 55, highToday: 70 }, { ...DRY, tomorrow_precip_in: 0.45, tomorrow_pop: 80 }], [{ tonightLow: 55, highToday: 70 }, { ...DRY, recent_precip_in: 0.6 }],
    ]
    for (const [w, hy] of cases) expect(Object.keys(buildCueLine(computeCallout(w, hy))).sort()).toEqual(['cue', 'form', 'text'])
  })

  it('carries a non-empty string modelVersion through both forms, and nothing else', () => {
    expect(buildCueLine({ icon: 'freeze', text: freezeText(38), modelVersion: 'm' })).toEqual({ cue: 'freeze', form: 'imperative', text: freezeText(38), modelVersion: 'm' })
    expect(buildCueLine({ icon: 'heat', text: 'Hot day (91°F) — x', modelVersion: 'm' }).modelVersion).toBe('m')
    for (const mv of ['', 5, null, {}]) expect(buildCueLine({ icon: 'freeze', text: 'Freeze tonight', modelVersion: mv })).not.toHaveProperty('modelVersion')
  })

  it('the beacon bills the line\'s own model version, else wxcue-v1', async () => {
    expect(await billedModel({ cue: 'freeze', form: 'imperative', modelVersion: AGREED_CUE_MODEL_VERSION })).toBe('wxcue-v1-agreed')
    expect(await billedModel({ cue: 'freeze', form: 'imperative' })).toBe('wxcue-v1')
  })
})

describe('Protect cards — the REAL coldFor reasons lose "(low …)" only on a trigger night (Q2: cards unchanged)', () => {
  it('the three spec strings', () => {
    const on = (low) => buildCareNeeded(planFor(low, [tonight(37.6)])).filter((r) => r.need === 'cold').map((r) => r.reason)
    expect(coldBucket(39).map((c) => c.text)).toEqual(['bring inside tonight (low 39°F)', 'tender tropical — bring in tonight (low 39°F ≤ 60°F)'])
    expect(on(39)).toEqual([BRING, TROPICAL])
    expect(coldBucket(43).map((c) => c.text)[0]).toBe('optional: protect flowering plant (low 43°F)')
    expect(on(43)[0]).toBe(OPTIONAL)
    expect(coldBucket(55).map((c) => c.text)).toEqual(['tender tropical — bring in tonight (low 55°F ≤ 60°F)'])
    expect(on(55)).toEqual([TROPICAL])
  })

  it('across the grid of lows: stripped with the trigger on, verbatim with it off; the same cards either way', () => {
    let stripped = 0
    for (const low of [...GRID_LOWS, 20, 59.9, 60]) {
      const raw = coldBucket(low)
      for (const { entries, tonightLow } of GRID_ENTRIES.concat([{ entries: [imminent(36)], tonightLow: null }])) {
        const rows = buildCareNeeded(planFor(low, entries)).filter((r) => r.need === 'cold')
        // Same cards, same order, same planting — the engine's care decision is not moved.
        expect(rows.map((r) => r.plantingId)).toEqual(raw.map((c) => c.id))
        rows.forEach((r, i) => {
          if (tonightLow != null) {
            expect([BRING, OPTIONAL, TROPICAL]).toContain(r.reason)
            expect(raw[i].text.startsWith(`${r.reason} (low ${low}°F`)).toBe(true)
            stripped++
          } else {
            expect(r.reason).toBe(raw[i].text)
            expect(r.reason).toMatch(/ \(low [^()]+\)$/)
          }
        })
      }
    }
    expect(stripped).toBeGreaterThan(50)
  })

  it('withoutLowClause leaves any other text alone', () => {
    expect(withoutLowClause('Protect tonight')).toBe('Protect tonight')
    expect(withoutLowClause('bring inside tonight (low 39°F) — later')).toBe('bring inside tonight (low 39°F) — later')
    expect(withoutLowClause(undefined)).toBeUndefined()
  })

  it('no other row changes: every non-cold row is identical with the trigger on and off', () => {
    const base = planFor(43, [])
    const extra = {
      water_due: [{ id: 'w1', name: 'Basil Row', crop: 'basil', project: 'Bag Area', project_id: 'pj-bag', interval: 3, overdue_by: 2, days_since: 5 }],
      pest: [{ id: 'p1', name: 'Kale Row', crop: 'kale', project: 'Bed', project_id: 'pj-bed', label: 'Scout for aphids' }],
    }
    const off = buildCareNeeded({ ...base, ...extra, alerts_sent: [tomorrowNight(36.4)] })
    const on = buildCareNeeded({ ...base, ...extra, alerts_sent: [tonight(37.6)] })
    expect(on.filter((r) => r.need !== 'cold')).toEqual(off.filter((r) => r.need !== 'cold'))
    expect(on.map((r) => ({ ...r, reason: withoutLowClause(r.reason) })))
      .toEqual(off.map((r) => ({ ...r, reason: withoutLowClause(r.reason) })))
  })
})

describe('nothing writes to the plan — deep-frozen, any write throws', () => {
  it.each(GRID_LOWS.map((l) => [l]))('plan low %s, every entry', (low) => {
    for (const { entries } of GRID_ENTRIES) {
      const plan = deepFreeze(planFor(low, structuredClone(entries)))
      expect(() => after(plan)).not.toThrow()
    }
  })

  it('the freeze is real: a write to it throws (control)', () => {
    const plan = deepFreeze(planFor(43, [tonight(37.6)]))
    expect(() => { plan.weather.tonightLow = 38 }).toThrow(TypeError)
    expect(() => { plan.alerts_sent[0].lowF = 1 }).toThrow(TypeError)
  })
})
