// Put-Up UX pass R1, lane A — the page shell's PURE half (src/components/putup/goingNow.js, the block at
// its foot): the four segments, where a mode's Back lands and what it says, whether it pops or pushes, and
// the recipes lane's list as page-search items. One test per sentence; each title says what it holds.
// MUTATIONS (run for this file):
//   · leavesByPop ignores the index            -> "an origin alone is not enough" reds
//   · backWords returns the origin regardless  -> "names the segment when the press will not pop" reds
// CI lane: `npm test` plus the TZ re-run. Nothing here reads a clock.
import { describe, it, expect } from 'vitest'
import {
  START_BATCH_CTA, TRY_AGAIN_CTA, PUT_UP_SEGMENTS, RECIPES_SEGMENT, leaveSegment, segmentLabel, leavesByPop,
  backWords, recipeSearchItems,
} from '../components/putup/goingNow.js'
import { backLabel, withFrom } from '../components/putup/origin.js'

// The five origins the plan names (PLAN-V3 section 3 point 4), as the router state a push would carry.
const ORIGINS = [
  [{ label: 'Petri Dish', kind: 'recipe', id: 'rc-1' }, 'Petri Dish', ' (recipe)'],
  [{ label: 'Megatron mash', kind: 'batch', id: 'kb-1' }, 'Megatron mash', ' (batch)'],
  [{ label: 'Pantry' }, 'Pantry', ''],
  [{ label: 'Closed batches' }, 'Closed batches', ''],
  [{ label: 'Ristra Cayenne' }, 'Ristra Cayenne', ''],
]

describe('the page shell\'s words', () => {
  it('the door that starts a batch and the reload read exactly so', () => {
    expect(START_BATCH_CTA).toBe('Start a batch')
    expect(TRY_AGAIN_CTA).toBe('Try again')
  })

  it('the four segments, in the control\'s order, and frozen', () => {
    expect(PUT_UP_SEGMENTS.map(s => [s.value, s.label])).toEqual([
      ['going', 'Going now'], ['log', 'Log a put-up'], ['pantry', 'Pantry'], ['recipes', 'Recipes'],
    ])
    expect(Object.isFrozen(PUT_UP_SEGMENTS)).toBe(true)
    expect(PUT_UP_SEGMENTS.every(Object.isFrozen)).toBe(true)
    expect(RECIPES_SEGMENT).toBe('recipes')
  })

  it('segmentLabel names a segment and nothing else', () => {
    expect(PUT_UP_SEGMENTS.map(s => segmentLabel(s.value))).toEqual(['Going now', 'Log a put-up', 'Pantry', 'Recipes'])
    for (const v of ['stores', '', null, undefined, 0]) expect(segmentLabel(v)).toBeNull()
  })
})

describe('where a push-leave lands', () => {
  it('is the segment the page holds — except a recipe, which is left onto Recipes', () => {
    for (const s of PUT_UP_SEGMENTS) {
      expect(leaveSegment(s.value)).toBe(s.value)
      expect(leaveSegment(s.value, { recipe: false })).toBe(s.value)
      expect(leaveSegment(s.value, { recipe: true })).toBe('recipes')
    }
  })
})

describe('leavesByPop — the Back pops only to a named sender that is really under it', () => {
  it.each(ORIGINS)('an origin (%o) with an entry under it pops', (from) => {
    expect(leavesByPop(withFrom(null, from), 1)).toBe(true)
    expect(leavesByPop(withFrom({ background: { pathname: '/today' } }, from), 7)).toBe(true)
  })

  // The restored PWA: history.state outlives a reload and a deploy, so an entry can name a sender that
  // is no longer under it. history.back() at index 0 does nothing.
  it('an origin alone is not enough: at index 0, or with no readable index, it is a push', () => {
    const state = withFrom(null, { label: 'Pantry' })
    for (const idx of [0, -1, undefined, null, NaN, '1', 1.5, Infinity]) {
      expect({ idx: String(idx), pops: leavesByPop(state, idx) }).toEqual({ idx: String(idx), pops: false })
    }
    // Green control: the same state does pop one entry up.
    expect(leavesByPop(state, 1)).toBe(true)
  })

  it('an index alone is not enough: no origin, or one that does not read as an origin, is a push', () => {
    for (const state of [null, undefined, {}, { background: { pathname: '/today' } }, { from: null }, { from: 'Pantry' },
      { from: { label: '   ' } }, { from: ['Pantry'] }, { prefill: { crop_type_slug: 'pepper' } }]) {
      expect({ state: JSON.stringify(state), pops: leavesByPop(state, 3) }).toEqual({ state: JSON.stringify(state), pops: false })
    }
  })
})

describe('backWords — the Back says where the press LANDS', () => {
  it.each(ORIGINS)('with a pop it is the origin (%o): the name, then the kind', (from, name, suffix) => {
    const state = withFrom(null, from)
    expect(backWords(state, 1, 'Going now')).toEqual({ name, suffix })
    // The two parts are origin.js's own words, split — never a second wording of them.
    expect(name + suffix).toBe(backLabel(state, 'Going now'))
  })

  it.each(ORIGINS)('names the segment when the press will not pop (%o at index 0)', (from) => {
    const state = withFrom(null, from)
    expect(backWords(state, 0, 'Going now')).toEqual({ name: 'Going now', suffix: '' })
    expect(backWords(state, undefined, 'Recipes')).toEqual({ name: 'Recipes', suffix: '' })
  })

  it('with no origin it is the fallback, whatever the index', () => {
    for (const idx of [0, 1, 9, undefined]) {
      expect(backWords(null, idx, 'Pantry')).toEqual({ name: 'Pantry', suffix: '' })
      expect(backWords({ background: { pathname: '/today' } }, idx, 'Log a put-up')).toEqual({ name: 'Log a put-up', suffix: '' })
    }
  })

  it('a label is trimmed as origin.js reads it, and the suffix still follows it', () => {
    expect(backWords({ from: { label: '  Petri Dish  ', kind: 'recipe' } }, 2, 'Recipes')).toEqual({ name: 'Petri Dish', suffix: ' (recipe)' })
  })
})

describe('recipeSearchItems — the recipes list as page-search items', () => {
  const LIST = [
    { id: 'r1', name: 'Roll for Initiative', kind: 'ferment', recipe_type_id: 't-hot', type_label: 'Hot sauce', type_sort: 10, keeps_n: 7, batch_count: 2 },
    { id: 'r3', name: 'Mystery', kind: null, recipe_type_id: null, type_label: null, batch_count: 0 },
  ]

  it('reads the envelope the Lambda sends, and keeps only kind, id, name and the type\'s label', () => {
    expect(recipeSearchItems({ recipes: LIST })).toEqual([
      { kind: 'recipe', id: 'r1', name: 'Roll for Initiative', type_label: 'Hot sauce' },
      { kind: 'recipe', id: 'r3', name: 'Mystery' },
    ])
  })

  it('reads a bare array too, and anything else as no recipes', () => {
    expect(recipeSearchItems(LIST)).toHaveLength(2)
    for (const p of [null, undefined, {}, { recipes: 'nope' }, 'nope', 7]) expect(recipeSearchItems(p)).toEqual([])
  })

  it('does not offer a row nobody could open or find: no id, or no name', () => {
    expect(recipeSearchItems({ recipes: [
      { id: null, name: 'No id' }, { id: '', name: 'Blank id' }, { id: 'r9', name: '   ' }, { id: 'r8' }, null,
      { id: 12, name: '  Numbered  ', type_label: '  ' },
    ] })).toEqual([{ kind: 'recipe', id: '12', name: 'Numbered' }])
  })
})
