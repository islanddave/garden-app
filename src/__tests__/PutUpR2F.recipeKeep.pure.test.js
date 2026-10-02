// Put-Up R2a, lane F (D2, BUG-RECIPELINEKEEPDROP-001) — the PURE half: recipes.js's line body. A sheet line
// that still holds its stored copy (`_keep`) carries that line's facts when its name, number and unit are
// the stored ones, whatever else on it changed; a line whose name, number or unit changed is what was
// typed. The sheet half (the stored copy surviving an edit) is PutUpR2F.recipeKeep.test.jsx.
// MUTATIONS (each run, each red here):
//   F-M1b copy the facts even when the name changed            -> "a renamed line carries none of them"
//   compare the at-the-end flag too before copying              -> "the at-the-end flag and the amount as written…"
// CI lane: `npm test` plus the TZ re-run.
import { describe, it, expect } from 'vitest'
import { draftFromRecipe, recipeBody } from '../components/recipes/recipes.js'

const FACTS = { form: 'dried', brand: 'Taekyung', note: 'coarse', shu_rating_low: 1500, shu_rating_high: 10000 }
const SALT = { brand: 'Diamond Crystal', role: 'salt', salt_pct: '3', salt_base: 'produce', base_g: '400', salt_method: 'dry', base_from: 'lines' }
const RECIPE = {
  id: 'r1', name: 'Roll for Initiative',
  lines: [
    { id: 'l1', ordinal: 1, name: 'gochugaru', amount_text: '10 g', qty: '10', qty_unit: 'g', at_the_end: false, role: null, ...FACTS },
    { id: 'l2', ordinal: 2, name: 'salt', amount_text: null, qty: '12', qty_unit: 'g', at_the_end: false, form: null, ...SALT },
  ],
}
// The draft as the sheet holds it after an edit to line `i` that keeps the stored copy.
const edited = (i, patch) => {
  const d = draftFromRecipe(RECIPE)
  return { ...d, lines: d.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }
}
const lines = (d) => recipeBody(d, { mode: 'edit' }).body.lines

describe('recipes.js — which edits a line\'s facts ride through (D2)', () => {
  it('an untouched draft sends every line back with every fact it was stored with', () => {
    expect(lines(draftFromRecipe(RECIPE))).toEqual([
      { ordinal: 1, name: 'gochugaru', amount_text: '10 g', qty: '10', qty_unit: 'g', ...FACTS },
      { ordinal: 2, name: 'salt', qty: '12', qty_unit: 'g', ...SALT },
    ])
  })

  it('the at-the-end flag and the amount as written are not what a line IS: the facts stay', () => {
    expect(lines(edited(0, { atTheEnd: true }))[0])
      .toEqual({ ordinal: 1, name: 'gochugaru', amount_text: '10 g', qty: '10', qty_unit: 'g', at_the_end: true, ...FACTS })
    expect(lines(edited(0, { amount: 'a heaped spoon' }))[0])
      .toEqual({ ordinal: 1, name: 'gochugaru', amount_text: 'a heaped spoon', qty: '10', qty_unit: 'g', ...FACTS })
    expect(lines(edited(1, { atTheEnd: true, amount: '3%' }))[1])
      .toEqual({ ordinal: 2, name: 'salt', amount_text: '3%', qty: '12', qty_unit: 'g', at_the_end: true, ...SALT })
  })

  it('a renamed line carries none of them', () => {
    expect(lines(edited(0, { name: 'paprika' }))[0]).toEqual({ ordinal: 1, name: 'paprika', amount_text: '10 g', qty: '10', qty_unit: 'g' })
  })

  it('nor does a line whose number or unit changed', () => {
    expect(lines(edited(0, { qty: '25' }))[0]).toEqual({ ordinal: 1, name: 'gochugaru', amount_text: '10 g', qty: '25', qty_unit: 'g' })
    expect(lines(edited(1, { unit: 'oz' }))[1]).toEqual({ ordinal: 2, name: 'salt', qty: '12', qty_unit: 'oz' })
  })

  // A line with no stored copy (typed on the sheet, or restored from a draft an older client wrote after an
  // edit) is exactly what was typed.
  it('a line with no stored copy is what was typed', () => {
    expect(lines(edited(0, { _keep: undefined }))[0]).toEqual({ ordinal: 1, name: 'gochugaru', amount_text: '10 g', qty: '10', qty_unit: 'g' })
  })
})
