// V4-BATCHUNDO-001 — the pure half: normalising what GET /api/events/batches actually sends.
//
// The shapes asserted here are taken from the LIVE handler (lambda/events/index.js, the
// `/api/events/batches` arm), not invented: id, event_type, scope_json, item_count, event_date,
// created_at. The interesting cases are all about a number that is about to be printed on a
// destructive button — item_count arriving as a bigint STRING through the driver is the normal
// case, not the edge one, and a client that renders `NaN entries` over a 157-row batch has failed
// at the only job this confirm has.
import { describe, it, expect } from 'vitest'
import { BATCHES_PATH, batchUndoPath, normalizeBatches, undoableById, undoRowCount } from '../lib/batches.js'

const row = (over = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  event_type: 'watering',
  scope_json: { plant_ids: [] },
  item_count: 30,
  event_date: '2026-08-18',
  created_at: '2026-08-18T14:02:00.000Z',
  ...over,
})

describe('V4-BATCHUNDO-001 — batch route helpers', () => {
  it('targets the routes the deployed Lambda actually serves', () => {
    expect(BATCHES_PATH).toBe('/api/events/batches')
    expect(batchUndoPath('abc')).toBe('/api/events/batch/abc')
  })
})

describe('V4-BATCHUNDO-001 — normalizeBatches', () => {
  it('reads the documented { batches: [...] } envelope', () => {
    const out = normalizeBatches({ batches: [row()] })
    expect(out.length).toBe(1)
    expect(out[0].id).toBe(row().id)
    expect(out[0].event_type).toBe('watering')
    expect(out[0].item_count).toBe(30)
    expect(out[0].event_date).toBe('2026-08-18')
  })

  it('also accepts a bare array, so a shape change disables nothing silently', () => {
    expect(normalizeBatches([row()]).length).toBe(1)
  })

  it('coerces a bigint-as-string item_count to a real number', () => {
    expect(normalizeBatches({ batches: [row({ item_count: '157' })] })[0].item_count).toBe(157)
  })

  it('refuses to invent a count it does not have', () => {
    for (const bad of [null, undefined, 0, -3, 'many', NaN]) {
      expect(normalizeBatches({ batches: [row({ item_count: bad })] })[0].item_count, String(bad)).toBe(null)
    }
  })

  it('drops rows with no id — an id IS the DELETE path', () => {
    expect(normalizeBatches({ batches: [row({ id: null }), row()] }).length).toBe(1)
  })

  it('survives null, a non-object and a missing key', () => {
    expect(normalizeBatches(null)).toEqual([])
    expect(normalizeBatches(undefined)).toEqual([])
    expect(normalizeBatches({})).toEqual([])
    expect(normalizeBatches({ batches: null })).toEqual([])
  })
})

describe('V4-BATCHUNDO-001 — undoableById / undoRowCount', () => {
  it('keys the set by id so membership is the undoability test', () => {
    const m = undoableById({ batches: [row(), row({ id: 'b2', item_count: 4 })] })
    expect(m.size).toBe(2)
    expect(m.get('b2').item_count).toBe(4)
    expect(m.has('nope')).toBe(false)
  })

  it('prefers the batch record over the feed row, and falls back when it has none', () => {
    expect(undoRowCount({ item_count: 30 }, 12)).toBe(30)
    expect(undoRowCount({ item_count: null }, 12)).toBe(12)
    expect(undoRowCount(null, 12)).toBe(12)
    expect(undoRowCount(null, null)).toBe(null)
  })
})
