// V4-DORMANTRESUME-001 — the SPA read path for the dormant bucket, and the guard that decides which
// dormant rows may be resumed. The engine has always emitted `dormant[]`; until this row, zero
// surfaces read it, so five live plantings were invisible everywhere in the app. Each assertion
// names the source mutation that turns it red.
import { describe, it, expect } from 'vitest'
import { dormantRows, buildCareNeeded, NEED_ORDER } from '../lib/careNeeded.js'

// Shape copied from a real prod plan row (daily_plan.items->'dormant', 2026-08-20): id/name/crop/
// project/project_id/note, plus the `reason` this row adds.
const GARLIC = {
  id: '7bfaea51-8ad6-4063-948c-9b6e78616418', crop: 'garlic', name: 'Garlic',
  note: 'Dormant — skip routine care', project: 'Garlic',
  project_id: '6b5fa440-72f6-41a1-a116-39e7361898f2', reason: 'status',
}
// The cadence-flag class. cadence-data-v2.json carries dormant_skip on exactly one variety —
// Lithops — whose own note reads "watering now = rot/death".
const LITHOPS = {
  id: 'lith1', crop: 'lithops', name: 'Lithops', project: 'Windowsill', project_id: 'prW',
  note: 'DO NOT WATER NOW — summer dormancy; resume Sept; watering now = rot/death',
  reason: 'profile',
}

describe('dormant plantings reach a surface at all', () => {
  // Mutation: make dormantRows return [] and this goes red. The live consequence is the state
  // before this row — the engine computes the bucket, the read Lambda serves it, and every client
  // drops it on the floor.
  it('produces a row from the engine bucket', () => {
    const rows = dormantRows({ dormant: [GARLIC] })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      key: GARLIC.id + ':dormant', plantingId: GARLIC.id, name: 'Garlic',
      crop: 'garlic', project: 'Garlic', projectId: GARLIC.project_id,
    })
    expect(rows[0].note).toBe('Dormant — skip routine care')
  })

  it('preserves engine order and tolerates an absent bucket', () => {
    expect(dormantRows({ dormant: [GARLIC, LITHOPS] }).map(r => r.name)).toEqual(['Garlic', 'Lithops'])
    expect(dormantRows({})).toEqual([])
    expect(dormantRows(null)).toEqual([])
    expect(dormantRows({ dormant: 'nope' })).toEqual([])
  })

  // Dormancy carries no action, so it must stay OUT of the actionable care list — a row there would
  // offer a one-tap log against a planting that is deliberately receiving no care.
  // Mutation: add 'dormant' to NEED_ORDER and this goes red.
  it('never enters the actionable care list', () => {
    expect(NEED_ORDER).not.toContain('dormant')
    expect(buildCareNeeded({ dormant: [GARLIC] })).toEqual([])
  })
})

describe('resume is offered only where a status actually exists to clear', () => {
  // Mutation: change `it.reason === 'status'` to a truthy check on `it.reason` and this goes red.
  // The live consequence is a Resume button on the one plant class in the garden whose care data
  // says watering it now kills it.
  it('resumes status-dormant, never the cadence-flag class', () => {
    const [garlic, lithops] = dormantRows({ dormant: [GARLIC, LITHOPS] })
    expect(garlic.resumable).toBe(true)
    expect(lithops.resumable).toBe(false)
  })

  // Cross-deploy window: the SPA ships independently of the daily-plan Lambda, so a plan stored
  // before the engine emitted `reason` has neither value. Visibility is the SPA's own half of the
  // fix and lands immediately; the action stays closed until the discriminator is live.
  // Mutation: default `resumable` to true when `reason` is absent and this goes red.
  it('lists but does not resume a pre-discriminator plan row', () => {
    const legacy = { id: 'old1', name: 'Asparagus', note: 'Dormant — skip routine care' }
    const rows = dormantRows({ dormant: [legacy] })
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Asparagus')
    expect(rows[0].resumable).toBe(false)
  })

  // The note string is what consumers had to compare before `reason` existed. It must not be what
  // decides the action now: it is free care-profile prose for the profile class.
  // Mutation: derive resumable from the note text and this goes red.
  it('ignores the note text when deciding resumability', () => {
    const misleading = { ...LITHOPS, note: 'Dormant — skip routine care' }
    expect(dormantRows({ dormant: [misleading] })[0].resumable).toBe(false)
    const bare = { ...GARLIC, note: null }
    expect(dormantRows({ dormant: [bare] })[0].resumable).toBe(true)
  })
})
