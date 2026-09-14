// BUG-MOISTURECHECKNOBUTTON-001 — the predicate deciding which rows offer "I checked it, still
// moist", plus the cross-file contracts that make the tap safe to offer at all.
//
// The event type, its icon, its reward exclusion and the read-side 24h check-off all shipped in
// V4-WATERMATH-001 F0; only the affordance was missing, which is why prod holds zero rows of it all
// time. These are the invariants the affordance now depends on — each assertion names the mutation
// that turns it red.
import { describe, it, expect } from 'vitest'
import { buildCareNeeded, canMoistureCheck, MOISTURE_CHECK_EVENT, NEED_EVENT_TYPE } from '../lib/careNeeded.js'
import { EVENT_TYPES, BATCH_EXCLUDED_TYPES, NON_REWARD_EVENT_TYPES, isRewardedEventType } from '../lib/eventTypes.js'
import { DONE_EVENTS } from '../../lambda/daily-plan-read/doneEvents.js'

const rowsFor = (plan) => buildCareNeeded(plan)
const WATER = { id: 'p1', name: 'Bhut Jolokia', crop: 'pepper', project_id: 'prP', overdue_by: 3 }

describe('BUG-MOISTURECHECKNOBUTTON-001 — which rows carry the control', () => {
  // Mutation: widen canMoistureCheck to any water need and this goes red.
  it('offers it on water_due and nowhere else', () => {
    const rows = rowsFor({
      water_due: [WATER],
      no_history: [{ id: 'p2', name: 'Shishito', project_id: 'prP', never: true }],
      fertilize: [{ id: 'p3', name: 'Kale', project_id: 'prK' }],
      pest: [{ id: 'p4', name: 'Basil', project_id: 'prB' }],
      cold: [{ id: 'p5', name: 'Lime', project_id: 'prL' }],
      overwintering: [{ id: 'p6', name: 'Winterbor', project_id: 'prW', interval: 14 }],
    })
    const offered = rows.filter(canMoistureCheck).map((r) => r.need)
    expect(offered).toEqual(['water_due'])
  })

  // THE reason no_history is excluded, stated as the server contract rather than as taste. Mutation:
  // add 'moisture_check' to DONE_EVENTS.no_history (or to canMoistureCheck) and this goes red.
  //
  // Live consequence if it drifted: the tap optimistically hides a "never watered" row, the server
  // declines to check it off, and the row returns on the next plan read — a write the gardener
  // cannot see and did not get.
  it('is offered only where the server actually checks the card off', () => {
    expect(DONE_EVENTS.water_due).toContain(MOISTURE_CHECK_EVENT)
    expect(DONE_EVENTS.no_history).not.toContain(MOISTURE_CHECK_EVENT)
    expect(canMoistureCheck({ need: 'water_due' })).toBe(true)
    expect(canMoistureCheck({ need: 'no_history' })).toBe(false)
  })

  // The overwintering row already logs moisture_check as its PRIMARY action, so a secondary control
  // there would post the identical event as the chip beside it. Mutation: let canMoistureCheck
  // return true for overwintering and this goes red.
  it('does not double up on the row whose primary action is already a moisture check', () => {
    expect(NEED_EVENT_TYPE.overwintering).toBe(MOISTURE_CHECK_EVENT)
    expect(canMoistureCheck({ need: 'overwintering' })).toBe(false)
  })

  it('tolerates a missing or malformed row', () => {
    expect(canMoistureCheck(null)).toBe(false)
    expect(canMoistureCheck(undefined)).toBe(false)
    expect(canMoistureCheck({})).toBe(false)
  })

  // The water row must keep WATERING as its primary type — the control is additive. Mutation: point
  // NEED_EVENT_TYPE.water_due at moisture_check and this goes red, along with the bulk machinery
  // (candidatesFor/groupBulkFor key off NEED_EVENT_TYPE) that would then bulk a batch-excluded type.
  it('leaves the row\'s primary event type alone', () => {
    expect(NEED_EVENT_TYPE.water_due).toBe('watering')
    expect(rowsFor({ water_due: [WATER] })[0].eventType).toBe('watering')
  })
})

describe('BUG-MOISTURECHECKNOBUTTON-001 — the tap must stay unrewarded', () => {
  // The whole point of the type. Mutation: remove 'moisture_check' from NON_REWARD_EVENT_TYPES and
  // this goes red — and live, the snooze becomes a farmable XP/critter lever (tap it down 200
  // plantings, sustain a streak without gardening) and poisons the watering learner with events
  // meaning "I did nothing".
  it('posts a type the reward partition excludes', () => {
    expect(NON_REWARD_EVENT_TYPES).toContain(MOISTURE_CHECK_EVENT)
    expect(isRewardedEventType(MOISTURE_CHECK_EVENT)).toBe(false)
    // The contrast, so this cannot pass by isRewardedEventType returning false for everything.
    expect(isRewardedEventType('watering')).toBe(true)
  })

  // Mutation: remove 'moisture_check' from BATCH_EXCLUDED_TYPES and this goes red. A per-plant
  // judgement fanned across a scope is a fabricated observation, and one tap would suppress the
  // whole water bar.
  it('stays out of every bulk path', () => {
    expect(BATCH_EXCLUDED_TYPES).toContain(MOISTURE_CHECK_EVENT)
  })

  // Mutation: drop the registry entry and this goes red — the events Lambda validates event_type
  // against this vocabulary, so an unlisted type is a 400 and the control would be dead on arrival.
  it('is a real vocabulary type', () => {
    expect(EVENT_TYPES).toContain(MOISTURE_CHECK_EVENT)
    expect(MOISTURE_CHECK_EVENT).toBe('moisture_check')
  })
})
