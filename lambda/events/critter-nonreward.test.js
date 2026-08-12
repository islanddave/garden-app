// BUG-CRITTERNONREWARD-001 — the FOURTH grant path for NON_REWARD_EVENT_TYPES.
//
// The partition's contract is "ZERO xp, ZERO streak credit, ZERO total_events" (src/lib/eventTypes.js).
// Three enforcement points were built and are correct: index.js Step 3a/3b/3c, batchSideEffects.js
// Step 2/3/4, dashboard/handlers.js's read-time streak recompute. The critter award was a fourth
// grant path and had NO event_type gate and no daily cap, so a moisture_check rolled ~47.5% for a
// collectible. It is also the ONLY reward here that writes DURABLE data: xp, streak and
// total_events are all RECOMPUTED from event_log on the next logging action, but a critter_state
// row persists until someone deletes it. That made "I checked the soil" a farmable collectible
// loop — precisely what the partition exists to prevent.
//
// THIS FILE DELIBERATELY DOES NOT MOCK pickSpecies. The roll is ~47.5%, so a test that stubbed it
// could assert nothing about whether the guard or the dice produced the no-award. Instead every
// case runs the REAL pickSpecies on a seed pinned below that genuinely rolls a species, and the
// REWARDED arm of each pair proves it — if the seed ever stopped awarding, the control assertion
// fails loudly rather than letting the non-reward assertion pass vacuously. That pairing is the
// whole design of this file: no assertion here can go green by doing nothing.
import { describe, it, expect } from 'vitest'
import { awardCritterServer, awardCrittersForBatch } from './critterAward.js'
import { pickSpecies } from './critterSpecies.js'
import { NON_REWARD_EVENT_TYPES } from './eventTypes.generated.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// Recording fake of the Neon tagged-template `sql`. Records EVERY statement, so "no critter was
// granted" is asserted as "no INSERT was issued", not as "the return value was null" — a return
// value cannot distinguish a suppressed grant from a grant whose RETURNING came back empty.
// BIND VALUES ARE RECORDED, not just the query text. These are tagged templates, so every id is a
// PARAMETER — the SQL text never contains 'evt_0'. An "the insert is not keyed to the non-reward
// row" assertion written against the text alone is vacuously true no matter what the code does.
function makeSql({ critterRows = [{ id: 'c1', species_id: 136 }] } = {}) {
  const calls = []
  const sql = (strings, ...values) => {
    const q = strings.join('?')
    calls.push({ q, values })
    if (q.includes('public.critter_state')) return Promise.resolve(critterRows)
    if (q.includes('user_notification_prefs')) return Promise.resolve([])
    return Promise.resolve([])
  }
  sql.calls = calls
  sql.critterInserts = () => calls.filter((c) => /INSERT INTO\s+public\.critter_state/.test(c.q))
  sql.tallyWrites = () => calls.filter((c) => /INSERT INTO garden_shared_state/.test(c.q))
  return sql
}

// A seed that REALLY rolls a species. Pinned, not searched at runtime: a test that hunts for an
// awarding seed would silently re-hunt (and keep passing) if the reward curve were retuned to
// never award, which is exactly the regression the control arms exist to catch.
const AWARDING = {
  userId: 'user_1',
  eventId: 'evt_0',
  plantId: 'plant_1',
  eventCreatedAt: '2026-06-07T00:00:00Z',
  householdId: 'user_1',
  tzOffsetMin: 0,
}
const AWARDING_SEED = [AWARDING.eventId, AWARDING.eventCreatedAt, AWARDING.householdId].join('|')

