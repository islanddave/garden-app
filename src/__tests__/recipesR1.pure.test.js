// Put-Up UX pass R1, lane D — the pure half of what the recipe surfaces gained (src/components/recipes/recipes.js):
//   · notesSegments   recipe detail SHOWS paired marks as bold / italic; nothing else about the text moves, and
//                     the stored text, the sheet's textarea and the save body never pass through it;
//   · keepsKindChips  "How long, and where": all six of the Lambda's place kinds reachable, the stored one
//                     always on screen, and an untouched line byte-identical through draftFromRecipe → recipeBody;
//   · typeChips       the type the sheet opened on, then the types in use, then the rest behind "More types…";
//   · exactAmountOpens  the two rules that open a line's exact amount by themselves;
//   · the words (D7, D9), as the literals the plan fixes.
// MUTATIONS (each run, each red here):
//   M10b  make notesSegments drop an unpaired asterisk            -> "prints as typed" cases
//   pair across a line break (split on nothing)                   -> "a pair split by a line break"
//   keepsKindChips forgets `stored`                               -> "the stored kind is always a chip"
// CI lane: `npm test` plus the TZ re-run. Nothing here reads a clock.
import { describe, it, expect } from 'vitest'
import {
  notesSegments, keepsKindChips, KEEPS_COMMON_KINDS, typeChips, exactAmountOpens, draftFromRecipe, recipeBody, emptyDraft,
  RECIPE_STORAGE_KINDS, STORAGE_KIND_WORDS, KEEPS_UNIT_WORDS,
  I_MADE_THIS_CTA, MADE_CONFIRM_TEXT, MADE_CONFIRM_CTA, KEPT_SOME_CTA, TYPE_LABEL, TYPE_HELP, MORE_TYPES_CTA, KIND_LABEL, KIND_HELP,
  LINE_NAME_LABEL, LINE_AMOUNT_LABEL, AT_THE_END_LABEL, EXACT_AMOUNT_CTA, KEEPS_LABEL, KEEPS_N_LABEL, MORE_PLACES_CTA, COOKED_LABEL,
} from '../components/recipes/recipes.js'
import { validateRecipePatch, validateRecipeCreate } from '../../lambda/preservation/recipeRules.js'

const plain = (text) => ({ kind: 'plain', text })
const bold = (text) => ({ kind: 'bold', text })
const italic = (text) => ({ kind: 'italic', text })
// The marks put back round every bold and italic run: the input again, character for character.
const typed = (segs) => segs.map(s => (s.kind === 'bold' ? `**${s.text}**` : s.kind === 'italic' ? `*${s.text}*` : s.text)).join('')
const shown = (segs) => segs.map(s => s.text).join('')

