// Lane D / Phase B+C — inventory enum drift guard. Pins the rich client lists in
// inventoryEnums.js to the verified-live prod CHECK snapshot (INVENTORY_CHECK_SETS,
// forms-consolidation-plan-V002 §4 RESULT). A change to either must update both.
// (The stronger guard — snapshot vs the ACTUAL live DB CHECK — is a staging schema
// test; this unit guard catches client-side drift in CI without a DB.)
import { describe, it, expect } from 'vitest'
import {
  INVENTORY_TYPES, INVENTORY_CATEGORIES, INVENTORY_UNITS,
  INVENTORY_CONDITIONS, INVENTORY_STATUSES, INVENTORY_CHECK_SETS,
} from '../lib/inventoryEnums.js'

const sorted = (a) => [...a].sort()

describe('inventory enum drift guard (client lists == verified live CHECK sets)', () => {
  it('type values match the live CHECK', () => {
    expect(sorted(INVENTORY_TYPES.map(t => t.value))).toEqual(sorted(INVENTORY_CHECK_SETS.type))
  })
  it('category values match the live CHECK (picker excludes deprecated superset values)', () => {
    // V4-TREATLOG-001: the live CHECK is a SUPERSET that still allows the deprecated
    // 'nutrients_and_amendments' (back-compat during the split); the picker no longer offers it.
    const DEPRECATED = ['nutrients_and_amendments']
    expect(sorted(INVENTORY_CATEGORIES.map(c => c.v)))
      .toEqual(sorted(INVENTORY_CHECK_SETS.category.filter(c => !DEPRECATED.includes(c))))
  })
  it('units / conditions / statuses match the live CHECK', () => {
    expect(sorted(INVENTORY_UNITS)).toEqual(sorted(INVENTORY_CHECK_SETS.unit))
    expect(sorted(INVENTORY_CONDITIONS)).toEqual(sorted(INVENTORY_CHECK_SETS.condition))
    expect(sorted(INVENTORY_STATUSES)).toEqual(sorted(INVENTORY_CHECK_SETS.status))
  })
  it('every category maps only to live type values', () => {
    for (const c of INVENTORY_CATEGORIES)
      for (const t of c.types) expect(INVENTORY_CHECK_SETS.type).toContain(t)
  })
  it('no dead legacy values leaked back in', () => {
    const cats = INVENTORY_CATEGORIES.map(c => c.v)
    for (const dead of ['equipment', 'hand_tools', 'misc', 'soil_amendment', 'nutrients_and_amendments'])
      expect([...cats, ...INVENTORY_TYPES.map(t=>t.value)]).not.toContain(dead)
  })
})
