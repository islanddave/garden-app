/**
 * src/__tests__/useInventory.test.js
 * Unit tests for useInventory hook — covers load, create, update,
 * adjustQuantity (optimistic + revert), deleteItem, lowStockCount.
 *
 * Strategy: mock useApiFetch from src/lib/api.js so tests run with no network,
 * no Clerk dep. Each test gets a fresh fetch spy with controllable responses.
 *
 * NOTE on vi.hoisted: vi.mock is hoisted to top of file. The fetchSpy reference
 * inside the mock factory must also be hoisted (via vi.hoisted) so it exists at
 * the time vi.mock evaluates its factory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))

vi.mock('../lib/api.js', () => ({
  useApiFetch: () => ({ fetch: fetchSpy }),
}))

import { useInventory } from '../hooks/useInventory.js'

const SAMPLE_CONSUMABLE = {
  id: 'item-1',
  type: 'consumable',
  name: 'Test Seeds',
  category: 'seeds',
  quantity_on_hand: 10,
  unit: 'packet',
  reorder_threshold: 3,
  reorder_quantity: 5,
  status: 'active',
  deleted_at: null,
  created_by: 'user_test',
  user_id: 'user_test',
}

const SAMPLE_DURABLE = {
  id: 'item-2',
  type: 'durable',
  name: 'Test Trowel',
  category: 'tools',
  quantity: 1,
  condition: 'good',
  status: 'active',
  deleted_at: null,
  created_by: 'user_test',
  user_id: 'user_test',
}

const SAMPLE_LOW_STOCK = {
  ...SAMPLE_CONSUMABLE,
  id: 'item-3',
  name: 'Low Stock Seeds',
  quantity_on_hand: 2,
  reorder_threshold: 3,
}

beforeEach(() => {
  fetchSpy.mockReset()
})

afterEach(() => {
  vi.clearAllTimers()
})

describe('useInventory — load', () => {
  it('starts in loading state and populates items on mount', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_CONSUMABLE, SAMPLE_DURABLE])
    const { result } = renderHook(() => useInventory())

    expect(result.current.loading).toBe(true)
    expect(result.current.items).toEqual([])

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items).toHaveLength(2)
    expect(result.current.error).toBeNull()
    expect(fetchSpy).toHaveBeenCalledWith('/api/inventory-items')
  })

  it('sets error on load failure', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('network down'))
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('network down')
    expect(result.current.items).toEqual([])
  })

  it('handles non-array response gracefully', async () => {
    fetchSpy.mockResolvedValueOnce(null)
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items).toEqual([])
  })

  it('reload re-fetches the list', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_CONSUMABLE])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    fetchSpy.mockResolvedValueOnce([SAMPLE_CONSUMABLE, SAMPLE_DURABLE])
    await act(async () => { await result.current.reload() })
    expect(result.current.items).toHaveLength(2)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})

describe('useInventory — lowStockCount', () => {
  it('counts consumables at/below reorder_threshold', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_CONSUMABLE, SAMPLE_LOW_STOCK, SAMPLE_DURABLE])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.lowStockCount).toBe(1)
  })

  it('ignores items with null reorder_threshold', async () => {
    const noThreshold = { ...SAMPLE_CONSUMABLE, reorder_threshold: null, quantity_on_hand: 0 }
    fetchSpy.mockResolvedValueOnce([noThreshold])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.lowStockCount).toBe(0)
  })

  it('treats null quantity_on_hand as 0 for threshold comparison', async () => {
    const nullQty = { ...SAMPLE_CONSUMABLE, quantity_on_hand: null, reorder_threshold: 3 }
    fetchSpy.mockResolvedValueOnce([nullQty])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.lowStockCount).toBe(1)
  })

  it('does not count durables', async () => {
    const durableLowQty = { ...SAMPLE_DURABLE, reorder_threshold: 5, quantity_on_hand: 0 }
    fetchSpy.mockResolvedValueOnce([durableLowQty])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.lowStockCount).toBe(0)
  })
})

describe('useInventory — createItem', () => {
  it('POSTs to /api/inventory-items and prepends result', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_CONSUMABLE])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const newItem = { ...SAMPLE_DURABLE, id: 'item-new' }
    fetchSpy.mockResolvedValueOnce(newItem)

    let res
    await act(async () => { res = await result.current.createItem({ name: 'Test', type: 'durable', category: 'tools', quantity: 1 }) })
    expect(res).toEqual({ item: newItem })
    expect(result.current.items[0].id).toBe('item-new')
    expect(result.current.items).toHaveLength(2)
    expect(fetchSpy).toHaveBeenLastCalledWith('/api/inventory-items', expect.objectContaining({ method: 'POST' }))
  })

  it('returns error on POST failure without modifying list', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_CONSUMABLE])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    fetchSpy.mockRejectedValueOnce(new Error('400 Bad Request'))
    let res
    await act(async () => { res = await result.current.createItem({ name: '' }) })
    expect(res).toEqual({ error: '400 Bad Request' })
    expect(result.current.items).toHaveLength(1)
  })
})

describe('useInventory — updateItem', () => {
  it('PUTs to /api/inventory-items/:id with merged payload', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_CONSUMABLE])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const updated = { ...SAMPLE_CONSUMABLE, name: 'Renamed' }
    fetchSpy.mockResolvedValueOnce(updated)

    let res
    await act(async () => { res = await result.current.updateItem('item-1', { name: 'Renamed' }) })
    expect(res).toEqual({ item: updated })
    expect(result.current.items[0].name).toBe('Renamed')
    const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1]
    expect(lastCall[0]).toBe('/api/inventory-items/item-1')
    expect(lastCall[1].method).toBe('PUT')
    const body = JSON.parse(lastCall[1].body)
    expect(body.name).toBe('Renamed')
    expect(body.id).toBe('item-1')
  })

  it('returns error on PUT failure', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_CONSUMABLE])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    fetchSpy.mockRejectedValueOnce(new Error('409 Conflict'))
    let res
    await act(async () => { res = await result.current.updateItem('item-1', { name: 'X' }) })
    expect(res).toEqual({ error: '409 Conflict' })
  })

  // Same stale-closure class the undo path had (BUG-INVUNDOQTY-001): `items` came from the render
  // that produced this callback, so an instance held across a list change merges the row as it was
  // THEN. LATENT, not live — every shipped call site (InventoryDetail.handleSave) invokes the
  // current render's instance — but the hook's contract at the top of the file promises a merge
  // against "current item in list", and only the ref makes "current" mean live. Captured here
  // explicitly because that is the only shape in which the defect exists.
  // Pre-fix failure: `expected 10 to be 11` on the quantity_on_hand assertion.
  it('merges against the live row, not the render that produced the callback', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_CONSUMABLE])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const held = result.current.updateItem

    fetchSpy.mockResolvedValueOnce({ ...SAMPLE_CONSUMABLE, quantity_on_hand: 11 })
    await act(async () => { await result.current.adjustQuantity('item-1', 1) })
    expect(result.current.items[0].quantity_on_hand).toBe(11)

    fetchSpy.mockResolvedValueOnce({ ...SAMPLE_CONSUMABLE, quantity_on_hand: 11, name: 'Renamed' })
    await act(async () => { await held('item-1', { name: 'Renamed' }) })

    const puts = fetchSpy.mock.calls.filter(c => c[1]?.method === 'PUT')
    const body = JSON.parse(puts[puts.length - 1][1].body)
    expect(body.name).toBe('Renamed')
    expect(body.quantity_on_hand).toBe(11)
  })

  it('passes payload through when item not in current list', async () => {
    fetchSpy.mockResolvedValueOnce([])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    fetchSpy.mockResolvedValueOnce(SAMPLE_CONSUMABLE)
    await act(async () => { await result.current.updateItem('item-1', { name: 'X', type: 'consumable' }) })
    const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1]
    const body = JSON.parse(lastCall[1].body)
    expect(body.name).toBe('X')
    expect(body.id).toBeUndefined()
  })
})

describe('useInventory — adjustQuantity', () => {
  it('optimistically updates qty then confirms with server response', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_CONSUMABLE])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const serverUpdated = { ...SAMPLE_CONSUMABLE, quantity_on_hand: 11 }
    fetchSpy.mockResolvedValueOnce(serverUpdated)

    await act(async () => { await result.current.adjustQuantity('item-1', 1) })
    expect(result.current.items[0].quantity_on_hand).toBe(11)
    expect(result.current.toast?.msg).toContain('11')
  })

  it('reverts optimistic update on server error', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_CONSUMABLE])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    fetchSpy.mockRejectedValueOnce(new Error('500 Server Error'))
    await act(async () => { await result.current.adjustQuantity('item-1', 1) })
    expect(result.current.items[0].quantity_on_hand).toBe(10)
    expect(result.current.toast?.msg).toMatch(/couldn't save/i)
  })

  it('clamps to 0 — never goes negative', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_CONSUMABLE])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    fetchSpy.mockResolvedValueOnce({ ...SAMPLE_CONSUMABLE, quantity_on_hand: 0 })
    await act(async () => { await result.current.adjustQuantity('item-1', -100) })
    expect(result.current.items[0].quantity_on_hand).toBe(0)
  })

  it('adjusts `quantity` column for durables (P4, 2026-05-18)', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_DURABLE])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const serverUpdated = { ...SAMPLE_DURABLE, quantity: 2 }
    fetchSpy.mockResolvedValueOnce(serverUpdated)

    await act(async () => { await result.current.adjustQuantity('item-2', 1) })
    expect(result.current.items[0].quantity).toBe(2)
    // Verify body targets `quantity`, NOT `quantity_on_hand`
    const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1]
    const body = JSON.parse(lastCall[1].body)
    expect(body.quantity).toBe(2)
    expect(body.quantity_on_hand).toBeUndefined()
  })

  it('clamps durable quantity to 0', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_DURABLE])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    fetchSpy.mockResolvedValueOnce({ ...SAMPLE_DURABLE, quantity: 0 })
    await act(async () => { await result.current.adjustQuantity('item-2', -100) })
    expect(result.current.items[0].quantity).toBe(0)
  })

  it('reverts durable optimistic update on server error', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_DURABLE])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    fetchSpy.mockRejectedValueOnce(new Error('500 Server Error'))
    await act(async () => { await result.current.adjustQuantity('item-2', 1) })
    expect(result.current.items[0].quantity).toBe(1)
    expect(result.current.toast?.msg).toMatch(/couldn't save/i)
  })

  it('no-ops on unknown id', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_CONSUMABLE])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => { await result.current.adjustQuantity('nonexistent', 1) })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('no-ops when delta would not change value (qty 0, delta 0)', async () => {
    const zeroQty = { ...SAMPLE_CONSUMABLE, quantity_on_hand: 0 }
    fetchSpy.mockResolvedValueOnce([zeroQty])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => { await result.current.adjustQuantity('item-1', 0) })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  // BUG-INVUNDOQTY-001: undo re-enters adjustQuantity, which must read the POST-change
  // quantity. Reading the render closure's `items` gives the pre-change 10, so the -1
  // reverse delta lands on 10 and writes 9 — off by twice the delta. Fails `received: 9`
  // against the pre-fix hook.
  it('undo restores the ORIGINAL quantity, not original-minus-delta (BUG-INVUNDOQTY-001)', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_CONSUMABLE])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    fetchSpy.mockResolvedValueOnce({ ...SAMPLE_CONSUMABLE, quantity_on_hand: 11 })
    await act(async () => { await result.current.adjustQuantity('item-1', 1) })
    expect(result.current.items[0].quantity_on_hand).toBe(11)

    fetchSpy.mockResolvedValueOnce({ ...SAMPLE_CONSUMABLE, quantity_on_hand: 10 })
    await act(async () => { await result.current.toast.onUndo() })

    const puts = fetchSpy.mock.calls.filter(c => c[1]?.method === 'PUT')
    expect(JSON.parse(puts[1][1].body).quantity_on_hand).toBe(10)
    expect(result.current.items[0].quantity_on_hand).toBe(10)
  })

  // The window the BUG-INVUNDOQTY-001 fix neither opened nor closed: itemsRef was mirrored only by
  // an effect, so two adjustments issued inside ONE commit both read the pre-tap row. The absence
  // of an await between the two calls IS the test — put one there and the effect runs, the ref
  // catches up, and the defect stops reproducing. No fake timers, deliberately: the window is a
  // React commit boundary, not an interval, and a punctual timer would land the same side of it
  // every run whether or not the bug were present.
  // Pre-fix failure: `expected 11 to be 12` — the second PUT re-sent the first one's value, a
  // silently lost increment with no error, no revert, and no second toast to show it.
  it('a second adjustment in the same commit reads the first one\'s value', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_CONSUMABLE])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    fetchSpy.mockResolvedValueOnce({ ...SAMPLE_CONSUMABLE, quantity_on_hand: 11 })
    fetchSpy.mockResolvedValueOnce({ ...SAMPLE_CONSUMABLE, quantity_on_hand: 12 })

    await act(async () => {
      const first  = result.current.adjustQuantity('item-1', 1)
      const second = result.current.adjustQuantity('item-1', 1)
      await Promise.all([first, second])
    })

    const puts = fetchSpy.mock.calls.filter(c => c[1]?.method === 'PUT')
    expect(puts).toHaveLength(2)
    expect(JSON.parse(puts[0][1].body).quantity_on_hand).toBe(11)
    expect(JSON.parse(puts[1][1].body).quantity_on_hand).toBe(12)
    expect(result.current.items[0].quantity_on_hand).toBe(12)
  })
})

describe('useInventory — deleteItem', () => {
  it('DELETEs and removes item from list', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_CONSUMABLE, SAMPLE_DURABLE])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    fetchSpy.mockResolvedValueOnce({ ok: true })
    let res
    await act(async () => { res = await result.current.deleteItem('item-1') })
    expect(res).toEqual({ ok: true })
    expect(result.current.items).toHaveLength(1)
    expect(result.current.items[0].id).toBe('item-2')
    const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1]
    expect(lastCall[0]).toBe('/api/inventory-items/item-1')
    expect(lastCall[1].method).toBe('DELETE')
  })

  it('returns error on DELETE failure without modifying list', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_CONSUMABLE])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    fetchSpy.mockRejectedValueOnce(new Error('404 Not Found'))
    let res
    await act(async () => { res = await result.current.deleteItem('item-1') })
    expect(res).toEqual({ error: '404 Not Found' })
    expect(result.current.items).toHaveLength(1)
  })
})

describe('useInventory — toast', () => {
  it('dismissToast clears toast immediately', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_CONSUMABLE])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    fetchSpy.mockResolvedValueOnce({ ...SAMPLE_CONSUMABLE, quantity_on_hand: 11 })
    await act(async () => { await result.current.adjustQuantity('item-1', 1) })
    expect(result.current.toast).not.toBeNull()

    act(() => { result.current.dismissToast() })
    expect(result.current.toast).toBeNull()
  })
})

// ── BUG-INVPUTREORDER-001 — the response that is allowed to win ─────────────────────────────────
//
// Every OPTIMISTIC path here was already correct: commitItems assigns itemsRef synchronously, so two
// taps landing in one commit compound properly (BUG-INVUNDOQTY-001's fix). What was never guarded is
// the RESPONSE. Two + taps issue PUT(11) then PUT(12); nothing about HTTP guarantees they come back
// in that order, and the handler applied whichever landed last — so a late PUT(11) response wrote
// the older server row over the newer one and the display settled on 11. No error, no revert, and
// the toast named the wrong number.
//
// These tests CONTROL the resolution order with deferred promises rather than hoping for a race.
// A test that fired two adjustments and awaited them would resolve in issue order and prove nothing:
// the defect only appears when the FIRST request finishes LAST.
describe('useInventory — adjustQuantity out-of-order responses (BUG-INVPUTREORDER-001)', () => {
  const deferred = () => {
    let resolve, reject
    const promise = new Promise((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }

  it('an EARLIER response landing last does not clobber the later value', async () => {
    fetchSpy.mockResolvedValueOnce([SAMPLE_CONSUMABLE])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const first = deferred()
    const second = deferred()
    fetchSpy.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    // Two taps, neither settled. Not awaited — awaiting the first would serialise them and remove
    // the very interleaving under test.
    let p1, p2
    act(() => { p1 = result.current.adjustQuantity('item-1', 1) })   // 10 -> 11
    act(() => { p2 = result.current.adjustQuantity('item-1', 1) })   // 11 -> 12
    expect(result.current.items[0].quantity_on_hand).toBe(12)

    // The LATER request answers first — the realistic shape of the race.
    await act(async () => {
      second.resolve({ ...SAMPLE_CONSUMABLE, quantity_on_hand: 12 })
      await p2
    })
    expect(result.current.items[0].quantity_on_hand).toBe(12)

    // ...and the EARLIER one answers afterwards, carrying the stale row. It must be dropped.
    await act(async () => {
      first.resolve({ ...SAMPLE_CONSUMABLE, quantity_on_hand: 11 })
      await p1
    })
    expect(result.current.items[0].quantity_on_hand, 'a superseded response overwrote the newer value').toBe(12)
  })

  it('the superseded response does not fire a toast naming its own number', async () => {
    // The toast is not cosmetic here: its undo closure reverses THIS request's delta, so a toast
    // from a superseded write offers to undo a change that is no longer on screen.
    fetchSpy.mockResolvedValueOnce([SAMPLE_CONSUMABLE])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const first = deferred()
    const second = deferred()
    fetchSpy.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    let p1, p2
    act(() => { p1 = result.current.adjustQuantity('item-1', 1) })
    act(() => { p2 = result.current.adjustQuantity('item-1', 1) })

    await act(async () => { second.resolve({ ...SAMPLE_CONSUMABLE, quantity_on_hand: 12 }); await p2 })
    await act(async () => { first.resolve({ ...SAMPLE_CONSUMABLE, quantity_on_hand: 11 }); await p1 })

    expect(result.current.toast?.msg).toContain('12')
    expect(result.current.toast?.msg).not.toContain('11')
  })

  it('a superseded FAILURE does not revert a change the user can still see', async () => {
    // The more damaging half. `prevValue` inside the first call is 10 — its own pre-tap number — so
    // an unguarded revert would discard the second tap entirely and land on 10 while the second
    // request was still in flight and would go on to succeed.
    fetchSpy.mockResolvedValueOnce([SAMPLE_CONSUMABLE])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const first = deferred()
    const second = deferred()
    fetchSpy.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    let p1, p2
    act(() => { p1 = result.current.adjustQuantity('item-1', 1) })   // 10 -> 11
    act(() => { p2 = result.current.adjustQuantity('item-1', 1) })   // 11 -> 12

    await act(async () => { first.reject(new Error('500 Server Error')); await p1 })
    expect(result.current.items[0].quantity_on_hand, 'a superseded failure reverted past a live change').toBe(12)
    expect(result.current.toast?.msg ?? '').not.toMatch(/couldn't save/i)

    await act(async () => { second.resolve({ ...SAMPLE_CONSUMABLE, quantity_on_hand: 12 }); await p2 })
    expect(result.current.items[0].quantity_on_hand).toBe(12)
  })

  it('the LATEST request still reverts on its own failure', async () => {
    // The guard must not swallow real errors — only superseded ones. With nothing issued after it,
    // a failing write is still the latest and must revert and say so.
    fetchSpy.mockResolvedValueOnce([SAMPLE_CONSUMABLE])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    fetchSpy.mockRejectedValueOnce(new Error('500 Server Error'))
    await act(async () => { await result.current.adjustQuantity('item-1', 1) })
    expect(result.current.items[0].quantity_on_hand).toBe(10)
    expect(result.current.toast?.msg).toMatch(/couldn't save/i)
  })

  it('sequences are PER ITEM — a write to one item cannot supersede a write to another', async () => {
    // The counter is keyed by id. A single global sequence would make any second tap anywhere
    // silently discard an in-flight response for an unrelated row.
    fetchSpy.mockResolvedValueOnce([SAMPLE_CONSUMABLE, SAMPLE_DURABLE])
    const { result } = renderHook(() => useInventory())
    await waitFor(() => expect(result.current.loading).toBe(false))

    const a = deferred()
    const b = deferred()
    fetchSpy.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)

    let pa, pb
    act(() => { pa = result.current.adjustQuantity('item-1', 1) })   // consumable 10 -> 11
    act(() => { pb = result.current.adjustQuantity('item-2', 1) })   // durable    1  -> 2

    // item-2 answers first; item-1's response is later but is NOT superseded — different item.
    await act(async () => { b.resolve({ ...SAMPLE_DURABLE, quantity: 2 }); await pb })
    await act(async () => { a.resolve({ ...SAMPLE_CONSUMABLE, quantity_on_hand: 11 }); await pa })

    expect(result.current.items.find(i => i.id === 'item-1').quantity_on_hand).toBe(11)
    expect(result.current.items.find(i => i.id === 'item-2').quantity).toBe(2)
  })
})
