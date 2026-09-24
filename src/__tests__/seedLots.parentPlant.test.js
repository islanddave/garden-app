// BUG-SAVEDSEEDPARENTONPRODUCE-001 — kindAllowsParentPlant (src/components/seed/seedLots.js) is the
// client's copy of ONE database rule, and this file holds it to that rule rather than to a summary of it.
//
// The rule is chk_inventory_seed_source_plant: `source_kind IS NULL OR source_kind = 'own_garden' OR
// source_plant_id IS NULL`. Read off live prod on 2026-09-24 (convalidated) and byte-identical to the
// migration that created it. Its summary, "a lot with a source_kind cannot have a parent", is WRONG for
// own_garden — which is exactly how the ledger title phrased it — so the admitted kinds are derived here
// from the CHECK's own text and every kind in the vocabulary is asked. Removing the predicate, or
// loosening it to "any source_kind", or tightening it to "only NULL", each reds a row below.
//
// The residual gap is the one lambda/inventory-items/put-seed-provenance-guard.test.js names for the
// same constraint: this reads the migration files, not pg_constraint. A redefinition in a NEW migration
// is caught (exactly one definition is required); a live-only ALTER is not.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { kindAllowsParentPlant } from '../components/seed/seedLots.js'
import { PUTUP_SOURCE_OPTIONS } from '../lib/dropdownRegistry.js'

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = join(here, '..', '..', 'migrations')

// Forward DDL only: a rollback file drops the constraint, it does not define it.
const ddl = readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) => readdirSync(join(MIGRATIONS, d.name))
    .filter((f) => f.endsWith('.sql') && !/rollback/i.test(f))
    .map((f) => readFileSync(join(MIGRATIONS, d.name, f), 'utf8')))
  .join('\n')

const checkOf = (name) => [...ddl.matchAll(new RegExp(`ADD CONSTRAINT\\s+${name}\\s+CHECK\\s*\\(([^;]*?)\\)\\s*;`, 'gs'))]
  .map((m) => m[1].replace(/\s+/g, ' ').trim())

describe('kindAllowsParentPlant — chk_inventory_seed_source_plant, exactly', () => {
  const defs = checkOf('chk_inventory_seed_source_plant')
  const vocabDefs = checkOf('chk_inventory_source_kind')

  it('reads exactly one definition of each constraint (a second one means the rule moved — re-derive)', () => {
    expect(ddl.length, 'read no migration SQL at all — path wrong?').toBeGreaterThan(1000)
    expect(defs).toHaveLength(1)
    expect(vocabDefs).toHaveLength(1)
  })

  // With a parent set (source_plant_id IS NOT NULL) the CHECK holds only through its source_kind arms.
  // Every arm must be one of the three shapes below; any other shape fails loudly rather than being
  // skipped, because a skipped arm is a rule this file would no longer be checking.
  const admitted = () => {
    const arms = defs[0].split(/\s+OR\s+/i).map((a) => a.replace(/^\(+|\)+$/g, '').trim())
    const kinds = new Set()
    let nullAdmits = false
    for (const arm of arms) {
      if (/^source_kind IS NULL$/i.test(arm)) { nullAdmits = true; continue }
      if (/^source_plant_id IS NULL$/i.test(arm)) continue
      const eq = arm.match(/^source_kind = '([a-z_]+)'(::text)?$/i)
      if (eq) { kinds.add(eq[1]); continue }
      throw new Error(`chk_inventory_seed_source_plant has an arm this test cannot read: "${arm}" — re-derive kindAllowsParentPlant`)
    }
    return { kinds, nullAdmits }
  }
  const vocabulary = () => {
    const m = vocabDefs[0].match(/ARRAY\s*\[([^\]]*)\]/i)
    return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
  }

  it('the vocabulary it asks about is the shipped one', () => {
    expect(vocabulary()).toEqual(PUTUP_SOURCE_OPTIONS.map((o) => o.value))
  })

  it('answers every kind in the vocabulary as the CHECK does, for a lot WITH a parent', () => {
    const { kinds } = admitted()
    const vocab = vocabulary()
    // Non-vacuity: the rule both admits some named kind and refuses some — so "always true" and
    // "any kind refuses" are each a real, failing answer here, not a coincidence of the fixture.
    expect(vocab.filter((k) => kinds.has(k)).length).toBeGreaterThan(0)
    expect(vocab.filter((k) => !kinds.has(k)).length).toBeGreaterThan(1)
    for (const k of vocab) {
      expect(kindAllowsParentPlant(k), `kind '${k}'`).toBe(kinds.has(k))
    }
  })

  it('own_garden ADMITS a parent — "has a source_kind" is not the rule', () => {
    expect(admitted().kinds.has('own_garden')).toBe(true)
    expect(kindAllowsParentPlant('own_garden')).toBe(true)
  })

  it('an unrecorded kind admits one, in every spelling this client has for NULL', () => {
    expect(admitted().nullAdmits).toBe(true)
    expect(kindAllowsParentPlant(null)).toBe(true)
    expect(kindAllowsParentPlant(undefined)).toBe(true)
    // /inventory/:id's select holds '' for "Not recorded" and sends it as null.
    expect(kindAllowsParentPlant('')).toBe(true)
  })

  it('produce kinds are refused — the lots that showed "Set parent plant" and could only fail', () => {
    for (const k of ['farm_stand', 'gift', 'store', 'u_pick', 'csa', 'foraged', 'other']) {
      expect(kindAllowsParentPlant(k), k).toBe(false)
    }
  })
})
