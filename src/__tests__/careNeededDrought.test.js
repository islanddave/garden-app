// V5-LEGACYEXCEPTIONCARE-001 — the SPA read path for the drought signal. The engine appends a note to
// a dormancy_suppressed item's `reason` and mirrors it as a structured `drought` key whenever the
// space has gone 20+ consecutive days with no rain of >=0.60 in (engine.js:911-919); until this row
// zero surfaces read it, so the signal reached the stored plan and CloudWatch and never reached Today.
// Each assertion names the source mutation that turns it red.
//
// FIXTURES ARE ENGINE OUTPUT, NOT GUESSES. ENGINE_VERBATIM below is copied byte-for-byte from a run of
// engine.generatePlan() with a `dry` droughtState threaded in (2026-09-08), and the helpers are built
// to match it — a fixture with the wrong shape produces a green suite that proves nothing.
import { describe, it, expect } from 'vitest'
import { droughtRows, buildCareNeeded, NEED_ORDER } from '../lib/careNeeded.js'

// engine.js:914-915 — the suppression clause, before the note is concatenated onto it.
const SUP = 'Watering suppressed — profile: NO calendar watering; water only on plant signals, never by interval'
// droughtSignal.js droughtNote() — the engine's own string, which this selector deliberately does NOT
// parse (it reads the structured key instead) but which the reason field really does carry.
const note = (d) => 'Drought signal — no deep soak (>=' + d.deep_soak_in.toFixed(2) + ' in of rain in one day) in '
  + (d.truncated ? 'at least ' : '') + d.dry_days + ' days. Check soil moisture at root depth.'

const dry = (dry_days, truncated = false, last_deep_soak = '2026-08-03') =>
  ({ dry_days, deep_soak_in: 0.6, last_deep_soak, truncated })

// One dormancy_suppressed item. `d` omitted => the engine's `ok`/`insufficient` shape: the note is
// null, so neither the appended clause nor the `drought` key is written at all.
const sup = (id, name, crop, d) => ({
  id, name, crop, project: 'Legacy Pasture', project_id: 'pr-legacy',
  rule: 'no_calendar_water', moisture: 'even',
  reason: SUP + (d ? ' — ' + note(d) : ''),
  ...(d ? { drought: d } : {}),
})

// Four of the six no_calendar_water plantings — the four the hook actually reaches today. Blackberry
// and Wild Wineberry are status='dormant' and engine.js:885 routes them to the dormant bucket and
// `continue`s BEFORE the suppression branch, so they never carry a drought note. Their absence here is
// the real reach, not an oversight.
const PEACH = sup('p-peach', 'Peach tree', 'peach', dry(28))
const HYDRANGEA = sup('p-hyd', 'Hydrangeas', 'hydrangea', dry(28))
const DOGWOOD = sup('p-dog', 'Kousa Dogwood', 'dogwood')      // same space, but read `ok` => no note
const BLUEBERRY = sup('p-blue', 'Blueberries', 'blueberry', dry(30, true, null))

const plan = (items) => ({
  water_due: [], no_history: [], fertilize: [], pest: [], cold: [], dormant: [], rain_skipped: [],
  dormancy_suppressed: items,
})

// Copied verbatim from engine.generatePlan({...droughtState}) — tasks.dormancy_suppressed[0].
const ENGINE_VERBATIM = {
  id: 'peach1',
  name: 'Peach tree',
  crop: 'peach',
  project: 'Orchard',
  project_id: 'pr-orch',
  rule: 'no_calendar_water',
  moisture: 'even',
  reason: 'Watering suppressed — profile: NO calendar watering; water only on plant signals, never by interval — Drought signal — no deep soak (>=0.60 in of rain in one day) in at least 30 days. Check soil moisture at root depth.',
  drought: { dry_days: 30, deep_soak_in: 0.6, last_deep_soak: null, truncated: true },
}

describe('the fixtures are the shape the engine really emits', () => {
  // Guards the fixtures themselves. Mutation: give the no-note item a `drought: null` (or worse, a
  // real one) and this goes red — which would make the "does not render" discriminator below test
  // nothing, and every count in this file would be off by one.
  it('writes drought only on the firing items, and omits the key entirely otherwise', () => {
    expect(Object.prototype.hasOwnProperty.call(PEACH, 'drought')).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(DOGWOOD, 'drought')).toBe(false)
    expect(DOGWOOD.reason).toBe(SUP)
    expect(PEACH.reason).toBe(SUP + ' — Drought signal — no deep soak (>=0.60 in of rain in one day) in 28 days. Check soil moisture at root depth.')
  })

  // The helpers are only trustworthy if they agree with real engine output. Mutation: rename any
  // payload key (dry_days -> dryDays, drought -> drought_state) in either the helper or the selector
  // and this goes red against the copied row.
  it('agrees with a row copied verbatim out of engine.generatePlan', () => {
    const rows = droughtRows(plan([ENGINE_VERBATIM]))
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Peach tree')
    expect(rows[0].dryDays).toBe(30)
    expect(rows[0].truncated).toBe(true)
    expect(rows[0].reason).toBe('No deep soak (≥0.60 in) in at least 30 days')
  })
})

