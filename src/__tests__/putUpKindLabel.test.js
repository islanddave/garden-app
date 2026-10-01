// Put-Up UX pass R1 (prep) — KindChips.jsx kindLabel(kind): the chip's label for a stored kind, null for a
// kind with no chip and for none. One helper, so batch detail and the recipe library name a kind the same
// way and neither prints a raw column value.
// MUTATION: return the raw kind when no chip matches -> "says nothing for a stored kind that has no chip" reds.
// CI lane: `npm test` plus the TZ re-run. Nothing here reads a clock.
import { describe, it, expect } from 'vitest'
import { kindLabel, KIND_CHIPS } from '../components/kitchen/KindChips.jsx'
import { RECIPE_KIND_OPTIONS } from '../components/recipes/recipes.js'
import { KITCHEN_BATCH_KINDS } from '../../lambda/preservation/kitchenBatch.js'

describe('kindLabel — the chip label for a stored kind', () => {
  it('is the chip\'s own label for each of the six kinds a chip offers', () => {
    expect(KIND_CHIPS.map(c => [c.value, kindLabel(c.value)])).toEqual([
      ['ferment', 'Ferment'], ['dehydrate', 'Dry'], ['candy', 'Candy'], ['cure', 'Cure'], ['infuse', 'Infuse'], ['other', 'Other'],
    ])
  })

  it('says nothing for a stored kind that has no chip', () => {
    // Green control: `age` really is a kind the column stores, and really has no chip.
    expect(KITCHEN_BATCH_KINDS).toContain('age')
    expect(KIND_CHIPS.some(c => c.value === 'age')).toBe(false)
    expect(kindLabel('age')).toBeNull()
    // Every stored kind: a label, or null — never the raw value handed back.
    expect(KITCHEN_BATCH_KINDS.filter(k => kindLabel(k) === null)).toEqual(['age'])
    for (const k of KITCHEN_BATCH_KINDS) expect(kindLabel(k)).not.toBe(k)
  })

  it('is null for an unknown or missing kind', () => {
    for (const k of [null, undefined, '', ' ', 'preserve', 'Ferment', 'FERMENT', 'ferment ', 'Dry', 0, 1, true, {}, [], ['ferment']]) {
      expect(kindLabel(k)).toBeNull()
    }
    expect(kindLabel()).toBeNull()
  })

  it('answers exactly as the recipe library\'s own lookup does, for every stored kind', () => {
    const recipesWay = (k) => RECIPE_KIND_OPTIONS.find(o => o.value === k)?.label ?? null
    for (const k of [...KITCHEN_BATCH_KINDS, null, undefined, 'nope']) expect(kindLabel(k)).toBe(recipesWay(k))
  })
})
