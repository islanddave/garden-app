// TODO DB-MIGRATE-INVENTORY: migrate to /api/inventory Lambda when deployed
import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase.js'
import { useAuth } from '../context/AuthContext.jsx'

// ─────────────────────────────────────────────────────────────────────────────
// useInventory — data layer for inventory_items
//
// Returns:
//   items          — all non-deleted inventory rows (RLS filters user_id + deleted_at)
//   loading        — boolean
//   error          — string | null
//   lowStockCount  — consumables where quantity_on_hand ≤ reorder_threshold (and threshold set)
//   toast          — { msg, onUndo } | null  — parent renders this
//   dismissToast   — fn
//   createItem     — async (data) → { error }
//   updateItem     — async (id, changes) → { error }
//   adjustQuantity — async (id, delta) — optimistic, undo toast, revert on any error
//   deleteItem     — async (id) → { error }  — soft-delete (sets deleted_at)
//   reload         — fn  — force refresh
// ─────────────────────────────────────────────────────────────────────────────
export function useInventory() {
  const { user } = useAuth()
  const [items,   setItems]   = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const [toast,   setToast]   = useState(null) // { msg, onUndo, _timerId }

  // Low-stock: consumable, threshold set, qty ≤ threshold
  const lowStockCount = items.filter(item =>
    item.type === 'consumable' &&
    item.reorder_threshold !== null &&
    item.reorder_threshold !== undefined &&
    (item.quantity_on_hand ?? 0) <= item.reorder_threshold
  ).length

  const load = useCallback(async () => {
    if (!user) { setLoading(false); return }
    setLoading(true)
    setError(null)
    const { data, error: err } = await supabase
      .from('inventory_items')
      .select('*')
      .order('name')
    if (err) {
      setError(err.message)
      setLoading(false)
      return
    }
    setItems(data ?? [])
    setLoading(false)
  }, [user])

  useEffect(() => { load() }, [load])

  // ── Toast helpers ──────────────────────────────────────────────────────────
  function showToast(msg, onUndo = null) {
    setToast(prev => {
      if (prev?._timerId) clearTimeout(prev._timerId)
      const _timerId = setTimeout(() => setToast(null), 5000)
      return { msg, onUndo, _timerId }
    })
  }

  function dismissToast() {
    setToast(prev => {
      if (prev?._timerId) clearTimeout(prev._timerId)
      return null
    })
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────
  async function createItem(data) {
    if (!user) return { error: 'Not signed in — please refresh and try again.' }
    const { error: err } = await supabase
      .from('inventory_items')
      .insert({ ...data, user_id: user.id })
    if (err) return { error: err.message }
    await load()
    return { error: null }
  }

  async function updateItem(id, changes) {
    const { error: err } = await supabase
      .from('inventory_items')
      .update(changes)
      .eq('id', id)
    if (err) return { error: err.message }
    await load()
    return { error: null }
  }

  // Optimistic qty adjust with 5-sec undo toast.
  // On any error (including 401 JWT expiry): revert + error toast.
  async function adjustQuantity(id, delta) {
    const item = items.find(i => i.id === id)
    if (!item) return

    const prevQty = item.quantity_on_hand ?? 0
    const newQty  = Math.max(0, prevQty + delta)
    if (newQty === prevQty) return

    // Optimistic update — immediate
    setItems(prev => prev.map(i =>
      i.id === id ? { ...i, quantity_on_hand: newQty } : i
    ))

    const { error: err } = await supabase
      .from('inventory_items')
      .update({ quantity_on_hand: newQty })
      .eq('id', id)

    if (err) {
      // Revert + error toast
      setItems(prev => prev.map(i =>
        i.id === id ? { ...i, quantity_on_hand: prevQty } : i
      ))
      showToast("Couldn't save — please try again", null)
      return
    }

    // Success — undo toast
    const unitLabel = item.unit ? ` ${item.unit}` : ''
    showToast(
      `Quantity changed to ${newQty}${unitLabel}`,
      async () => {
        dismissToast()
        setItems(prev => prev.map(i =>
          i.id === id ? { ...i, quantity_on_hand: prevQty } : i
        ))
        await supabase
          .from('inventory_items')
          .update({ quantity_on_hand: prevQty })
          .eq('id', id)
      }
    )
  }

  // Soft-delete: sets deleted_at. RLS SELECT policy filters these out automatically.
  async function deleteItem(id) {
    const { error: err } = await supabase
      .from('inventory_items')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
    if (err) return { error: err.message }
    setItems(prev => prev.filter(i => i.id !== id))
    return { error: null }
  }

  return {
    items,
    loading,
    error,
    lowStockCount,
    toast,
    dismissToast,
    createItem,
    updateItem,
    adjustQuantity,
    deleteItem,
    reload: load,
  }
}
