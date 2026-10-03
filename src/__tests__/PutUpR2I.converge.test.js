// Put-Up R2a, lane I (the integrator) — words two lanes each say, held to ONE answer once both are merged.
//
//   · THE KIND WORDS (amendment C5, ΔARCH D-08). recipes.STORAGE_KIND_WORDS is built from the one list of kinds
//     (putup/placeKinds.js), so the recipe sheet's chips and its keeps line name a kind of place exactly as the
//     door does: "Counter or other", never a "Counter" of its own. recipes.js holds no kind word of its own.
// MUTATIONS (each run, each red here):
//   the old literal back (other: 'Counter')                           -> "every kind in the door's words"
//   a literal with today's six words, not built from the list         -> "recipes.js holds no kind word"
// CI LANE: `npm test` plus the TZ re-run. No jest-dom (L-182).
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { STORAGE_KIND_WORDS, keepsWords } from '../components/recipes/recipes.js'
import { PLACE_KINDS } from '../components/putup/placeKinds.js'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('the kind words — the recipe sheet says a kind of place in the door\'s words (C5)', () => {
  it('every kind in the door\'s words, in the keeps line too: Counter or other', () => {
    expect(STORAGE_KIND_WORDS).toEqual(Object.fromEntries(PLACE_KINDS.map(k => [k.kind, k.label])))
    expect(STORAGE_KIND_WORDS.other).toBe('Counter or other')
    expect(keepsWords({ keeps_n: 3, keeps_unit: 'day', keeps_storage_kind: 'other' })).toBe('Counter or other · 3 days')
    expect(Object.isFrozen(STORAGE_KIND_WORDS)).toBe(true)
  })

  it('recipes.js holds no kind word of its own: one list, so a kind renamed there is renamed here', () => {
    const src = readFileSync(resolve(SRC, 'components/recipes/recipes.js'), 'utf8')
    for (const { label } of PLACE_KINDS) expect(src, label).not.toContain(`'${label}'`)
    expect(src).not.toMatch(/'Counter'/)
  })
})