describe('notesSegments — paired marks become runs, everything else is his text', () => {
  it('a heading in two asterisks is a bold run and its marks are gone', () => {
    expect(notesSegments('**Steps**')).toEqual([bold('Steps')])
    expect(notesSegments('**Heat** mild · **Make** Fri Oct 9')).toEqual([bold('Heat'), plain(' mild · '), bold('Make'), plain(' Fri Oct 9')])
    expect(notesSegments('Keep **all** the juice.')).toEqual([plain('Keep '), bold('all'), plain(' the juice.')])
    expect(notesSegments('pan + **66 g**.')).toEqual([plain('pan + '), bold('66 g'), plain('.')])
    expect(notesSegments('(**note**) and "**that**"')).toEqual([plain('('), bold('note'), plain(') and "'), bold('that'), plain('"')])
  })

  it('one asterisk each side is an italic run', () => {
    expect(notesSegments('*Day 1 — Fri Sept 25*')).toEqual([italic('Day 1 — Fri Sept 25')])
    expect(notesSegments('From the *Hot Ones* list.')).toEqual([plain('From the '), italic('Hot Ones'), plain(' list.')])
    expect(notesSegments('*one* and *two*')).toEqual([italic('one'), plain(' and '), italic('two')])
  })

  it('lines keep their breaks and their spacing; a run never swallows a line break', () => {
    const notes = 'Mojo Verde\n\n**Steps**\n1. Blend.\n   Keep the spacing.\n\n**Finish**\n- Fridge 7 days'
    const segs = notesSegments(notes)
    expect(segs).toEqual([
      plain('Mojo Verde\n\n'), bold('Steps'), plain('\n1. Blend.\n   Keep the spacing.\n\n'), bold('Finish'), plain('\n- Fridge 7 days'),
    ])
    expect(shown(segs)).toBe('Mojo Verde\n\nSteps\n1. Blend.\n   Keep the spacing.\n\nFinish\n- Fridge 7 days')
    expect(notesSegments('**Steps**\r\nnext')).toEqual([bold('Steps'), plain('\r\nnext')])
  })

  // M10b's cases. Each prints EXACTLY as typed: one plain run, equal to the input.
  it.each([
    ['arithmetic with spaces', '2 * 3 cups'],
    ['arithmetic without spaces', '2*3*4'],
    ['a bullet', '* strain\n* bottle hot'],
    ['a bullet before a bold run keeps its own asterisk', '* strain'],
    ['a lone mark', 'salt* to taste'],
    ['an opening mark nobody closes', '*Note: taste first'],
    ['two asterisks nobody closes', '**Steps'],
    ['a pair split by a line break', '**Steps\nand more**'],
    ['an italic pair split by a line break', '*soft\nset*'],
    ['marks round nothing', '**** and ** **'],
    ['marks with a space inside the pair', '** not bold ** and * not italic *'],
    ['three each side', '***very***'],
    ['a mark inside a word', 'un*frigging*believable'],
    ['a closing mark that runs into a word', '*a*b'],
    ['a footnote star', 'see the card*'],
  ])('%s prints as typed', (_what, notes) => {
    expect(notesSegments(notes)).toEqual([plain(notes)])
  })

  it('a bullet line can still hold a bold run; marks do not nest', () => {
    expect(notesSegments('* **Heat** mild')).toEqual([plain('* '), bold('Heat'), plain(' mild')])
    expect(notesSegments('**bold *and* more**')).toEqual([bold('bold *and* more')])
    expect(notesSegments('*soft **set** soft*')).toEqual([italic('soft **set** soft')])
  })

  it('nothing is injected: markup in the text is text, and so is everything that is not a string', () => {
    expect(notesSegments('<b>x</b> & **<i>y</i>**')).toEqual([plain('<b>x</b> & '), bold('<i>y</i>')])
    expect(notesSegments(null)).toEqual([])
    expect(notesSegments(undefined)).toEqual([])
    expect(notesSegments('')).toEqual([])
    expect(notesSegments(42)).toEqual([plain('42')])
  })

  // The property the display rests on: only marks are ever hidden. Putting them back gives the input.
  it('putting the marks back gives the input again — for a pile of awkward strings', () => {
    const awkward = [
      'a*b*c', '*', '**', '***', '* *', '** **', '*a', 'a*', '**a', 'a**', '*a**', '**a*', '*a* *b*', '**a** **b**', '*a***b**',
      'x *y* z **w** *', '\n*\n', '*\n*', '**\n**', 'tab\t*x*\tend', '🌶 *hot* 🌶', 'é*é*é', 'pH *as he wrote it* stays', '1. **Day 1**: *go*',
      '*a* **b** *c* **d**', '**a*b**', '*a**b*', '2 *3* 4', '5 * 2 = 10 and 3*2=6',
    ]
    for (const s of awkward) expect(typed(notesSegments(s))).toBe(s)
    // …and no run is ever empty, or carries a line break.
    for (const s of awkward) for (const seg of notesSegments(s)) {
      expect(seg.text.length).toBeGreaterThan(0)
      if (seg.kind !== 'plain') expect(seg.text).not.toMatch(/\n/)
    }
  })

  it('never changes a character that is not a mark: digits, spacing and punctuation survive', () => {
    const notes = '  Step 1.\n\n  Aim for *what the card says*; 20% vinegar.  '
    expect(shown(notesSegments(notes))).toBe('  Step 1.\n\n  Aim for what the card says; 20% vinegar.  ')
  })
})

