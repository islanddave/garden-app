// V5-SEEDSTAB-001 — the − / + stepper as a store-agnostic function (src/lib/quantityAdjuster.js).
//
// useInventory.test.js still drives it through the Inventory list's hook. This suite drives it
// against a DIFFERENT store — a plain array behind a ref, the shape My seeds hands it — to prove the
// two guards travel with the logic rather than with the hook they were written in:
//   BUG-INVPUTREORDER-001 — a superseded response (or failure) is dropped;
//   BUG-INVUNDOQTY-001    — undo reverses against the row as it is NOW.
import { describe, it, expect, vi } from 'vitest'
import { createQuantityAdjuster, wideBody } from '../lib/quantityAdjuster.js'

function makeStore(rows) {
  const ref = { current: rows }
  return {
    ref,
    getRow: (id) => ref.current.find((r) => r.id === id),
    commitRow: (id, next) => { ref.current = ref.current.map((r) => (r.id === id ? next(r) : r)) },
  }
}

const deferred = () => {
  let resolve, reject
  const p = new Promise((res, rej) => { resolve = res; reject = rej })
  return { p, resolve, reject }
}

describe('createQuantityAdjuster against a non-useInventory store', () => {
  it('writes the optimistic value at once, then takes the server row (merged when asked)', async () => {
    const store = makeStore([{ id: 'a', type: 'consumable', quantity_on_hand: 2, crop_slug: 'tomato' }])
    const fetch = vi.fn().mockResolvedValue({ id: 'a', type: 'consumable', quantity_on_hand: 1 })
    const showToast = vi.fn()
    const adjust = createQuantityAdjuster({
      fetch, ...store, showToast,
      applyServerRow: (row, updated) => ({ ...row, ...updated }),
    })
    const pending = adjust('a', -1)
    expect(store.getRow('a').quantity_on_hand).toBe(1)        // optimistic, before the PUT settles
    await pending
    expect(store.getRow('a')).toEqual({ id: 'a', type: 'consumable', quantity_on_hand: 1, crop_slug: 'tomato' })
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ msg: 'Quantity changed to 1' }))
  })

  it('never goes below zero and issues no write for a no-op', async () => {
    const store = makeStore([{ id: 'a', type: 'consumable', quantity_on_hand: 0 }])
    const fetch = vi.fn()
    await createQuantityAdjuster({ fetch, ...store, showToast: vi.fn() })('a', -1)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('sends buildBody’s body, not the raw row', async () => {
    const store = makeStore([{ id: 'a', type: 'consumable', quantity_on_hand: 1, seed_stage: 'drying', source_id: 's1' }])
    const fetch = vi.fn().mockResolvedValue({})
    const buildBody = (row, col, v) => {
      const { seed_stage, source_id, ...rest } = row  // eslint-disable-line no-unused-vars
      return { ...rest, [col]: v }
    }
    await createQuantityAdjuster({ fetch, ...store, showToast: vi.fn(), buildBody })('a', +1)
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body.quantity_on_hand).toBe(2)
    expect('seed_stage' in body).toBe(false)
    expect('source_id' in body).toBe(false)
    // And the default is the shipped whole-row body.
    expect(wideBody({ a: 1, q: 1 }, 'q', 2)).toEqual({ a: 1, q: 2 })
  })

  it('BUG-INVPUTREORDER-001: an older response landing LAST does not rewind the row', async () => {
    const store = makeStore([{ id: 'a', type: 'consumable', quantity_on_hand: 2 }])
    const first = deferred()
    const second = deferred()
    const fetch = vi.fn().mockReturnValueOnce(first.p).mockReturnValueOnce(second.p)
    const showToast = vi.fn()
    const adjust = createQuantityAdjuster({ fetch, ...store, showToast })
    const a = adjust('a', +1)   // PUT(3)
    const b = adjust('a', +1)   // PUT(4)
    second.resolve({ id: 'a', type: 'consumable', quantity_on_hand: 4 })
    await b
    first.resolve({ id: 'a', type: 'consumable', quantity_on_hand: 3 })
    await a
    expect(store.getRow('a').quantity_on_hand).toBe(4)
    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast.mock.calls[0][0].msg).toBe('Quantity changed to 4')
  })

  it('BUG-INVPUTREORDER-001: a superseded FAILURE does not revert a newer tap', async () => {
    const store = makeStore([{ id: 'a', type: 'consumable', quantity_on_hand: 2 }])
    const first = deferred()
    const fetch = vi.fn().mockReturnValueOnce(first.p).mockResolvedValueOnce({ id: 'a', type: 'consumable', quantity_on_hand: 4 })
    const adjust = createQuantityAdjuster({ fetch, ...store, showToast: vi.fn() })
    const a = adjust('a', +1)
    await adjust('a', +1)
    first.reject(new Error('timeout'))
    await a
    expect(store.getRow('a').quantity_on_hand).toBe(4)
  })

  it('a failure that is still the latest reverts to its own pre-tap value', async () => {
    const store = makeStore([{ id: 'a', type: 'consumable', quantity_on_hand: 2 }])
    const fetch = vi.fn().mockRejectedValue(new Error('500'))
    const showToast = vi.fn()
    await createQuantityAdjuster({ fetch, ...store, showToast })('a', -1)
    expect(store.getRow('a').quantity_on_hand).toBe(2)
    expect(showToast).toHaveBeenCalledWith({ msg: "Couldn't save — please try again" })
  })

  it('BUG-INVUNDOQTY-001: undo reverses against the live row (2 → 3 → undo → 2, never 1)', async () => {
    const store = makeStore([{ id: 'a', type: 'consumable', quantity_on_hand: 2 }])
    const fetch = vi.fn().mockImplementation((url, opts) => Promise.resolve({ id: 'a', type: 'consumable', ...JSON.parse(opts.body) }))
    const showToast = vi.fn()
    const adjust = createQuantityAdjuster({ fetch, ...store, showToast })
    await adjust('a', +1)
    expect(store.getRow('a').quantity_on_hand).toBe(3)
    await showToast.mock.calls[0][0].onUndo()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(store.getRow('a').quantity_on_hand).toBe(2))
    expect(JSON.parse(fetch.mock.calls[1][1].body).quantity_on_hand).toBe(2)
  })

  it('shares its write order through a passed-in Map, so a re-created adjuster still drops stale answers', async () => {
    const store = makeStore([{ id: 'a', type: 'consumable', quantity_on_hand: 2 }])
    const putSeq = new Map()
    const first = deferred()
    const fetch = vi.fn().mockReturnValueOnce(first.p).mockResolvedValueOnce({ id: 'a', type: 'consumable', quantity_on_hand: 4 })
    const a = createQuantityAdjuster({ fetch, ...store, showToast: vi.fn(), putSeq })('a', +1)
    await createQuantityAdjuster({ fetch, ...store, showToast: vi.fn(), putSeq })('a', +1)
    first.resolve({ id: 'a', type: 'consumable', quantity_on_hand: 3 })
    await a
    expect(store.getRow('a').quantity_on_hand).toBe(4)
  })
})
