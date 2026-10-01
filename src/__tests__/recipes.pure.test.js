// Put-Up release 4 — the pure half of the recipe library (src/components/recipes/recipes.js): the words, the
// ONE body the sheet sends, Make this / Made it as written, and the recipe rung of the Put it up preview and
// first row. Each assertion names what it holds. CI lane: `npm test` plus the TZ re-run.
import { describe, it, expect } from 'vitest'
import {
  keepsWords, containerWords, vesselWords, bottleWords, recipeLineWords, madeBatchWords, groupByType, sortTypes,
  emptyDraft, draftFromRecipe, recipeBody, startPrefill, vesselPatch, asWrittenLines, recipeFirstRow, recipePreview,
  RECIPE_KIND_OPTIONS, RECIPE_STORAGE_KINDS, STORAGE_KIND_WORDS, KEEPS_UNIT_WORDS,
} from '../components/recipes/recipes.js'
import { RECIPE_KEEPS_UNITS } from '../../lambda/preservation/shelfLife.js'
import { KITCHEN_BATCH_KINDS } from '../../lambda/preservation/kitchenBatch.js'
import { PLACE_KINDS } from '../../lambda/preservation/jarRoutes.js'
import { lineError } from '../../lambda/preservation/kitchenLines.js'
import { validateRecipeCreate, validateRecipePatch } from '../../lambda/preservation/recipeRules.js'
import { newRow } from '../components/putup/putItUp.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const NOW = new Date(2026, 9, 9, 12, 0, 0)
const RECIPE = {
  id: 'r1', name: 'Roll for Initiative', kind: 'ferment', keeps_n: 7, keeps_unit: 'day', keeps_storage_kind: 'fridge',
  vessel_label: 'quart jar', vessel_size: '1', vessel_unit: 'qt', vessel_count: 1,
  bottle_label: '8 oz woozy', bottle_size: '8', bottle_unit: 'fl oz', bottle_cooked: true,
  lines: [
    { id: 'a', ordinal: 1, name: 'jalapeño', amount_text: '170 g fresh jalapeño', qty: '170', qty_unit: 'g', at_the_end: false, form: 'fresh', shu_rating_low: 2500, shu_rating_high: 8000 },
    { id: 'b', ordinal: 2, name: 'salt', amount_text: '20 g salt', qty: '20', qty_unit: 'g', at_the_end: false, role: 'salt', salt_pct: '2.5', salt_base: 'all', base_g: '800', salt_method: 'brine', base_from: 'lines' },
    { id: 'c', ordinal: 3, name: 'cumin', amount_text: 'pinch', qty: null, qty_unit: null, at_the_end: false },
    { id: 'd', ordinal: 4, name: 'onion', amount_text: '20 g onion', qty: '20', qty_unit: 'g', at_the_end: true },
  ],
}

describe('the vocabularies are the Lambda\'s (parity)', () => {
  it('storage kinds, keeps units and kinds', () => {
    expect(RECIPE_STORAGE_KINDS).toEqual(PLACE_KINDS)
    expect(Object.keys(STORAGE_KIND_WORDS).sort()).toEqual([...PLACE_KINDS].sort())
    expect(Object.keys(KEEPS_UNIT_WORDS)).toEqual(RECIPE_KEEPS_UNITS)
    for (const k of RECIPE_KIND_OPTIONS) expect(KITCHEN_BATCH_KINDS).toContain(k.value)
  })
})

