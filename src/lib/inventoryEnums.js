// src/lib/inventoryEnums.js
// ────────────────────────────────────────────────────────────────────────────
// Canonical inventory_items enums — the SINGLE client source of truth, mirroring
// the LIVE prod Neon CHECK constraints verified read-only 2026-06-04
// (forms-consolidation-plan-V002 §4 RESULT). The committed schema-v2.sql /
// inventory-migration-v2.sql are STALE: the live table is `inventory_items` (not
// `inventory`); `type` is ('consumable','durable') (NOT '…equipment'); the live
// `category` set is the 10 below. The previous constants.js INVENTORY_ITEM_TYPES /
// INVENTORY_SUBCATEGORIES / INVENTORY_CATEGORIES claimed "matches schema CHECK" but
// used dead values ('equipment','fertilizer','hand_tools','misc','soil_amend…') and
// had ZERO importers — removed. InventoryAdd now imports from here.
//
// Drift guard: inventoryEnums.test.js pins the rich lists below to
// INVENTORY_CHECK_SETS (the verified live CHECK snapshot). If the DB CHECK changes,
// update INVENTORY_CHECK_SETS + the lists in lockstep (the stronger guard — snapshot
// vs the actual live CHECK — belongs in a staging schema test, noted in the plan).

// ── Spec-compliant enums (inventory_items schema) ────────────────────────────
export const INVENTORY_TYPES = [
  {
    value: 'consumable',
    label: 'Consumable',
    example: 'Seeds, fertilizer, spray, grow bags',
    emoji: '🌱',
  },
  {
    value: 'durable',
    label: 'Durable',
    example: 'Tools, lights, trays, shelving',
    emoji: '🔧',
  },
]

export const INVENTORY_CATEGORIES = [
  { v: 'seeds',                   label: 'Seeds',                types: ['consumable'] },
  { v: 'growing_media',           label: 'Growing media',        types: ['consumable'] },
  { v: 'fertilizer',              label: 'Fertilizer',           types: ['consumable'] },
  { v: 'amendment',               label: 'Amendment',            types: ['consumable'] },
  { v: 'pest_control',            label: 'Pest control',         types: ['consumable'] },
  { v: 'containers',              label: 'Containers',           types: ['consumable', 'durable'] },
  { v: 'lighting',                label: 'Lighting',             types: ['durable'] },
  { v: 'shelving',                label: 'Shelving',             types: ['durable'] },
  { v: 'climate_control',         label: 'Climate control',      types: ['durable'] },
  { v: 'tools',                   label: 'Tools',                types: ['durable'] },
  { v: 'other',                   label: 'Other',                types: ['consumable', 'durable'] },
]

export const INVENTORY_UNITS = ['each', 'packet', 'oz', 'fl oz', 'lb', 'gal', 'qt', 'bag', 'roll', 'sheet', 'other']
export const INVENTORY_CONDITIONS = ['excellent', 'good', 'fair', 'poor']

// Item lifecycle status (inventory_items.status CHECK).
export const INVENTORY_STATUSES = ['active', 'depleted', 'retired', 'missing']

// Verified-live CHECK value-sets (prod Neon, 2026-06-04). Drift-guard source of truth.
export const INVENTORY_CHECK_SETS = {
  type:      ['consumable', 'durable'],
  category:  ['seeds', 'growing_media', 'lighting', 'shelving', 'tools', 'pest_control', 'containers', 'climate_control', 'nutrients_and_amendments', 'fertilizer', 'amendment', 'other'],
  condition: ['excellent', 'good', 'fair', 'poor'],
  status:    ['active', 'depleted', 'retired', 'missing'],
  unit:      ['each', 'packet', 'oz', 'fl oz', 'lb', 'gal', 'qt', 'bag', 'roll', 'sheet', 'other'],
}


// ── Derived option sets for filter/select consumers (V3-CONFIG-001) ──────────
// Label derivation lives HERE so pages (Inventory.jsx etc.) never re-declare inventory vocabulary.
export const INVENTORY_CATEGORY_OPTIONS = [...INVENTORY_CATEGORIES]
  .sort((a, b) => a.label.localeCompare(b.label))
  .map(c => [c.v, c.label])
export const INVENTORY_STATUS_OPTIONS = INVENTORY_STATUSES.map(s => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }))
export const INVENTORY_CATEGORY_LABELS = Object.fromEntries(INVENTORY_CATEGORIES.map(c => [c.v, c.label]))
