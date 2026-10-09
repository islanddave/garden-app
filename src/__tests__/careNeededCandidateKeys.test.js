// V5-TODAYREDESIGN-001 S1 — candidateRows / candidateKeys ARE CareNeeded's candidatesFor, lifted into
// careNeeded.js so every bulk control (the V1 pill and section buttons, the V2 buttons after them) runs
// ONE predicate. Pinned against the V1 closure (CareNeeded.jsx at 521fd38b) less its bed-wait line, on
// Dave's real 2026-09-24 plan (the Today harness fixture: 168 water_due, 19 of them in-ground) with the
// bed-wait forecast plan-v2 S0 names ("tomorrow 0.62/70"), and on a hand plan carrying the buckets that
// real day lacks (never-watered beds, overwintering). No jest-dom (L-182).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildCareNeeded, bedWaitActive, candidateRows, candidateKeys, canMoistureCheck,
  NEED_EVENT_TYPE, MOISTURE_CHECK_EVENT,
} from '../lib/careNeeded.js'

// CareNeeded.jsx's V1 closure at 521fd38b (:891-895) MINUS its bed-wait line, which
// BUG-DEFERNOSTRESSOVERRIDE-001 removed: `if (etype === 'watering' && bedWait && r.inGround) return false`.
// The engine holds the beds that wait (rain_skipped); an in-ground row still listed is one it kept.
const v1CandidatesFor = (rows) => (etype) => rows.filter(r => r.eventType === etype)

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
function expectSameAsV1(rows) {
  const v1 = v1CandidatesFor(rows)
  for (const et of ETYPES) {
    const want = v1(et)
    const got = candidateRows(rows, et)
    expect(got.length).toBe(want.length)
    got.forEach((r, i) => expect(r).toBe(want[i]))
    expect([...candidateKeys(rows, et)]).toEqual(want.map(r => r.key))
  }
}

describe('candidateRows / candidateKeys ≡ V1 candidatesFor, bed-wait exclusion removed', () => {
  it('the bed-wait fixture is live: the forecast trips bed-wait, and the in-ground water rows the engine kept are ALL candidates', () => {
    const real = realPlan()
    expect(bedWaitActive(real)).toBe(false)
    expect(bedWaitActive(withBedWait(real))).toBe(true)
    const rows = buildCareNeeded(withBedWait(real))
    const beds = rows.filter(r => r.eventType === 'watering' && r.inGround)
    expect(beds.length).toBe(19)
    const keys = candidateKeys(rows, 'watering')
    expect(keys.size).toBe(rows.filter(r => r.eventType === 'watering').length)
    for (const b of beds) expect(keys.has(b.key)).toBe(true)
  })

  it("Dave's real plan while beds wait: identical for every event type", () => {
    expectSameAsV1(buildCareNeeded(withBedWait(realPlan())))
  })

  it("Dave's real plan, no rain forecast: identical for every event type", () => {
    expectSameAsV1(buildCareNeeded(realPlan()))
  })

  it('the list as it stands (rows already logged or skipped taken out): identical', () => {
    expectSameAsV1(buildCareNeeded(withBedWait(realPlan())).filter((_, i) => i % 3 !== 0))
  })

  it('the hand plan (never-watered beds, overwintering, in-ground pest and cold): identical', () => {
    expectSameAsV1(buildCareNeeded(handPlan()))
  })

  it('an engine-kept in-ground row is a watering candidate while beds wait — and a stale bedWait option changes nothing', () => {
    const plan = handPlan()
    expect(bedWaitActive(plan)).toBe(true)
    const rows = buildCareNeeded(plan)
    const all = ['w1:water_due', 'w2:water_due', 'w3:water_due', 'n1:no_history', 'n2:no_history']
    expect([...candidateKeys(rows, 'watering')]).toEqual(all)
    expect([...candidateKeys(rows, 'watering', { bedWait: true })]).toEqual(all)
    expect([...candidateKeys(rows, 'observation')]).toEqual(['w2:pest'])
    expect([...candidateKeys(rows, 'brought_inside')]).toEqual(['c1:cold'])
  })

  it("the Moist check is never a bulk candidate; an overwintering row (primary type moisture_check) is, as in V1", () => {
    const rows = buildCareNeeded(handPlan())
    const moistable = rows.filter(canMoistureCheck).map(r => r.key)
    expect(moistable.length).toBe(3)
    const keys = candidateKeys(rows, MOISTURE_CHECK_EVENT)
    for (const k of moistable) expect(keys.has(k)).toBe(false)
    expect([...keys]).toEqual(['o1:overwintering', 'o2:overwintering'])
  })
})
