import { describe, it, expect } from 'vitest'
import { collapseFeed, dedupeById, relativeTime, prettyEventType } from '../lib/feed.js'

describe('collapseFeed', () => {
  it('passes non-batch rows through as count 1', () => {
    const out = collapseFeed([{ id: 'a', event_type: 'watering' }, { id: 'b', event_type: 'pruning' }])
    expect(out.map(r => r.id)).toEqual(['a', 'b'])
    expect(out.every(r => r.batch_count === 1)).toBe(true)
  })
  it('folds a batch into ONE entry using item_count (window-proof)', () => {
    const rows = [
      { id: 'e1', batch_id: 'B', item_count: 5, event_type: 'watering' },
      { id: 'e2', batch_id: 'B', item_count: 5, event_type: 'watering' },
    ]
    const out = collapseFeed(rows)
    expect(out).toHaveLength(1)
    expect(out[0].batch_count).toBe(5)
  })
  it('falls back to counted occurrences when item_count is missing', () => {
    const rows = [
      { id: 'e1', batch_id: 'B', event_type: 'watering' },
      { id: 'e2', batch_id: 'B', event_type: 'watering' },
      { id: 'e3', batch_id: 'B', event_type: 'watering' },
    ]
    expect(collapseFeed(rows)[0].batch_count).toBe(3)
  })
  it('surfaces a critter earned by any batch member on the collapsed entry', () => {
    const rows = [
      { id: 'e1', batch_id: 'B', item_count: 3 },
      { id: 'e2', batch_id: 'B', item_count: 3, critter_species_id: 7, critter_id: 'c7' },
    ]
    const out = collapseFeed(rows)
    expect(out[0].critter_species_id).toBe(7)
    expect(out[0].critter_id).toBe('c7')
  })
  it('keeps separate batches separate and preserves order', () => {
    const rows = [
      { id: 'e1', batch_id: 'A', item_count: 2 },
      { id: 'e2', batch_id: 'B', item_count: 2 },
      { id: 'e3', batch_id: 'A', item_count: 2 },
    ]
    expect(collapseFeed(rows).map(r => r.batch_id)).toEqual(['A', 'B'])
  })
})

describe('dedupeById', () => {
  it('removes duplicate ids preserving first-seen order', () => {
    expect(dedupeById([{ id: 1 }, { id: 2 }, { id: 1 }]).map(r => r.id)).toEqual([1, 2])
  })
})

describe('relativeTime', () => {
  it('returns just now for very recent', () => {
    expect(relativeTime(new Date().toISOString())).toBe('just now')
  })
  it('returns empty string for null/invalid', () => {
    expect(relativeTime(null)).toBe('')
    expect(relativeTime('not-a-date')).toBe('')
  })
  it('formats hours/days ago', () => {
    expect(relativeTime(new Date(Date.now() - 3 * 3600 * 1000).toISOString())).toBe('3h ago')
    expect(relativeTime(new Date(Date.now() - 2 * 86400 * 1000).toISOString())).toBe('2d ago')
  })
})

describe('prettyEventType', () => {
  it('replaces underscores with spaces', () => {
    expect(prettyEventType('pest_treatment')).toBe('pest treatment')
    expect(prettyEventType(null)).toBe('')
  })
})
