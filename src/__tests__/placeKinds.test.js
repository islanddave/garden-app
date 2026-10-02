// Put-Up R2a (prep) — src/components/putup/placeKinds.js: the one list of place kinds, bound to the server's.
// The server's six are read as TEXT from the two Lambdas that judge a place's kind (storage-location's list is
// not exported, and a test that imported the client's own copy would prove nothing about the server's).
// MUTATION: drop fridge_freezer from PLACE_KINDS -> "the six kinds are the server's" reds.
// CI lane: `npm test` plus the TZ re-run. Nothing here reads a clock.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLACE_KINDS, NEW_PLACE_KINDS, placeKindLabel } from '../components/putup/placeKinds.js'
import { NEW_PLACE_KINDS as DOOR_NEW_PLACE_KINDS } from '../components/pantry/DoorParts.jsx'
import { KIND_WORDS } from '../components/putup/jarWords.js'
import { STORAGE_KIND_WORDS } from '../components/recipes/recipes.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// The quoted words of `<decl> = [ … ]` in a source file, in the order written.
function listIn(rel, decl) {
  const src = readFileSync(resolve(REPO, rel), 'utf8')
  const at = src.indexOf(`${decl} = [`)
  if (at < 0) throw new Error(`${rel} no longer declares \`${decl} = [\``)
  const body = src.slice(at, src.indexOf(']', at))
  return [...body.matchAll(/'([a-z_]+)'/g)].map(m => m[1])
}
const JAR_ROUTE_KINDS = listIn('lambda/preservation/jarRoutes.js', 'export const PLACE_KINDS')
const STORAGE_KINDS = listIn('lambda/storage-location/index.js', 'const VALID_KINDS')
const sorted = (xs) => [...xs].sort()

describe('placeKinds — the kinds of place, in one list', () => {
  it('INSTRUMENT: the two server lists were read, and they are the same six', () => {
    expect(JAR_ROUTE_KINDS).toHaveLength(6)
    expect(new Set(JAR_ROUTE_KINDS).size).toBe(6)
    expect(sorted(STORAGE_KINDS)).toEqual(sorted(JAR_ROUTE_KINDS))
    expect(JAR_ROUTE_KINDS).toContain('fridge_freezer')
  })

  it('the six kinds are the server\'s: PLACE_KINDS, jarWords.KIND_WORDS and recipes.STORAGE_KIND_WORDS', () => {
    expect(sorted(PLACE_KINDS.map(k => k.kind))).toEqual(sorted(JAR_ROUTE_KINDS))
    expect(sorted(Object.keys(KIND_WORDS))).toEqual(sorted(JAR_ROUTE_KINDS))
    expect(sorted(Object.keys(STORAGE_KIND_WORDS))).toEqual(sorted(JAR_ROUTE_KINDS))
  })

  it('no kind is listed twice, and every kind has a word', () => {
    expect(new Set(PLACE_KINDS.map(k => k.kind)).size).toBe(PLACE_KINDS.length)
    for (const k of PLACE_KINDS) expect(k.label.trim()).not.toBe('')
  })

  it('"＋ Somewhere else" offers the five it offered before this file, in the same order, by the same words', () => {
    expect(NEW_PLACE_KINDS).toEqual([
      { kind: 'fridge', label: 'Fridge' }, { kind: 'deep_freezer', label: 'Freezer' },
      { kind: 'pantry', label: 'Pantry shelf' }, { kind: 'cold_storage', label: 'Cellar' },
      { kind: 'other', label: 'Counter or other' },
    ])
  })

  it('DoorParts hands on the same list, not a copy of it', () => {
    expect(DOOR_NEW_PLACE_KINDS).toBe(NEW_PLACE_KINDS)
  })

  it('placeKindLabel answers the word for a kind, and null for a kind that is not one', () => {
    expect(placeKindLabel('fridge_freezer')).toBe('Fridge freezer')
    expect(placeKindLabel('cold_storage')).toBe('Cellar')
    expect(placeKindLabel('garage')).toBeNull()
    expect(placeKindLabel(null)).toBeNull()
  })

  it('the lists cannot be changed in place by a caller', () => {
    expect(Object.isFrozen(PLACE_KINDS)).toBe(true)
    expect(Object.isFrozen(NEW_PLACE_KINDS)).toBe(true)
  })
})