describe('words', () => {
  it('the keeps line by place and length — never the column\'s own name', () => {
    expect(keepsWords(RECIPE)).toBe('Fridge · 7 days')
    expect(keepsWords({ keeps_n: 1, keeps_unit: 'month', keeps_storage_kind: 'deep_freezer' })).toBe('Deep freezer · 1 month')
    expect(keepsWords({ keeps_n: null })).toBeNull()
    expect(keepsWords(RECIPE)).not.toMatch(/keep/i)
  })

  it('the process jar and the final container', () => {
    expect(vesselWords(RECIPE)).toBe('quart jar (1 qt)')
    expect(bottleWords(RECIPE)).toBe('8 oz woozy · cooked after blending')
    expect(containerWords(null, '4', 'fl oz', 3)).toBe('3 × 4 fl oz')
    expect(containerWords(null, null, null)).toBeNull()
  })

  it('a line as reference text: the amount AS WRITTEN first', () => {
    expect(recipeLineWords(RECIPE.lines[0])).toBe('170 g fresh jalapeño')
    expect(recipeLineWords({ name: 'garlic', qty: '8', qty_unit: 'g' })).toBe('8 g garlic')
    // UX pass F3: an amount written without the ingredient keeps the ingredient's name in front of it.
    expect(recipeLineWords({ name: 'gochugaru', amount_text: '10 g', brand: 'Taekyung' })).toBe('gochugaru — 10 g (Taekyung)')
    expect(recipeLineWords({ name: 'Garlic', amount_text: '4 cloves' })).toBe('Garlic — 4 cloves')
    expect(recipeLineWords({ name: 'garlic', amount_text: '4 cloves garlic' })).toBe('4 cloves garlic')
  })

  it('a batch made from it: its date and its ending in words — never a reading', () => {
    expect(madeBatchWords({ started_at: '2026-09-20T16:00:00Z', closed_at: '2026-10-02T00:00:00Z', outcome: 'put_up' }, NOW))
      .toEqual({ when: expect.any(String), ending: 'Put it up' })
    expect(madeBatchWords({ started_at: null, first_recorded_at: '2026-09-20T16:00:00Z' }, NOW).ending).toBe('still going')
    expect(madeBatchWords({ suspended_at: '2026-09-21T00:00:00Z' }, NOW).ending).toBe('paused')
    expect(madeBatchWords({ closed_at: 'x', outcome: 'discarded_spoiled' }, NOW).ending).toBe('It spoiled — threw it out')
    const w = madeBatchWords({ started_at: '2026-09-20T16:00:00Z', last_ph_reading: '3.10', outcome: null }, NOW)
    expect(JSON.stringify(w)).not.toMatch(/3\.10|pH/)
  })

  it('grouped by type in built-in order, No type last; types sort built-ins first', () => {
    const g = groupByType([
      { id: '1', name: 'b', recipe_type_id: 't2', type_label: 'Pesto', type_sort: 70 },
      { id: '2', name: 'a', recipe_type_id: null },
      { id: '3', name: 'z', recipe_type_id: 't1', type_label: 'Hot sauce', type_sort: 10 },
      { id: '4', name: 'y', recipe_type_id: 't1', type_label: 'Hot sauce', type_sort: 10 },
    ])
    expect(g.map(x => x.label)).toEqual(['Hot sauce', 'Pesto', 'No type'])
    expect(g[0].recipes.map(r => r.name)).toEqual(['y', 'z'])
    expect(sortTypes([{ id: 'h', label: 'Shrub', builtin: false }, { id: 'b2', label: 'Pesto', builtin: true, sort_order: 70 },
      { id: 'b1', label: 'Hot sauce', builtin: true, sort_order: 10 }]).map(t => t.label)).toEqual(['Hot sauce', 'Pesto', 'Shrub'])
  })
})

describe('recipeBody — the ONE body, refused where the server would refuse it', () => {
  it('create: keyed, blanks left out, notes verbatim, keeps as {n, unit, storage_kind}', () => {
    const d = { ...emptyDraft(), name: ' Mojo ', notes: '  Step 1.\n\n  Step 2.  ', keepsN: '7', keepsUnit: 'day', keepsKind: 'fridge',
      lines: [{ name: 'garlic', amount: '8 g garlic', qty: '8', unit: 'g', atTheEnd: false }, { name: '', amount: '' }] }
    const { body } = recipeBody(d)
    expect(body.idempotency_key).toMatch(UUID)
    expect(body).toMatchObject({ name: 'Mojo', notes: '  Step 1.\n\n  Step 2.  ', keeps: { n: 7, unit: 'day', storage_kind: 'fridge' } })
    expect(body.lines).toEqual([{ ordinal: 1, name: 'garlic', amount_text: '8 g garlic', qty: '8', qty_unit: 'g' }])
    expect(body).not.toHaveProperty('link_url')
    expect(validateRecipeCreate(body)).toBeNull()
  })

  it('the draft key is reused on a retry', () => {
    const d = { ...emptyDraft(), name: 'x', key: '11111111-1111-4111-8111-111111111111' }
    expect(recipeBody(d).body.idempotency_key).toBe('11111111-1111-4111-8111-111111111111')
  })

  it.each([
    [{ name: '' }, 'name'],
    [{ name: 'x', link: 'javascript:alert(1)' }, 'link'],
    [{ name: 'x', link: 'example.com' }, 'link'],
    [{ name: 'x', keepsN: '7' }, 'keeps'],
    [{ name: 'x', keepsN: '0', keepsKind: 'fridge' }, 'keeps'],
    [{ name: 'x', bottleSize: '4' }, 'bottle'],
    [{ name: 'x', vesselUnit: 'qt' }, 'vessel'],
    [{ name: 'x', vesselCount: '0' }, 'vessel'],
    [{ name: 'x', lines: [{ name: 'salt', qty: '5', unit: '' }] }, 'lines'],
  ])('%o → refused on %s', (over, field) => {
    expect(recipeBody({ ...emptyDraft(), ...over }).field).toBe(field)
  })

  it('edit: every shown field is sent (an emptied one clears), and it passes the PATCH rules', () => {
    const d = draftFromRecipe({ ...RECIPE, link_url: 'https://example.com/x', notes: 'as written' })
    d.link = ''
    d.keepsN = ''; d.keepsKind = ''
    const { body } = recipeBody(d, { mode: 'edit' })
    expect(body).toMatchObject({ link_url: null, keeps: null, name: 'Roll for Initiative', bottle_cooked: true })
    expect(body).not.toHaveProperty('idempotency_key')
    // unchanged recipe lines keep their facts (form, heat, salt facts) through an edit
    expect(body.lines[0]).toMatchObject({ form: 'fresh', shu_rating_low: 2500 })
    expect(body.lines[1]).toMatchObject({ role: 'salt', salt_pct: '2.5', salt_base: 'all' })
    expect(body.lines[3]).toMatchObject({ at_the_end: true })
    expect(validateRecipePatch(body)).toBeNull()
  })
})

