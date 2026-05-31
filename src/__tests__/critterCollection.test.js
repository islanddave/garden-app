import { describe, it, expect } from 'vitest'
import {
  rosterIdFromSpriteFilename,
  ROSTER_ID_BY_SPECIES_ID,
  indexCollectionRows,
} from '../lib/critterCollection.js'
import { SPECIES_POOL } from '../lib/critterSpecies.js'

describe('critterCollection — rosterIdFromSpriteFilename', () => {
  it('extracts roster id from a well-formed sprite filename', () => {
    expect(rosterIdFromSpriteFilename('C013-american-robin.svg')).toBe('C013')
    expect(rosterIdFromSpriteFilename('C001-honeybee.svg')).toBe('C001')
    expect(rosterIdFromSpriteFilename('C168-cryptid-thing.svg')).toBe('C168')
  })
  it('returns null on non-string or empty', () => {
    expect(rosterIdFromSpriteFilename('')).toBeNull()
    expect(rosterIdFromSpriteFilename(null)).toBeNull()
    expect(rosterIdFromSpriteFilename(undefined)).toBeNull()
    expect(rosterIdFromSpriteFilename(42)).toBeNull()
  })
  it('returns null on filename without C{NNN}- prefix', () => {
    expect(rosterIdFromSpriteFilename('honeybee.svg')).toBeNull()
    expect(rosterIdFromSpriteFilename('-foo.svg')).toBeNull()
    expect(rosterIdFromSpriteFilename('C-foo.svg')).toBeNull()
  })
})

describe('critterCollection — ROSTER_ID_BY_SPECIES_ID', () => {
  it('maps every SPECIES_POOL entry to a roster id', () => {
    for (const s of SPECIES_POOL) {
      expect(ROSTER_ID_BY_SPECIES_ID[s.species_id]).toBeTruthy()
      expect(ROSTER_ID_BY_SPECIES_ID[s.species_id]).toMatch(/^C\d+$/)
    }
  })
  it('is frozen at module load', () => {
    expect(Object.isFrozen(ROSTER_ID_BY_SPECIES_ID)).toBe(true)
  })
  it('maps the documented MVP-Critter pool to expected roster ids', () => {
    expect(ROSTER_ID_BY_SPECIES_ID[1]).toBe('C013')
    expect(ROSTER_ID_BY_SPECIES_ID[2]).toBe('C001')
    expect(ROSTER_ID_BY_SPECIES_ID[3]).toBe('C050')
    expect(ROSTER_ID_BY_SPECIES_ID[8]).toBe('C007')
  })
})

describe('critterCollection — indexCollectionRows', () => {
  it('returns an empty Map for non-array inputs', () => {
    expect(indexCollectionRows(null).size).toBe(0)
    expect(indexCollectionRows(undefined).size).toBe(0)
    expect(indexCollectionRows({}).size).toBe(0)
    expect(indexCollectionRows('nope').size).toBe(0)
  })
  it('returns an empty Map for an empty input array', () => {
    expect(indexCollectionRows([]).size).toBe(0)
  })
  it('indexes a typical backend response by roster id', () => {
    const rows = [
      { species_id: 3, count: 5, first_seen_at: '2026-05-01T10:00:00Z', last_seen_at: '2026-05-30T09:00:00Z' },
      { species_id: 8, count: 1, first_seen_at: '2026-05-29T22:00:00Z', last_seen_at: '2026-05-29T22:00:00Z' },
    ]
    const m = indexCollectionRows(rows)
    expect(m.size).toBe(2)
    expect(m.get('C050')).toEqual({
      speciesId: 3, count: 5,
      firstSeenAt: '2026-05-01T10:00:00Z', lastSeenAt: '2026-05-30T09:00:00Z',
    })
    expect(m.get('C007')).toEqual({
      speciesId: 8, count: 1,
      firstSeenAt: '2026-05-29T22:00:00Z', lastSeenAt: '2026-05-29T22:00:00Z',
    })
  })
  it('drops rows with species_id outside SPECIES_POOL (forward-compat)', () => {
    const rows = [
      { species_id: 3, count: 1, first_seen_at: '2026-05-01T10:00:00Z' },
      { species_id: 99, count: 1, first_seen_at: '2026-05-01T10:00:00Z' },
      { species_id: 255, count: 1, first_seen_at: '2026-05-01T10:00:00Z' },
    ]
    const m = indexCollectionRows(rows)
    expect(m.size).toBe(1)
    expect(m.has('C050')).toBe(true)
  })
  it('defaults count to 0 and timestamps to null when missing', () => {
    const m = indexCollectionRows([{ species_id: 3 }])
    expect(m.get('C050')).toEqual({
      speciesId: 3, count: 0, firstSeenAt: null, lastSeenAt: null,
    })
  })
  it('drops rows with missing or non-numeric species_id', () => {
    const m = indexCollectionRows([
      { species_id: null, count: 5 },
      { species_id: 'three', count: 5 },
      { count: 5 },
    ])
    expect(m.size).toBe(0)
  })
})
