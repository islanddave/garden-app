// V3-DELIGHT-001 D2 — server-side household sighting-tally increment.
// Deterministic guard for the events-hook -> tally coupling (the HTTP smoke can't prove it:
// the award is probabilistic AND the increment is non-fatal/swallowed). Asserts the tally
// upsert fires exactly once per GENUINE new award, never on no-award / idempotent re-hit /
// no-plant, and that a tally failure never breaks awarding.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./critterSpecies.js', () => ({
  pickSpecies: vi.fn(),
  pickCopyVariant: vi.fn(() => 0),
}))

import { pickSpecies } from './critterSpecies.js'
import { awardCritterServer } from './critterAward.js'

// Recording fake of the Neon tagged-template `sql`. Routes by query text:
//   critter_state INSERT  -> returns `critterRows`
//   garden_shared_state   -> returns [] (or throws if throwOnTally)
function makeSql({ critterRows = [], throwOnTally = false } = {}) {
  const calls = []
  const sql = (strings) => {
    const q = strings.join('?')
    calls.push(q)
    if (q.includes('public.critter_state')) return Promise.resolve(critterRows)
    if (q.includes('garden_shared_state')) {
      if (throwOnTally) return Promise.reject(new Error('tally db down'))
      return Promise.resolve([])
    }
    return Promise.resolve([])
  }
  sql.calls = calls
  sql.tallyCalls = () => calls.filter(q => q.includes('garden_shared_state'))
  return sql
}

const base = {
  userId: 'user_1', eventId: 'evt_1', plantId: 'plant_1',
  eventCreatedAt: '2026-06-07T00:00:00Z', householdId: 'user_1', tzOffsetMin: 0,
}

describe('awardCritterServer — D2 sighting tally increment', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('increments the tally exactly once on a genuine new award', async () => {
    pickSpecies.mockReturnValue(3)
    const sql = makeSql({ critterRows: [{ id: 'c1', species_id: 3, target_id: 'plant_1' }] })
    const res = await awardCritterServer({ sql, ...base })
    expect(res?.id).toBe('c1')
    const tally = sql.tallyCalls()
    expect(tally).toHaveLength(1)
    expect(tally[0]).toContain("'incentive_counter'")
  })

  it('does NOT increment when no critter is awarded (pickSpecies -> null)', async () => {
    pickSpecies.mockReturnValue(null)
    const sql = makeSql({ critterRows: [{ id: 'should-not-matter' }] })
    const res = await awardCritterServer({ sql, ...base })
    expect(res).toBeNull()
    expect(sql.tallyCalls()).toHaveLength(0)
  })

  it('does NOT increment on an idempotent re-hit (ON CONFLICT -> no row inserted)', async () => {
    pickSpecies.mockReturnValue(3)
    const sql = makeSql({ critterRows: [] }) // ON CONFLICT DO NOTHING -> empty
    const res = await awardCritterServer({ sql, ...base })
    expect(res).toBeNull()
    expect(sql.tallyCalls()).toHaveLength(0)
  })

  it('does NOT increment when plantId is missing (MVP plant-only no-op)', async () => {
    pickSpecies.mockReturnValue(3)
    const sql = makeSql({ critterRows: [{ id: 'c1' }] })
    const res = await awardCritterServer({ ...base, sql, plantId: null })
    expect(res).toBeNull()
    expect(sql.tallyCalls()).toHaveLength(0)
  })

  it('is non-fatal: a tally-increment failure still returns the awarded critter', async () => {
    pickSpecies.mockReturnValue(3)
    const sql = makeSql({ critterRows: [{ id: 'c1', species_id: 3 }], throwOnTally: true })
    const res = await awardCritterServer({ sql, ...base })
    expect(res?.id).toBe('c1')
    expect(sql.tallyCalls()).toHaveLength(1)
  })
})
