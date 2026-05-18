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

  const reload = useCallback(async () => {
    const my = ++loadCounterRef.current
    setLoading(true)
    setError(null)
    try {
      const data = await fetch('/api/inventory-items')
      if (loadCounterRef.current !== my) return // stale
      setItems(Array.isArray(data) ? data : [])
    } catch (err) {
      if (loadCounterRef.current !== my) return
      setError(err?.message ?? 'Failed to load inventory')
    } finally {
      if (loadCounterRef.current === my) setLoading(false)
    }
  }, [fetch])

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
      setItems(prev => [created, ...prev])
      return { item: created }
    } catch (err) {
      return { error: err?.message ?? 'Failed to create item' }
    }
  }, [fetch])

  const updateItem = useCallback(async (id, payload) => {
    // Caller may pass partial changes OR full payload.
    // If we have current item in list, merge {current, ...payload} for safety.
    // If not (e.g. detail page deep-link), pass payload through; Lambda will validate.
    const current = items.find(i => i.id === id)
    const fullPayload = current ? { ...current, ...payload } : payload
    try {
      const updated = await fetch('/api/inventory-items/' + id, {
        method: 'PUT',
        body: JSON.stringify(fullPayload),
      })
      setItems(prev => prev.map(i => i.id === id ? updated : i))
      return { item: updated }
    } catch (err) {
      return { error: err?.message ?? 'Failed to update item' }
    }
  }, [fetch, items])

  const adjustQuantity = useCallback(async (id, delta) => {
    const current = items.find(i => i.id === id)
    if (!current) return
    // Type-aware column selection (P4, 2026-05-18): consumables track quantity_on_hand,
    // durables track quantity. Both are numeric(N,3) on the server.
    const col = current.type === 'durable' ? 'quantity' : 'quantity_on_hand'
    const prevValue = Number(current[col] ?? 0)
    const newValue = Math.max(0, prevValue + Number(delta))
    if (newValue === prevValue) return

    // Optimistic update
    setItems(prev => prev.map(i => i.id === id ? { ...i, [col]: newValue } : i))

    try {
      const updated = await fetch('/api/inventory-items/' + id, {
        method: 'PUT',
        body: JSON.stringify({ ...current, [col]: newValue }),
      })
      setItems(prev => prev.map(i => i.id === id ? updated : i))
      showToast({
        msg: `Quantity changed to ${newValue}`,
        onUndo: () => {
          // Trigger reverse delta — undo path also goes through adjustQuantity.
          // Use the latest current value from state, not the closure value.
          adjustQuantity(id, prevValue - newValue)
        },
      })
    } catch (err) {
      // Revert optimistic change
      setItems(prev => prev.map(i => i.id === id ? { ...i, [col]: prevValue } : i))
      showToast({ msg: "Couldn't save — please try again" })
    }
  }, [fetch, items, showToast])

  const deleteItem = useCallback(async (id) => {
    try {
      await fetch('/api/inventory-items/' + id, { method: 'DELETE' })
      setItems(prev => prev.filter(i => i.id !== id))
      return { ok: true }
    } catch (err) {
      return { error: err?.message ?? 'Failed to delete item' }
    }
  }, [fetch])

  return { items, loading, error, lowStockCount, toast, dismissToast, createItem, updateItem, adjustQuantity, deleteItem, reload }
}