describe('keepsKindChips — "How long, and where": six kinds, none merged, the stored one always shown', () => {
  it('opens on the three most recipes name, in order; the rest wait behind More…', () => {
    expect(KEEPS_COMMON_KINDS).toEqual(['fridge', 'deep_freezer', 'pantry'])
    for (const k of KEEPS_COMMON_KINDS) expect(RECIPE_STORAGE_KINDS).toContain(k)
    expect(keepsKindChips()).toEqual({ chips: ['fridge', 'deep_freezer', 'pantry'], more: ['fridge_freezer', 'cold_storage', 'other'] })
    expect(keepsKindChips().chips.map(k => STORAGE_KIND_WORDS[k])).toEqual(['Fridge', 'Deep freezer', 'Pantry shelf'])
  })

  it('More… shows every kind the Lambda takes, each once, each with its own words', () => {
    const { chips, more } = keepsKindChips({ moreOpen: true })
    expect(more).toEqual([])
    expect([...chips].sort()).toEqual([...RECIPE_STORAGE_KINDS].sort())
    expect(new Set(chips.map(k => STORAGE_KIND_WORDS[k])).size).toBe(6)
  })

  it.each(RECIPE_STORAGE_KINDS)('the stored kind is always a chip: %s', (kind) => {
    const closed = keepsKindChips({ value: kind, stored: kind })
    expect(closed.chips).toContain(kind)
    expect([...closed.chips, ...closed.more].sort()).toEqual([...RECIPE_STORAGE_KINDS].sort())
    // …and it stays one after another kind is chosen, so going back is one tap.
    expect(keepsKindChips({ value: 'fridge', stored: kind }).chips).toContain(kind)
  })

  it('a chosen kind from behind More… is a chip too; a kind the Lambda does not know is never one', () => {
    expect(keepsKindChips({ value: 'cold_storage' }).chips).toEqual(['fridge', 'deep_freezer', 'pantry', 'cold_storage'])
    expect(keepsKindChips({ value: 'attic', stored: 'garage' })).toEqual(keepsKindChips())
  })

  // The regression this guards (three chips over six stored kinds): an edit that never touches the line must
  // send it back exactly as it was stored, for every kind, and the PATCH rules must take it.
  it.each(RECIPE_STORAGE_KINDS)('an untouched line round-trips byte for byte: %s', (kind) => {
    for (const [n, unit] of [[7, 'day'], [2, 'week'], [18, 'month']]) {
      const recipe = { id: 'r1', name: 'Mojo', keeps_n: n, keeps_unit: unit, keeps_storage_kind: kind, lines: [] }
      const draft = draftFromRecipe(recipe)
      expect([draft.keepsN, draft.keepsUnit, draft.keepsKind]).toEqual([String(n), unit, kind])
      const { body } = recipeBody(draft, { mode: 'edit' })
      expect(JSON.stringify(body.keeps)).toBe(JSON.stringify({ n, unit, storage_kind: kind }))
      expect(validateRecipePatch(body)).toBeNull()
      // A draft that went to storage and came back (the sheet's own draft) sends the same line.
      const restored = JSON.parse(JSON.stringify(draft))
      expect(JSON.stringify(recipeBody(restored, { mode: 'edit' }).body.keeps)).toBe(JSON.stringify(body.keeps))
    }
  })

  it('a recipe with no such line still sends none, and the unit words are the Lambda\'s three', () => {
    expect(recipeBody(draftFromRecipe({ id: 'r1', name: 'Mojo', lines: [] }), { mode: 'edit' }).body.keeps).toBeNull()
    expect(Object.values(KEEPS_UNIT_WORDS).map(w => w[1])).toEqual(['days', 'weeks', 'months'])
  })
})

describe('typeChips — the type it opened on, the types in use, then the rest', () => {
  const TYPES = [
    { id: 'shrub', label: 'Shrub', builtin: false },
    { id: 'pesto', label: 'Pesto', builtin: true, sort_order: 70 },
    { id: 'hot', label: 'Hot sauce', builtin: true, sort_order: 10 },
    { id: 'jam', label: 'Jam & preserve', builtin: true, sort_order: 80 },
    { id: 'aji', label: 'Ají', builtin: false },
  ]
  const ids = (list) => list.map(x => x.id)

  it('with nothing chosen: the types the household\'s recipes use, in the list\'s own order', () => {
    const { front, rest } = typeChips({ types: TYPES, usedIds: ['pesto', 'shrub'] })
    expect(ids(front)).toEqual(['pesto', 'shrub'])
    expect(ids(rest)).toEqual(['hot', 'jam', 'aji'])
  })

  it('the type it opened on comes first, used or not, and is not repeated', () => {
    expect(ids(typeChips({ types: TYPES, pinned: 'jam', usedIds: ['pesto', 'hot'] }).front)).toEqual(['jam', 'hot', 'pesto'])
    expect(ids(typeChips({ types: TYPES, pinned: 'pesto', usedIds: ['pesto', 'hot'] }).front)).toEqual(['pesto', 'hot'])
    expect(ids(typeChips({ types: TYPES, pinned: 'jam', usedIds: ['pesto', 'hot'] }).rest)).toEqual(['aji', 'shrub'])
  })

  it('every type is in exactly one of the two lists; a household with no recipes yet has only the rest', () => {
    const { front, rest } = typeChips({ types: TYPES, pinned: 'aji', usedIds: ['hot'] })
    expect([...ids(front), ...ids(rest)].sort()).toEqual(ids(TYPES).sort())
    expect(typeChips({ types: TYPES })).toEqual({ front: [], rest: typeChips({ types: TYPES }).rest })
    expect(ids(typeChips({ types: TYPES }).rest)).toEqual(['hot', 'pesto', 'jam', 'aji', 'shrub'])
    expect(typeChips()).toEqual({ front: [], rest: [] })
    // A pinned or used id the list does not hold (the types have not loaded) names no chip.
    expect(typeChips({ types: [], pinned: 'jam', usedIds: ['hot'] })).toEqual({ front: [], rest: [] })
  })
})

