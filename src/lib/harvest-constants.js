// Sync source: lambda/events/validators.js git blob 27ce28a3f0a160bdc2b1658ae3f88d3db34f95d5
// Mirror of HARVEST_UNITS + MAX_PLAUSIBLE for client-side validation.
// Drift breaks the server CHECK constraint (migrations/v1-2a-2/0a-additive-ddl.sql).
// On change: update both files in the same commit.

export const HARVEST_UNITS = ['lb', 'oz', 'kg', 'g', 'count', 'bunch', 'cup', 'head']

export const MAX_PLAUSIBLE = {
  count: 10000,
  lb:    500,
  oz:    8000,
  kg:    500,
  g:     500000,
  bunch: 1000,
  cup:   1000,
  head:  1000,
}

// V4-HARVDUAL-001 Slice A — optional measured weight alongside the count. Mirrors the same names in
// lambda/events/validators.js; keep both in sync in one commit (see the header note above).
export const WEIGHT_UNITS = ['g', 'kg', 'lb', 'oz']

export const WEIGHT_UNIT_GRAMS = { g: 1, kg: 1000, lb: 453.592, oz: 28.3495 }

export const MAX_PLAUSIBLE_WEIGHT_G = 50000

export function toGrams(weight, unit) {
  return weight * (WEIGHT_UNIT_GRAMS[unit ?? 'g'] ?? 1)
}
