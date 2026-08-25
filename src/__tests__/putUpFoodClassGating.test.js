// V4-PUTUPFOODCATEGORY-001 (BD-056) — the non-plant food classes must reach the Put-Up crop field
// and NO other picker.
//
// The feature is a seed, not a schema change: migrations/v4-putupfood-001 puts bread, cheese, milk,
// butter, yogurt, meat and fish into crop_types, and the already-shipped whats-put-up?group=crop
// answers "where's my bread?" with no new column. The entire cost of doing it that way is that a
// GARDEN vocabulary now contains things that cannot be planted. `Bread` appearing as a crop to sow,
// to type a variety to, or to classify a garden project as is the defect this seed trades against,
// and it is a defect that fails SILENTLY — every one of those pickers renders whatever the list
// contains and none of them would error.
//
// So the gating is asserted here rather than assumed. Three independent things have to hold, and
// the third is the one a reviewer would skip:
//   1. the hook filters on category                     — mechanism
//   2. the DEFAULT is the garden list, not the full one — fail-closed, so a future call site that
//      never read this file is safe by omission rather than by diligence
//   3. every existing call site passes the scope it should — a correct filter called with
//      scope:'all' from VarietyPicker is still a loaf of bread in the planting picker
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join, relative } from 'node:path'

const { fetchSpy } = vi.hoisted(() => ({ fetchSpy: vi.fn() }))
vi.mock('../lib/api.js', () => ({ useApiFetch: () => ({ fetch: fetchSpy }) }))
import { useCropTypes, NON_PLANT_FOOD_CATEGORY } from '../hooks/useCropTypes.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const migrationSql = readFileSync(resolve(root, 'migrations/v4-putupfood-001/0a-additive-ddl.sql'), 'utf8')

// A vocabulary with both kinds in it. If this fixture ever held only garden rows, the exclusion
// assertions below would pass by having nothing to exclude.
const VOCAB = [
  { slug: 'pepper', display_name: 'Pepper', category: 'vegetable', sort_order: 0 },
  { slug: 'plum', display_name: 'Plum', category: 'fruit', sort_order: 0 },
  { slug: 'bread', display_name: 'Bread', category: 'non_plant_food', sort_order: 900 },
  { slug: 'cheese', display_name: 'Cheese', category: 'non_plant_food', sort_order: 900 },
]

beforeEach(() => { fetchSpy.mockReset() })

const slugsFor = async (args) => {
  fetchSpy.mockResolvedValueOnce(VOCAB)
  const { result } = renderHook(() => (args === undefined ? useCropTypes() : useCropTypes(args)))
  await waitFor(() => expect(result.current.loading).toBe(false))
  return result.current.cropTypes.map(c => c.slug)
}

describe('useCropTypes scope', () => {
  it('the fixture actually contains both kinds (guards a vacuous exclusion)', () => {
    expect(VOCAB.filter(c => c.category === NON_PLANT_FOOD_CATEGORY).length).toBe(2)
    expect(VOCAB.filter(c => c.category !== NON_PLANT_FOOD_CATEGORY).length).toBe(2)
  })

  it('defaults to the garden vocabulary — no food classes', async () => {
    expect(await slugsFor(undefined)).toEqual(['pepper', 'plum'])
  })

  it('an explicit garden scope is the same list', async () => {
    expect(await slugsFor({ scope: 'garden' })).toEqual(['pepper', 'plum'])
  })

  it("scope 'all' includes the food classes — this is what makes \"where's my bread?\" answerable", async () => {
    expect(await slugsFor({ scope: 'all' })).toEqual(['pepper', 'plum', 'bread', 'cheese'])
  })

  it('an unrecognised scope falls back to the garden list rather than opening up', async () => {
    // Fail-closed on a typo too: scope="Garden" or scope="pantry" must not silently mean "all".
    expect(await slugsFor({ scope: 'pantry' })).toEqual(['pepper', 'plum'])
  })

  it('still degrades to [] on fetch rejection, with the filter in place', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('boom'))
    const { result } = renderHook(() => useCropTypes())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.cropTypes).toEqual([])
  })
})

describe('every call site asks for the scope it should', () => {
  // The assertion that actually prevents the bug. The mechanism tests above would all stay green
  // while VarietyPicker asked for scope:'all'.
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return name === '__tests__' ? [] : walk(p)
    return /\.(jsx?|tsx?)$/.test(p) ? [p] : []
  })

  const HOOK_FILE = resolve(root, 'src/hooks/useCropTypes.js')
  const callSites = walk(resolve(root, 'src'))
    .filter(p => p !== HOOK_FILE)
    .flatMap((p) => [...readFileSync(p, 'utf8').matchAll(/useCropTypes\(([^)]*)\)/g)]
      .map(m => ({ file: relative(root, p), args: m[1].trim() })))

  it('found the call sites it is meant to be auditing', () => {
    // Four today: VarietyPicker, VarietyEdit, ProjectsAdminClassify, PutUp. A zero here would make
    // every assertion below vacuous, which is exactly how this class of guard rots.
    expect(callSites.length).toBeGreaterThanOrEqual(4)
  })

  it('only the Put-Up crop field opts into the full vocabulary', () => {
    const optedIn = callSites.filter(c => c.args.includes("'all'")).map(c => c.file).sort()
    expect(optedIn).toEqual(['src/pages/PutUp.jsx'])
  })

  it('every other call site takes the garden default', () => {
    const wrong = callSites.filter(c => c.file !== 'src/pages/PutUp.jsx' && c.args !== '')
    expect(
      wrong.map(c => `${c.file}: useCropTypes(${c.args})`),
      'a garden picker must not pass a scope — the default is the safe one',
    ).toEqual([])
  })
})

describe('the seed migration and the app agree on the gating category', () => {
  // Binds the constant the app filters on to the value the migration actually writes. These are the
  // two halves of one mechanism living in different languages; nothing else would catch them
  // drifting apart, and the failure would be silent in the direction that matters (a food class
  // with any other category is simply a garden crop).
  const rows = [...migrationSql.matchAll(/^ {2}\('([a-z_]+)',\s*'([^']+)',\s*(NULL|'[^']*'),\s*'([a-z_]+)',/gm)]
    .map(m => ({ slug: m[1], displayName: m[2], lifecycle: m[3], category: m[4] }))

  it('parsed the seeded rows', () => {
    expect(rows.map(r => r.slug).sort())
      .toEqual(['bread', 'butter', 'cheese', 'fish', 'meat', 'milk', 'yogurt'])
  })

  it('every seeded row carries the category the hook filters on', () => {
    for (const r of rows) expect(r.category, `${r.slug}`).toBe(NON_PLANT_FOOD_CATEGORY)
  })

  it('no seeded row invents a lifecycle', () => {
    // There is no honest default_lifecycle for bread. NULL = UNKNOWN = never fires; a value here
    // would be inference rendered to the user as fact.
    for (const r of rows) expect(r.lifecycle, `${r.slug}`).toBe('NULL')
  })

  it('the category is accepted by the Lambda that mints crop types', () => {
    // Otherwise adding a further food class through the app 400s on an "invalid category" that the
    // database itself has no opinion about (crop_types.category has no CHECK).
    const validateSrc = readFileSync(resolve(root, 'lambda/varieties/validate.js'), 'utf8')
    const block = validateSrc.slice(
      validateSrc.indexOf('export const VALID_CROP_CATEGORY = ['),
      validateSrc.indexOf('];', validateSrc.indexOf('export const VALID_CROP_CATEGORY = [')))
    expect(block).toContain(`'${NON_PLANT_FOOD_CATEGORY}'`)
  })
})
