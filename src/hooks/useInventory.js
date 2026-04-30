// TODO DB-MIGRATE-INVENTORY: rewrite against /api/inventory Lambda when deployed.
// All callers receive unavailable state until Lambda is live.
import { useState, useCallback } from 'react'

export function useInventory() {
  const [items]   = useState([])
  const [loading] = useState(false)
  const [error]   = useState(null)
  const [toast]   = useState(null)

  const lowStockCount = 0

  function dismissToast() {}
  async function createItem()     { return { error: 'Inventory temporarily unavailable.' } }
  async function updateItem()     { return { error: 'Inventory temporarily unavailable.' } }
  async function adjustQuantity() {}
  async function deleteItem()     { return { error: 'Inventory temporarily unavailable.' } }
  const reload = useCallback(() => {}, [])

  return { items, loading, error, lowStockCount, toast, dismissToast, createItem, updateItem, adjustQuantity, deleteItem, reload }
}
