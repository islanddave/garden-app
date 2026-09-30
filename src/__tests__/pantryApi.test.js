// Put-Up B′ release 2 — src/lib/pantryApi.js, the ONE client helper for the Pantry routes (the pinned
// cross-lane contract). Each wrapper is asserted on THE WIRE: which verb, which path, which body — a
// helper that calls the wrong route is the same defect wearing a nicer name.
import { describe, it, expect, vi } from 'vitest'
import {
  pantryUrl, pantryRows, listPantry, createPantryItem, patchPantryItem, deletePantryItem, useJar, undoUse, ensurePlaceId,
} from '../lib/pantryApi.js'
import { apiError } from './helpers/pantryFake.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function spy(answer = null) {
  const f = vi.fn(() => Promise.resolve(answer))
  f.body = (i = 0) => JSON.parse(f.mock.calls[i][1].body)
  return f
}

describe('pantryUrl — GET /api/pantry?group=place|kind&q=&place_id=', () => {
  it('defaults to group=place and leaves every empty part out', () => {
    expect(pantryUrl()).toBe('/api/pantry?group=place')
    expect(pantryUrl({ group: 'kind', q: '  ', placeId: '' })).toBe('/api/pantry?group=kind')
  })
  it('carries q and place_id, encoded', () => {
    expect(pantryUrl({ group: 'place', q: 'hot sauce', placeId: 'loc-1' })).toBe('/api/pantry?group=place&q=hot+sauce&place_id=loc-1')
  })
  it('never sends a group the contract does not name', () => {
    expect(pantryUrl({ group: 'crop' })).toBe('/api/pantry?group=place')
  })
})

describe('listPantry', () => {
  it('reads { rows } — and a bare array — and never coerces anything else to rows', async () => {
    expect(pantryRows({ rows: [{ stock_id: 'a' }] })).toEqual([{ stock_id: 'a' }])
    expect(pantryRows([{ stock_id: 'b' }])).toEqual([{ stock_id: 'b' }])
    expect(pantryRows({ groups: [] })).toEqual([])
    expect(pantryRows(null)).toEqual([])
    const f = spy({ rows: [{ stock_id: 'a' }] })
    expect(await listPantry(f, { group: 'kind' })).toEqual([{ stock_id: 'a' }])
    expect(f.mock.calls[0][0]).toBe('/api/pantry?group=kind')
  })
})

describe('the bought-item writes', () => {
  it('createPantryItem POSTs the body with the caller\'s key, or mints one', async () => {
    const f = spy({ item: { id: 'i1' } })
    await createPantryItem(f, { idempotency_key: 'k-1', name: 'Oat milk', storage_location_id: 'loc-3' })
    expect(f.mock.calls[0][0]).toBe('/api/pantry/items')
    expect(f.mock.calls[0][1].method).toBe('POST')
    expect(f.body()).toEqual({ idempotency_key: 'k-1', name: 'Oat milk', storage_location_id: 'loc-3' })
    await createPantryItem(f, { name: 'Bread', place: { kind: 'pantry', label: 'Pantry shelf' } })
    expect(f.body(1).idempotency_key).toMatch(UUID)
  })
  it('patchPantryItem sends only the keys given (presence-sentinel), used_up_at "now" and null', async () => {
    const f = spy({ item: {} })
    await patchPantryItem(f, 'item 1', { used_up_at: 'now' })
    expect(f.mock.calls[0][0]).toBe('/api/pantry/items/item%201')
    expect(f.mock.calls[0][1].method).toBe('PATCH')
    expect(f.body()).toEqual({ used_up_at: 'now' })
    await patchPantryItem(f, 'i2', { used_up_at: null })
    expect(f.body(1)).toEqual({ used_up_at: null })
  })
  it('deletePantryItem is a DELETE of the item', async () => {
    const f = spy({ ok: true })
    await deletePantryItem(f, 'i9')
    expect(f.mock.calls[0]).toEqual(['/api/pantry/items/i9', { method: 'DELETE' }])
  })
})

describe('uses', () => {
  it('useJar POSTs /api/pantry/uses with a key per tap', async () => {
    const f = spy({ use: { id: 'u1' }, jar: {} })
    await useJar(f, { preservation_log_id: 'j1', count_used: 1 })
    await useJar(f, { preservation_log_id: 'j1', all_remaining: true, fate: 'discarded' })
    expect(f.mock.calls[0][0]).toBe('/api/pantry/uses')
    expect(f.body(0)).toMatchObject({ preservation_log_id: 'j1', count_used: 1 })
    expect(f.body(1)).toMatchObject({ preservation_log_id: 'j1', all_remaining: true, fate: 'discarded' })
    expect(f.body(0).idempotency_key).toMatch(UUID)
    expect(f.body(0).idempotency_key).not.toBe(f.body(1).idempotency_key)
  })
  it('a retry passes the SAME key back in', async () => {
    const f = spy({})
    await useJar(f, { preservation_log_id: 'j1', count_used: 1, idempotency_key: 'same' })
    expect(f.body().idempotency_key).toBe('same')
  })
  it('undoUse POSTs /api/pantry/uses/:id/undo with {idempotency_key} and nothing else', async () => {
    const f = spy({ use: { id: 'u2' } })
    await undoUse(f, 'u1', { idempotencyKey: 'undo-1' })
    expect(f.mock.calls[0][0]).toBe('/api/pantry/uses/u1/undo')
    expect(f.mock.calls[0][1].method).toBe('POST')
    expect(f.body()).toEqual({ idempotency_key: 'undo-1' })
  })
  it('a refusal is thrown as it came (the caller reads .body.code)', async () => {
    const f = vi.fn(() => Promise.reject(apiError(409, { error: 'That use was already undone.', code: 'already_undone' })))
    await expect(undoUse(f, 'u1')).rejects.toMatchObject({ status: 409, body: { code: 'already_undone' } })
  })
})

describe('ensurePlaceId', () => {
  it('returns a chip\'s own id without a write', async () => {
    const f = spy()
    expect(await ensurePlaceId(f, { id: 'loc-1', label: 'X', kind: 'fridge' })).toBe('loc-1')
    expect(f).not.toHaveBeenCalled()
  })
  it('makes a template place through the storage find-or-create', async () => {
    const f = spy({ id: 'loc-9', label: 'Fridge', kind: 'fridge', existing: true })
    expect(await ensurePlaceId(f, { id: null, label: ' Fridge ', kind: 'fridge' })).toBe('loc-9')
    expect(f.mock.calls[0][0]).toBe('/api/storage-locations')
    expect(f.body()).toEqual({ label: 'Fridge', kind: 'fridge' })
  })
  it('a place_exists refusal names the place meant', async () => {
    const f = vi.fn(() => Promise.reject(apiError(409, { code: 'place_exists', existing_id: 'loc-2' })))
    expect(await ensurePlaceId(f, { label: 'Fridge', kind: 'fridge' })).toBe('loc-2')
  })
})