describe('BUG-CRITTERNONREWARD-001 — a non-reward event type grants no critter', () => {
  // The load-bearing precondition for every case below. Without it, "moisture_check awarded
  // nothing" is consistent with "nothing would have awarded anyway".
  it('the pinned seed genuinely rolls a species (anti-vacuity precondition)', () => {
    expect(pickSpecies(AWARDING_SEED, {}, { speciesMultipliers: {} })).not.toBeNull()
  })

  it('single-POST: a moisture_check writes NO critter_state row', async () => {
    const sql = makeSql()
    const res = await awardCritterServer({ ...AWARDING, sql, eventType: 'moisture_check' })
    expect(res).toBeNull()
    expect(sql.critterInserts()).toHaveLength(0)
    // The gate sits ahead of the archived-planting lookup, so a suppressed award costs no round
    // trip at all. Asserting zero statements also catches a guard placed after the INSERT.
    expect(sql.calls).toHaveLength(0)
    expect(sql.tallyWrites()).toHaveLength(0)
  })

  it('single-POST: the SAME seed and plant DO award on a rewarded type (control)', async () => {
    const sql = makeSql()
    const res = await awardCritterServer({ ...AWARDING, sql, eventType: 'watering' })
    expect(res?.id).toBe('c1')
    expect(sql.critterInserts()).toHaveLength(1)
  })

  it('batch: a moisture_check batch writes NO critter_state row', async () => {
    const sql = makeSql()
    const events = [{ id: 'evt_0', plant_id: 'plant_1', created_at: AWARDING.eventCreatedAt, metadata: {} }]
    const res = await awardCrittersForBatch({
      sql, userId: 'user_1', events, householdId: 'user_1', eventType: 'moisture_check',
    })
    expect(res).toEqual([])
    expect(sql.critterInserts()).toHaveLength(0)
    expect(sql.calls).toHaveLength(0)
  })

  it('batch: the same batch DOES award on a rewarded type (control)', async () => {
    const sql = makeSql()
    const events = [{ id: 'evt_0', plant_id: 'plant_1', created_at: AWARDING.eventCreatedAt, metadata: {} }]
    const res = await awardCrittersForBatch({
      sql, userId: 'user_1', events, householdId: 'user_1', eventType: 'watering',
    })
    expect(res).toHaveLength(1)
    expect(sql.critterInserts()).toHaveLength(1)
  })

  // Per-event filtering, not just batch-level. Selection takes the LOWEST sorted id, so a gate
  // applied after selection would let one non-reward row suppress a whole mixed batch's legitimate
  // award. 'evt_0' sorts first AND is the awarding seed, so if it were not filtered out this would
  // award on the wrong row.
  // Both ids below are pinned AWARDING seeds (asserted here, not assumed), so the outcome is
  // decided entirely by the filter and never by the dice: without per-event filtering the lowest
  // sorted id wins and the award is keyed to the moisture_check row.
  it('batch: a non-reward row is filtered BEFORE the chosen-event selection', async () => {
    const seedFor = (id) => [id, AWARDING.eventCreatedAt, 'user_1'].join('|')
    expect(pickSpecies(seedFor('evt_0'), {}, { speciesMultipliers: {} })).not.toBeNull()
    expect(pickSpecies(seedFor('evt_1'), {}, { speciesMultipliers: {} })).not.toBeNull()

    const sql = makeSql()
    const events = [
      { id: 'evt_0', plant_id: 'plant_1', created_at: AWARDING.eventCreatedAt, metadata: {}, event_type: 'moisture_check' },
      { id: 'evt_1', plant_id: 'plant_1', created_at: AWARDING.eventCreatedAt, metadata: {}, event_type: 'watering' },
    ]
    await awardCrittersForBatch({ sql, userId: 'user_1', events, householdId: 'user_1' })
    const inserts = sql.critterInserts()
    expect(inserts).toHaveLength(1)
    // 'evt_0' sorts first, so this is the assertion that the filter runs before selection.
    expect(inserts[0].values).toContain('evt_1')
    expect(inserts[0].values).not.toContain('evt_0')
  })

  // CLASS-CLOSING. moisture_check is the only member today; a second one added later is covered
  // the day it lands rather than the day someone remembers this file exists.
  it.each(NON_REWARD_EVENT_TYPES)('%s grants no critter (whole-partition sweep)', async (t) => {
    const sql = makeSql()
    expect(await awardCritterServer({ ...AWARDING, sql, eventType: t })).toBeNull()
    expect(sql.critterInserts()).toHaveLength(0)
  })

  it('the partition is non-empty (the sweep above cannot vacuously cover zero types)', () => {
    expect(NON_REWARD_EVENT_TYPES.length).toBeGreaterThan(0)
    expect(NON_REWARD_EVENT_TYPES).toContain('moisture_check')
  })

  // The chokepoint fails OPEN on an absent eventType, deliberately: a caller that omits it keeps
  // awarding rather than silently killing every critter in the app. Pinned so that nobody
  // "hardens" it into a fail-closed default without also auditing the call sites — and so the
  // wiring assertions below are understood as the PRIMARY control rather than belt-and-braces.
  it('an absent eventType fails OPEN at the chokepoint (documented, deliberate)', async () => {
    const sql = makeSql()
    const res = await awardCritterServer({ ...AWARDING, sql })
    expect(res?.id).toBe('c1')
  })
})

// Because of that deliberate fail-open, the guard is only actually enforced if BOTH call sites
// supply eventType. These two assertions are the anti-omission guard for exactly that — they are
// source-text (the handlers are not importable from repo root: their @aws-sdk / @clerk /
// @neondatabase deps are per-Lambda) and are deliberately scoped to the wiring, NOT to behavior.
// The behavioral proof is the executable suite above.
describe('BUG-CRITTERNONREWARD-001 — both call sites feed the chokepoint', () => {
  it('the single-POST hook gates on isRewardedEventType and passes eventType', () => {
    const src = readFileSync(join(here, 'index.js'), 'utf-8')
    expect(src).toMatch(/if \(!skipAward && newEvent\.plant_id && isRewardedEventType\(newEvent\.event_type\)\)/)
    expect(src).toMatch(/eventType: newEvent\.event_type,/)
  })

  it('the batch hook threads the batch event_type through', () => {
    const src = readFileSync(join(here, 'batchSideEffects.js'), 'utf-8')
    expect(src).toMatch(/awardCrittersForBatch\(\{[\s\S]{0,200}?eventType,?[\s\S]{0,40}?\}\)/)
  })
})