describe('exactAmountOpens — when a line\'s number and unit show without being asked for', () => {
  it('opens by itself when the amount as written starts with a digit', () => {
    expect(exactAmountOpens({ amount: '412 g' })).toBe(true)
    expect(exactAmountOpens({ amount: '  2 cloves' })).toBe(true)
    expect(exactAmountOpens({ amount: '4' })).toBe(true)
  })

  it('stays open on a line that already holds a number, or a unit waiting for one', () => {
    expect(exactAmountOpens({ amount: 'a pinch', qty: '8', unit: 'g' })).toBe(true)
    expect(exactAmountOpens({ amount: '', qty: '8', unit: '' })).toBe(true)
    expect(exactAmountOpens({ amount: '', qty: '', unit: 'g' })).toBe(true)
    // What draftFromRecipe hands the sheet for a stored line with a number.
    const [withNumber, without] = draftFromRecipe({ lines: [{ name: 'salt', amount_text: 'salt', qty: '20', qty_unit: 'g' }, { name: 'cumin', amount_text: 'pinch' }] }).lines
    expect([exactAmountOpens(withNumber), exactAmountOpens(without)]).toEqual([true, false])
  })

  it('stays shut for words, an empty line and nothing at all', () => {
    expect(exactAmountOpens({ amount: 'pinch' })).toBe(false)
    expect(exactAmountOpens({ amount: 'a 5 oz bottle' })).toBe(false)
    expect(exactAmountOpens({ amount: '', qty: '', unit: '' })).toBe(false)
    expect(exactAmountOpens({ amount: '  ', qty: '  ' })).toBe(false)
    expect(exactAmountOpens(undefined)).toBe(false)
  })
})

describe('the words, as the plan fixes them', () => {
  it('"Made it, ate it all" and its confirm (D9)', () => {
    expect(I_MADE_THIS_CTA).toBe('Made it, ate it all')
    expect(MADE_CONFIRM_TEXT).toBe('Logs a make of this for today, every line as written. Nothing goes into the Pantry.')
    expect(MADE_CONFIRM_CTA).toBe('Log this make')
    expect(KEPT_SOME_CTA).toBe('Kept some? Start a batch instead →')
  })

  it('the recipe sheet (D7)', () => {
    expect([TYPE_LABEL, TYPE_HELP]).toEqual(['What it makes', 'Groups it in your recipe list.'])
    expect([KIND_LABEL, KIND_HELP]).toEqual(["How it's made", 'The kind of batch Make this starts.'])
    expect(MORE_TYPES_CTA).toBe('More types…')
    expect([LINE_NAME_LABEL, LINE_AMOUNT_LABEL, AT_THE_END_LABEL, EXACT_AMOUNT_CTA]).toEqual(['Name', "Amount as you'd write it", 'at the end', '▸ exact amount'])
    expect([KEEPS_LABEL, KEEPS_N_LABEL, MORE_PLACES_CTA, COOKED_LABEL]).toEqual(['How long, and where', 'How many', 'More…', 'Cooked after blending'])
  })

  // INSTRUMENT, then the sweep: no banned word in any string this file adds to a surface.
  const BANNED = /\b(safe|shelf life|shelf-stable|keeps|good|ready|done|expired|table|default|basis)\b/i
  it('none of them holds a banned word', () => {
    expect('How long it keeps').toMatch(BANNED)
    const words = [I_MADE_THIS_CTA, MADE_CONFIRM_TEXT, MADE_CONFIRM_CTA, KEPT_SOME_CTA, TYPE_LABEL, TYPE_HELP, MORE_TYPES_CTA, KIND_LABEL, KIND_HELP,
      LINE_NAME_LABEL, LINE_AMOUNT_LABEL, AT_THE_END_LABEL, EXACT_AMOUNT_CTA, KEEPS_LABEL, KEEPS_N_LABEL, MORE_PLACES_CTA, COOKED_LABEL,
      ...Object.values(STORAGE_KIND_WORDS), ...Object.values(KEEPS_UNIT_WORDS).flat()]
    for (const w of words) expect(w).not.toMatch(BANNED)
  })

  it('a new recipe\'s body is still what the create rules take (nothing here changed the draft\'s shape)', () => {
    expect(Object.keys(emptyDraft())).toEqual(['key', 'name', 'typeId', 'kind', 'link', 'notes', 'keepsN', 'keepsUnit', 'keepsKind',
      'vesselLabel', 'vesselSize', 'vesselUnit', 'vesselCount', 'bottleLabel', 'bottleSize', 'bottleUnit', 'bottleCooked', 'madeText', 'lines'])
    const { body } = recipeBody({ ...emptyDraft(), name: 'Mojo', notes: '**Steps**\n1. *Blend*.', keepsN: '3', keepsUnit: 'week', keepsKind: 'other' })
    expect(body.notes).toBe('**Steps**\n1. *Blend*.')
    expect(body.keeps).toEqual({ n: 3, unit: 'week', storage_kind: 'other' })
    expect(validateRecipeCreate(body)).toBeNull()
  })
})
