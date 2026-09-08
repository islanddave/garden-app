// BUG-CAREFEEDINHERIT-001 — the SPA read path for the feed_suppressed bucket. The engine routes a
// planting whose profile refuses calendar feeding into tasks.feed_suppressed with a rule + reason
// (engine.js:1103-1105); until this row zero surfaces read it, so nine live plantings stopped
// producing Feed cards with nothing on screen saying why. Each assertion names the source mutation
// that turns it red.
//
// The three-state contract is the point. feed_suppressed follows V4-OVERWINTER-001's CONDITIONAL
// spread, so ABSENT and ZERO are different payloads with different meanings, and the classic defect
// is a reader that treats absent as zero and then asserts "nobody is suppressed" from a plan that
// never evaluated the question.
import { describe, it, expect } from 'vitest'
import {
  feedSuppressedRows, buildCareNeeded, NEED_ORDER,
  FEED_SUPPRESSED_ABSENT, FEED_SUPPRESSED_NONE, FEED_SUPPRESSED_LISTED,
} from '../lib/careNeeded.js'

// Engine row shape, verbatim from engine.js:1104-1105 — {id,name,crop,project,project_id,rule,reason}.
// ids/names are three of the nine live suppressed plantings (prod, 2026-09-08).
const REASON = 'Feeding suppressed — profile: NO calendar feeding; feed only on plant signals, never by interval'
const ROSEMARY = {
  id: 'ec269765-bc63-4590-abe9-cf63e36af389', name: 'Rosemary', crop: 'herb (Salvia rosmarinus)',
  project: 'Herbs', project_id: 'pr-herbs', rule: 'no_calendar_feed', reason: REASON,
}
const GOLDENROD = {
  id: '14696365-c660-4976-b71d-9a9fc7571cbd', name: 'Goldenrod', crop: 'goldenrod',
  project: 'Natives', project_id: 'pr-natives', rule: 'no_calendar_feed', reason: REASON,
}

// The two payload shapes the engine actually emits. `_fsOn` is `feedSuppressed.length>0`, so the OFF
// shape has NO feed_suppressed key at all — not an empty array. planOff() asserts that below.
const planOff = () => ({ water_due: [], no_history: [], fertilize: [], pest: [], cold: [], dormant: [], rain_skipped: [] })
const planOn = (items) => ({ ...planOff(), feed_suppressed: items })

describe('the engine OFF shape is genuinely key-absent', () => {
  // Guards the fixture itself. Mutation: add `feed_suppressed: []` to planOff and this goes red —
  // which would make every "absent" case below silently test the zero case instead.
  it('carries no feed_suppressed key when nothing is suppressed', () => {
    expect(Object.prototype.hasOwnProperty.call(planOff(), 'feed_suppressed')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(planOn([]), 'feed_suppressed')).toBe(true)
  })
})

describe('absent / zero / populated are three distinct states', () => {
  // THE bug this row exists to prevent. Mutation: `if (raw === undefined) return {state:'none'}` —
  // i.e. treat a missing key as a ran-and-found-nothing gate — and this goes red.
  it('reports absent for a missing key and none for an empty one', () => {
    expect(feedSuppressedRows(planOff()).state).toBe(FEED_SUPPRESSED_ABSENT)
    expect(feedSuppressedRows(planOn([])).state).toBe(FEED_SUPPRESSED_NONE)
    expect(FEED_SUPPRESSED_ABSENT).not.toBe(FEED_SUPPRESSED_NONE)
  })

  it('reports listed once the bucket has a planting in it', () => {
    expect(feedSuppressedRows(planOn([ROSEMARY])).state).toBe(FEED_SUPPRESSED_LISTED)
  })

  // A malformed payload is UNKNOWN, never a ran-and-found-nothing claim. Mutation: fall through to
  // `rows.length ? listed : none` on a non-array and this goes red — a string or an object would
  // start reporting the same 'none' that licenses "every planting is on calendar feeding".
  it('reports absent — not none — for a malformed or missing plan', () => {
    for (const bad of [null, undefined, {}, { feed_suppressed: 'nope' }, { feed_suppressed: 3 }, { feed_suppressed: {} }]) {
      expect(feedSuppressedRows(bad).state).toBe(FEED_SUPPRESSED_ABSENT)
      expect(feedSuppressedRows(bad).rows).toEqual([])
    }
  })

  // An array that holds only junk RAN — it just produced nothing nameable. That is 'none', and the
  // row list is still empty so no caller can render a heading over zero names.
  it('reports none for an array that maps to no nameable rows', () => {
    const r = feedSuppressedRows(planOn([null, undefined]))
    expect(r.state).toBe(FEED_SUPPRESSED_NONE)
    expect(r.rows).toEqual([])
  })
})

describe('row mapping', () => {
  // Mutation: make feedSuppressedRows return [] and this goes red. The live consequence is the
  // shipped state — the engine computes the bucket and every client drops it on the floor.
  it('carries the engine fields the surface needs, including the rule', () => {
    const rows = feedSuppressedRows(planOn([ROSEMARY])).rows
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      key: ROSEMARY.id + ':feed_suppressed', plantingId: ROSEMARY.id, name: 'Rosemary',
      crop: 'herb (Salvia rosmarinus)', project: 'Herbs', projectId: 'pr-herbs',
      rule: 'no_calendar_feed',
    })
    expect(rows[0].reason).toBe(REASON)
  })

  it('preserves engine order and falls back to crop then a generic name', () => {
    expect(feedSuppressedRows(planOn([ROSEMARY, GOLDENROD])).rows.map(r => r.name))
      .toEqual(['Rosemary', 'Goldenrod'])
    expect(feedSuppressedRows(planOn([{ id: 'x', crop: 'herb' }])).rows[0].name).toBe('herb')
    expect(feedSuppressedRows(planOn([{ id: 'x' }])).rows[0].name).toBe('Planting')
  })
})

describe('suppression stays OUT of the actionable list', () => {
  // A suppressed planting has nothing to log. Mutation: add 'feed_suppressed' to NEED_ORDER and this
  // goes red — Today would offer a one-tap Feed on the exact plantings that must never be fed by
  // interval, which is worse than the invisibility this row is fixing.
  it('is not a care need', () => {
    expect(NEED_ORDER).not.toContain('feed_suppressed')
    expect(buildCareNeeded(planOn([ROSEMARY, GOLDENROD]))).toEqual([])
  })
})
