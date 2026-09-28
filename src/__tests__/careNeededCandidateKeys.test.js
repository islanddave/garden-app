// V5-TODAYREDESIGN-001 S1 — candidateRows / candidateKeys ARE CareNeeded's candidatesFor, lifted into
// careNeeded.js so every bulk control (the V1 pill and section buttons, the V2 buttons after them) runs
// ONE predicate. Pinned against a VERBATIM copy of the V1 closure (CareNeeded.jsx at 521fd38b), on
// Dave's real 2026-09-24 plan (the Today harness fixture: 168 water_due, 19 of them in-ground) with the
// bed-wait graft plan-v2 S0 names ("tomorrow 0.62/70"), and on a hand plan carrying the buckets that
// real day lacks (never-watered beds, overwintering). No jest-dom (L-182).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildCareNeeded, bedWaitActive, candidateRows, candidateKeys, canMoistureCheck,
  NEED_EVENT_TYPE, MOISTURE_CHECK_EVENT,
} from '../lib/careNeeded.js'

// VERBATIM from CareNeeded.jsx at 521fd38b (:891-895), its two free variables made arguments.
const v1CandidatesFor = (rows, bedWait) => (etype) => rows.filter(r => {
  if (r.eventType !== etype) return false
  if (etype === 'watering' && bedWait && r.inGround) return false
  return true
})

const ETYPES = [...new Set(Object.values(NEED_EVENT_TYPE)), 'cover', 'not_a_type']
const realPlan = () => JSON.parse(readFileSync(resolve(process.cwd(), 'tests/harness/_todaymeasure/dailyplan.dave.json'), 'utf8')).plan
const withBedWait = (plan) => ({ ...plan, hydrology: { ...plan.hydrology, recent_precip_in: plan.hydrology?.recent_precip_in ?? 0, tomorrow_precip_in: 0.62, tomorrow_pop: 70 } })
const handPlan = () => ({
  hydrology: { recent_precip_in: 0.05, tomorrow_precip_in: 0.62, tomorrow_pop: 70 },
  water_due: [
    { id: 'w1', name: 'Pot Pepper', project_id: 'pr', overdue_by: 3, in_ground: false },
    { id: 'w2', name: 'Bed Tomato', project_id: 'pr', overdue_by: 2, in_ground: true },
    { id: 'w3', name: 'Pot Basil', project_id: 'pr', overdue_by: 1, in_ground: false },
  ],
  no_history: [
    { id: 'n1', name: 'New Bed Kale', project_id: 'pr', never: true, in_ground: true },
    { id: 'n2', name: 'New Pot Mint', project_id: 'pr', never: true, in_ground: false },
  ],
  fertilize: [{ id: 'w1', name: 'Pot Pepper', project_id: 'pr', item: 'MG', in_ground: false }],
  pest: [{ id: 'w2', name: 'Bed Tomato', project_id: 'pr', label: 'Hornworm', in_ground: true }],
  cold: [{ id: 'c1', name: 'Lime', project_id: 'pr', text: 'Protect tonight', in_ground: true }],
  overwintering: [
    { id: 'o1', name: 'Rosemary', project_id: 'pr', reason: 'Winter soil check due', in_ground: false },
    { id: 'o2', name: 'Fig', project_id: 'pr', reason: 'Winter soil check due', in_ground: true },
  ],
})

// Every field of the equivalence: the same row OBJECTS in the same order, and the same keys.
function expectSameAsV1(rows, bedWait) {
  const v1 = v1CandidatesFor(rows, bedWait)
  for (const et of ETYPES) {
    const want = v1(et)
    const got = candidateRows(rows, et, { bedWait })
    expect(got.length).toBe(want.length)
    got.forEach((r, i) => expect(r).toBe(want[i]))
    expect([...candidateKeys(rows, et, { bedWait })]).toEqual(want.map(r => r.key))
  }
}

describe('candidateRows / candidateKeys ≡ V1 candidatesFor', () => {
  it('the bed-wait fixture is live: the graft trips bed-wait, and there are in-ground water rows for it to exclude', () => {
    const real = realPlan()
    expect(bedWaitActive(real)).toBe(false)
    expect(bedWaitActive(withBedWait(real))).toBe(true)
    const rows = buildCareNeeded(withBedWait(real))
    const beds = rows.filter(r => r.eventType === 'watering' && r.inGround).length
    expect(beds).toBe(19)
    // The exclusion actually removes them (non-vacuity for every comparison below).
    expect(candidateKeys(rows, 'watering', { bedWait: true }).size).toBe(rows.filter(r => r.eventType === 'watering').length - beds)
  })

  it("Dave's real plan with bed-wait ON: identical for every event type", () => {
    const plan = withBedWait(realPlan())
    expectSameAsV1(buildCareNeeded(plan), bedWaitActive(plan))
  })

  it("Dave's real plan with bed-wait OFF: identical for every event type", () => {
    const plan = realPlan()
    expectSameAsV1(buildCareNeeded(plan), bedWaitActive(plan))
  })

  it('the list as it stands (rows already logged or skipped taken out): identical', () => {
    const plan = withBedWait(realPlan())
    const live = buildCareNeeded(plan).filter((_, i) => i % 3 !== 0)
    expectSameAsV1(live, true)
    expectSameAsV1(live, false)
  })

  it('the hand plan (never-watered beds, overwintering, in-ground pest and cold): identical, both ways', () => {
    const rows = buildCareNeeded(handPlan())
    expectSameAsV1(rows, true)
    expectSameAsV1(rows, false)
  })

  it('bed-wait excludes in-ground rows from WATERING only — never-watered beds included, pest and cold beds kept', () => {
    const rows = buildCareNeeded(handPlan())
    expect([...candidateKeys(rows, 'watering', { bedWait: true })]).toEqual(['w1:water_due', 'w3:water_due', 'n2:no_history'])
    expect([...candidateKeys(rows, 'watering', { bedWait: false })]).toEqual(['w1:water_due', 'w2:water_due', 'w3:water_due', 'n1:no_history', 'n2:no_history'])
    expect([...candidateKeys(rows, 'observation', { bedWait: true })]).toEqual(['w2:pest'])
    expect([...candidateKeys(rows, 'brought_inside', { bedWait: true })]).toEqual(['c1:cold'])
    // opts omitted = no bed-wait.
    expect([...candidateKeys(rows, 'watering')]).toEqual([...candidateKeys(rows, 'watering', { bedWait: false })])
  })

  it("the Moist check is never a bulk candidate; an overwintering row (primary type moisture_check) is, as in V1", () => {
    const rows = buildCareNeeded(handPlan())
    const moistable = rows.filter(canMoistureCheck).map(r => r.key)
    expect(moistable.length).toBe(3)
    const keys = candidateKeys(rows, MOISTURE_CHECK_EVENT, { bedWait: true })
    for (const k of moistable) expect(keys.has(k)).toBe(false)
    expect([...keys]).toEqual(['o1:overwintering', 'o2:overwintering'])
  })
})