describe('Make this / Made it as written / I made this', () => {
  it('the Start prefill: the name, a kind the chips offer, the recipe', () => {
    expect(startPrefill(RECIPE)).toEqual({ label: 'Roll for Initiative', kind: 'ferment', recipeId: 'r1', recipeName: 'Roll for Initiative' })
    expect(startPrefill({ ...RECIPE, kind: 'age' }).kind).toBeNull()
  })

  it('the process jar goes to the batch through the merge PUT keys', () => {
    expect(vesselPatch(RECIPE)).toEqual({ vessel_label: 'quart jar', vessel_size: '1', vessel_unit: 'qt', vessel_count: 1 })
    expect(vesselPatch({ name: 'x' })).toBeNull()
  })

  it('Made it as written: the pot lines as keyed typed lines, amounts asserted; each passes F\'s line rules', () => {
    const lines = asWrittenLines(RECIPE)
    expect(lines.map(l => l.label)).toEqual(['jalapeño', 'salt', 'cumin'])
    for (const l of lines) {
      expect(l.idempotency_key).toMatch(UUID)
      expect(lineError(l)).toBeNull()
    }
    expect(lines[0]).toMatchObject({ input_kind: 'other', qty: '170', qty_unit: 'g', form: 'fresh', shu_rating_low: 2500, shu_rating_high: 8000 })
    expect(lines[1]).toMatchObject({ role: 'salt', salt_pct: '2.5', salt_base: 'all', base_g: '800', salt_method: 'brine' })
    expect(lines[1]).not.toHaveProperty('form')
    expect(lines[2]).toMatchObject({ note: 'pinch' })
    expect(lines[2]).not.toHaveProperty('qty')
  })

  it('I made this: every line, the at-the-end ones too', () => {
    expect(asWrittenLines(RECIPE, { includeAtTheEnd: true }).map(l => l.label)).toEqual(['jalapeño', 'salt', 'cumin', 'onion'])
  })

  it('a 1b "peppers" salt base stays on the recipe (F\'s line POST refuses it)', () => {
    const [l] = asWrittenLines({ lines: [{ ...RECIPE.lines[1], salt_base: 'peppers' }] })
    expect(l).not.toHaveProperty('salt_pct')
    expect(lineError(l)).toBeNull()
  })
})

describe('Put it up from a recipe: the first row and the preview', () => {
  it('the first row defaults its container and "cooked" from the recipe\'s final container', () => {
    const row = recipeFirstRow(RECIPE)
    expect(row.container).toEqual({ label: '8 oz woozy', size_value: 8, size_unit: 'fl oz' })
    expect(row.cooked).toBe(true)
    expect(recipeFirstRow(null)).toEqual(newRow())
    expect(recipeFirstRow({ name: 'no bottle' })).toEqual(newRow())
  })

  const when = { date: '2026-10-09', precision: 'day' }
  it('recipe applied only on its storage kind, worded "from the recipe: <name>" with no duration', () => {
    const p = recipePreview({ row: { place: { kind: 'fridge' } }, when, recipe: RECIPE, now: NOW })
    expect(p).toMatchObject({ date: '2026-10-16', basis: 'recipe' })
    expect(p.words).toMatch(/^discard by .+ · from the recipe: Roll for Initiative$/)
    expect(p.words).not.toMatch(/7|day/)
    expect(recipePreview({ row: { place: { kind: 'deep_freezer' } }, when, recipe: RECIPE, now: NOW })).toBeNull()
    expect(recipePreview({ row: { place: null }, when, recipe: RECIPE, now: NOW })).toBeNull()
  })

  it('typed beats recipe (a date, or "no date")', () => {
    expect(recipePreview({ row: { place: { kind: 'fridge' }, discard: { mode: 'date', date: '2026-10-12' } }, when, recipe: RECIPE, now: NOW })).toBeNull()
    expect(recipePreview({ row: { place: { kind: 'fridge' }, discard: { mode: 'none' } }, when, recipe: RECIPE, now: NOW })).toBeNull()
  })

  it('an estimated put-up date reads "around"', () => {
    expect(recipePreview({ row: { place: { kind: 'fridge' } }, when: { date: '2026-10-01', precision: 'month' }, recipe: RECIPE, now: NOW }).words)
      .toMatch(/^discard by around /)
  })
})
