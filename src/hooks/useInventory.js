// useInventory — live data hook for inventory_items.
// Wraps useApiFetch with stateful items list, optimistic adjustQuantity,
// 5s undo toast, type-aware low-stock derivation.
//
// Contract (consumed by Inventory.jsx, InventoryAdd.jsx, InventoryDetail.jsx):
//   { items, loading, error, lowStockCount, toast, dismissToast,
//     createItem(payload) -> { item } | { error },
//     updateItem(id, payload) -> { item } | { error },     // payload should be COMPLETE editable-field set
//     adjustQuantity(id, delta) -> void                     // optimistic + revert on error
//     deleteItem(id) -> { ok: true } | { error },           // soft delete
//     reload() -> Promise<void> }
//
// Notes for callers:
//   - PUT replaces editable fields server-side (Lambda is "complete payload" pattern).
//     updateItem() merges {currentItem, ...changes} client-side before sending.
//     If caller has full payload (e.g. InventoryDetail.buildChanges), pass it directly.
//   - adjustQuantity is type-aware: consumables update `quantity_on_hand`,
//     durables update `quantity` (P4, V1.2a-3 Increment C / PR-C1, 2026-05-18).
//   - lowStockCount = consumables where quantity_on_hand <= reorder_threshold AND threshold is set.

import { useState, useEffect, useCallback, useRef } from 'react'
import { useApiFetch } from '../lib/api.js'

const TOAST_MS = 5000

