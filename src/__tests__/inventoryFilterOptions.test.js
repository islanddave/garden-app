// V3-CONFIG-001: Inventory filter vocab is single-sourced from inventoryEnums (no drift).
import { describe, it, expect } from 'vitest'
import { INVENTORY_TYPES, INVENTORY_STATUSES, INVENTORY_CATEGORIES,
         INVENTORY_STATUS_OPTIONS, INVENTORY_CATEGORY_OPTIONS, INVENTORY_CHECK_SETS } from '../lib/inventoryEnums.js'

describe('V3-CONFIG-001 inventory filter option sets', () => {
  it('type options are exactly the live CHECK set', () => {
    expect(INVENTORY_TYPES.map(t => t.value)).toEqual(INVENTORY_CHECK_SETS.type)
  })
  it('status options mirror INVENTORY_STATUSES (order preserved) with capitalized labels', () => {
    expect(INVENTORY_STATUS_OPTIONS.map(s => s.value)).toEqual(INVENTORY_STATUSES)
    expect(INVENTORY_STATUS_OPTIONS.map(s => s.label)).toEqual(['Active', 'Depleted', 'Retired', 'Missing'])
  })
  it('category options cover every category, sorted by label, as [value,label] tuples', () => {
    expect(INVENTORY_CATEGORY_OPTIONS.map(([v]) => v).sort()).toEqual(INVENTORY_CATEGORIES.map(c => c.v).sort())
    const labels = INVENTORY_CATEGORY_OPTIONS.map(([, l]) => l)
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)))
  })
})