describe('reading the bucket', () => {
  // Mutation: make droughtRows return [] and this goes red. That empty return IS the shipped state —
  // the engine computes the signal and every client drops it on the floor.
  it('carries the engine fields the surface needs', () => {
    const rows = droughtRows(plan([PEACH]))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      key: 'p-peach:drought', plantingId: 'p-peach', name: 'Peach tree', crop: 'peach',
      project: 'Legacy Pasture', projectId: 'pr-legacy', rule: 'no_calendar_water',
      dryDays: 28, truncated: false, lastDeepSoak: '2026-08-03',
    })
  })

  // THE discriminator. Without it the list shows every suppressed planting and every other test in
  // this file passes for the wrong reason. Mutation: drop the `if (!d …) continue` guard and this
  // goes red — Kousa Dogwood would be told it is dry on a day the engine said it is not.
  it('skips a suppressed planting that carries no drought note', () => {
    expect(droughtRows(plan([DOGWOOD]))).toEqual([])
    expect(droughtRows(plan([PEACH, DOGWOOD, HYDRANGEA])).map(r => r.name))
      .toEqual(['Peach tree', 'Hydrangeas'])
  })

  it('preserves engine order and falls back to crop then a generic name', () => {
    expect(droughtRows(plan([BLUEBERRY, PEACH])).map(r => r.name)).toEqual(['Blueberries', 'Peach tree'])
    expect(droughtRows(plan([{ id: 'x', crop: 'peach', drought: dry(21) }]))[0].name).toBe('peach')
    expect(droughtRows(plan([{ id: 'x', drought: dry(21) }]))[0].name).toBe('Planting')
  })

  // Mutation: `plan.dormancy_suppressed || []` without the Array.isArray check and the string case
  // throws or iterates characters.
  it('reads nothing from an absent, empty or malformed bucket', () => {
    for (const bad of [null, undefined, {}, plan([]), { dormancy_suppressed: 'nope' }, { dormancy_suppressed: 3 }]) {
      expect(droughtRows(bad)).toEqual([])
    }
    expect(droughtRows(plan([null, undefined]))).toEqual([])
  })
})

describe('the wording is the ruling', () => {
  // Dave's ruling 2026-09-08, mirrored from droughtSignal.js's own two wording tests. 0.60 in is the
  // in-ground `deep` class, NOT light rain — calling it plain rain is the category slip that falsified
  // the first version of crucible Verdict 3. Mutation: reword to "No rain in 28 days" and this reds.
  it('says what it measures — a deep soak, never plain rain', () => {
    const r = droughtRows(plan([PEACH]))[0].reason
    expect(r).toBe('No deep soak (≥0.60 in) in 28 days')
    expect(r).toMatch(/deep soak/i)
    expect(r).not.toMatch(/no rain in/i)
    expect(r).not.toMatch(/no measurable rain/i)
  })

  // `truncated` means the walk hit the end of the read window, so the run is AT LEAST this long.
  // Mutation: drop the truncated clause and a 30-day run is stated as exactly 30 days.
  it('says "at least" when the run outran the read window', () => {
    expect(droughtRows(plan([BLUEBERRY]))[0].reason).toBe('No deep soak (≥0.60 in) in at least 30 days')
  })

  // The depth is READ OFF THE PAYLOAD, not restated as a constant here, so a RAIN_DEPTH_TIERS retune
  // moves the trigger and the sentence together. Mutation: hardcode '0.60' and this goes red.
  it('quotes the depth the engine actually used', () => {
    const item = { ...PEACH, drought: { ...PEACH.drought, deep_soak_in: 0.75 } }
    expect(droughtRows(plan([item]))[0].reason).toBe('No deep soak (≥0.75 in) in 28 days')
  })

  // A clarifier, not the claim: a payload with no usable depth still gets to say how long it has been
  // dry. Mutation: refuse the row when deep_soak_in is missing and this goes red.
  it('drops the parenthetical rather than the row when the depth is unusable', () => {
    for (const bad of [undefined, null, 'deep', NaN]) {
      const item = { ...PEACH, drought: { ...PEACH.drought, deep_soak_in: bad } }
      expect(droughtRows(plan([item]))[0].reason).toBe('No deep soak in 28 days')
    }
  })
})

describe('an unusable day count is refused, never guessed', () => {
  // The day count IS the claim, and the engine is the only thing that knows the run length. A note
  // that says something slightly wrong about a dry plant is worse than no note. Mutation: coerce with
  // Number(d.dry_days) or default to DRY_DAYS and this goes red — '28' and null would start rendering
  // as facts the payload never asserted.
  it('drops a row whose dry_days is not a positive finite number', () => {
    for (const bad of [0, -3, null, undefined, '28', NaN, Infinity, {}]) {
      expect(droughtRows(plan([{ ...PEACH, drought: { ...PEACH.drought, dry_days: bad } }]))).toEqual([])
    }
    expect(droughtRows(plan([{ ...PEACH, drought: null }]))).toEqual([])
  })

  // Not reachable from the shipped engine (DRY_DAYS is 20), but the sentence is built here and a
  // retune to 1 must not print "in 1 days".
  it('says day, not days, for one', () => {
    expect(droughtRows(plan([{ ...PEACH, drought: dry(1) }]))[0].reason).toBe('No deep soak (≥0.60 in) in 1 day')
  })
})

describe('drought stays OUT of the actionable list', () => {
  // A suppressed planting has nothing to log, and its profile says never water it by interval.
  // Mutation: add 'dormancy_suppressed' to NEED_ORDER and this goes red — Today would offer a one-tap
  // Water on exactly the plantings the DRG-NOCALWATER-001 fix exists to keep off the watering clock.
  it('is not a care need', () => {
    expect(NEED_ORDER).not.toContain('dormancy_suppressed')
    expect(buildCareNeeded(plan([PEACH, HYDRANGEA]))).toEqual([])
  })
})