export function useInventory() {
  const { fetch } = useApiFetch()
  const [items,   setItems]   = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const [toast,   setToast]   = useState(null)

  const toastTimerRef = useRef(null)
  const loadCounterRef = useRef(0)

  // Live mirror of `items` for callbacks that outlive the render that created them —
  // the undo toast is the one that matters (BUG-INVUNDOQTY-001). A ref, not a functional
  // setItems updater: the app mounts under StrictMode (main.jsx), which double-invokes
  // updaters, so an updater body is not a safe place to read state from.
  // The effect is now a backstop, not the mechanism: commitItems below assigns the ref
  // synchronously. It stays so a raw setItems added here later cannot leave the ref stranded.
  const itemsRef = useRef(items)
  useEffect(() => { itemsRef.current = items }, [items])

  // Every write to `items` goes through here rather than through setItems directly. The effect
  // above only catches up after a commit, so two adjustments issued inside ONE commit both read
  // the pre-change row: two + taps become a single increment, and the second PUT silently re-sends
  // the first one's value — no error, no revert, no second toast. Computing `next` here and
  // assigning the ref before handing it off makes the ref true the moment a write is issued.
  //
  // setItems receives a plain VALUE, and that is the load-bearing half under StrictMode: React
  // double-invokes updater functions passed to setState, so a ref assigned inside an updater body
  // would be written twice per call. Nothing here runs during render, and `updater` — when the
  // caller passes one — is invoked exactly once, by us, against the ref.
  const commitItems = useCallback((updater) => {
    const next = typeof updater === 'function' ? updater(itemsRef.current) : updater
    itemsRef.current = next
    setItems(next)
  }, [])

  const reload = useCallback(async () => {
    const my = ++loadCounterRef.current
    setLoading(true)
    setError(null)
    try {
      const data = await fetch('/api/inventory-items')
      if (loadCounterRef.current !== my) return // stale
      commitItems(Array.isArray(data) ? data : [])
    } catch (err) {
      if (loadCounterRef.current !== my) return
      setError(err?.message ?? 'Failed to load inventory')
    } finally {
      if (loadCounterRef.current === my) setLoading(false)
    }
  }, [fetch, commitItems])

  useEffect(() => {
    reload()
    return () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current) }
  }, [reload])

  const showToast = useCallback((t) => {
    if (toastTimerRef.current) { clearTimeout(toastTimerRef.current); toastTimerRef.current = null }
    setToast(t)
    if (t) toastTimerRef.current = setTimeout(() => setToast(null), TOAST_MS)
  }, [])

  const dismissToast = useCallback(() => showToast(null), [showToast])

  // lowStockCount: consumable items with reorder_threshold set and qty_on_hand at/below it.
  // Recomputed on every render — items list is small (<1000 typical) so cost is negligible.
  const lowStockCount = items.filter(i =>
    i.type === 'consumable' &&
    i.reorder_threshold !== null &&
    i.reorder_threshold !== undefined &&
    Number(i.quantity_on_hand ?? 0) <= Number(i.reorder_threshold)
  ).length

  const createItem = useCallback(async (payload) => {
    try {
      const created = await fetch('/api/inventory-items', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      commitItems(prev => [created, ...prev])
      return { item: created }
    } catch (err) {
      return { error: err?.message ?? 'Failed to create item' }
    }
  }, [fetch, commitItems])

  const updateItem = useCallback(async (id, payload) => {
    // Caller may pass partial changes OR full payload.
    // If we have current item in list, merge {current, ...payload} for safety.
    // If not (e.g. detail page deep-link), pass payload through; Lambda will validate.
    // Reads itemsRef, not the closure's `items`, for the reason adjustQuantity does
    // (BUG-INVUNDOQTY-001): an instance held across a list change would otherwise merge the row as
    // it stood when that render ran. Latent rather than live — handleSave, the only caller, always
    // invokes the current render's instance — but "current item in list" above is only true of the
    // live list, and the two readers of state in this hook should not disagree about which one.
    const current = itemsRef.current.find(i => i.id === id)
    const fullPayload = current ? { ...current, ...payload } : payload
    try {
      const updated = await fetch('/api/inventory-items/' + id, {
        method: 'PUT',
        body: JSON.stringify(fullPayload),
      })
      commitItems(prev => prev.map(i => i.id === id ? updated : i))
      return { item: updated }
    } catch (err) {
      return { error: err?.message ?? 'Failed to update item' }
    }
  }, [fetch, commitItems])

  const adjustQuantity = useCallback(async (id, delta) => {
    const current = itemsRef.current.find(i => i.id === id)
    if (!current) return
    // Type-aware column selection (P4, 2026-05-18): consumables track quantity_on_hand,
    // durables track quantity. Both are numeric(N,3) on the server.
    const col = current.type === 'durable' ? 'quantity' : 'quantity_on_hand'
    const prevValue = Number(current[col] ?? 0)
    const newValue = Math.max(0, prevValue + Number(delta))
    if (newValue === prevValue) return

    // Optimistic update. Through commitItems, so a second tap landing in this same commit reads
    // newValue rather than the pre-tap row and increments from it.
    commitItems(prev => prev.map(i => i.id === id ? { ...i, [col]: newValue } : i))

    try {
      const updated = await fetch('/api/inventory-items/' + id, {
        method: 'PUT',
        body: JSON.stringify({ ...current, [col]: newValue }),
      })
      commitItems(prev => prev.map(i => i.id === id ? updated : i))
      showToast({
        msg: `Quantity changed to ${newValue}`,
        onUndo: () => {
          // Reverse delta, re-entering adjustQuantity. `adjustQuantity` here resolves to THIS
          // render's instance, so the reverse delta is only correct because the `current`
          // lookup at the top of this callback reads itemsRef.current (the post-change row)
          // rather than this closure's `items` (the pre-change row). Reading the closure
          // applied the delta twice — BUG-INVUNDOQTY-001, measured 2 -> +1 -> 3 -> undo -> 1,
          // and persisted by the PUT above.
          adjustQuantity(id, prevValue - newValue)
        },
      })
    } catch (err) {
      // Revert optimistic change
      commitItems(prev => prev.map(i => i.id === id ? { ...i, [col]: prevValue } : i))
      showToast({ msg: "Couldn't save — please try again" })
    }
  }, [fetch, showToast, commitItems])

  const deleteItem = useCallback(async (id) => {
    try {
      await fetch('/api/inventory-items/' + id, { method: 'DELETE' })
      commitItems(prev => prev.filter(i => i.id !== id))
      return { ok: true }
    } catch (err) {
      return { error: err?.message ?? 'Failed to delete item' }
    }
  }, [fetch, commitItems])

  return { items, loading, error, lowStockCount, toast, dismissToast, createItem, updateItem, adjustQuantity, deleteItem, reload }
}
