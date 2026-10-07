// V5-SEEDMULTIPARENT-001 release 2b — seedParents.js: the parent set read once, and the one function every
// notice about a jar comes from (the geneticist's truth table, rows 0-10). Each row is a named case; the
// three ways a lot carries no readable set are three named cases; and with SEED_MULTI_PARENT off the answer
// is today's rule on the filed variety, whatever the set holds.
import { describe, it, expect, vi, afterEach } from 'vitest'

// The truth-table cases are the flag-ON answers, so the flag is held on here whichever way the literal
// ships (a forward flag-off build must not redden them); featureFlags.test.js alone pins the literal.
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({ ...(await importOriginal()), SEED_MULTI_PARENT: true }))

import {
  sourcePlantFromPlanting, parentSetFacts, lotNotice, previewMixName, isSavedLot,
} from '../components/seed/seedParents.js'
import { isF2Lot, F2_LABEL, isSavedLot as isSavedLotFromSeedLots } from '../components/seed/seedLots.js'
import { PARENTS_UNDEFINED, PARENTS_NULL, PARENTS_EMPTY, PARENTS_R1, lotReply } from './fixtures/seedMix.fixture.js'

const sp = (id, variety, over = {}) => ({
  id, name: `planting ${id}`,
  variety_id: variety ? `v-${variety.toLowerCase().replace(/\W+/g, '-')}` : null,
  variety_name: variety ?? null, breeding_system: null, variety_rank: variety ? 'cultivar' : null,
  crop_slug: 'pepper', archived: false, deleted: false, ...over,
})
const f1 = (id, variety, over = {}) => sp(id, variety, { breeding_system: 'f1', ...over })
const lot = (source_plants, over = {}) => ({
  id: 'lot-1', name: 'Porch jar', variety_id: 'v-filed', variety_name: 'Filed', variety_rank: 'cultivar',
  breeding_system: null, source_plant_id: source_plants?.[0]?.id ?? 'pl-1', source_plants, ...over,
})

const F2_CHIP = { key: 'f2', label: 'F2 — won’t come true' }
const MIXED_CHIP = { key: 'mixed', label: 'Mixed seed' }
const PART_CHIP = { key: 'part_f2', label: 'Part F2' }
const ROW1_FACT = 'F2 — won’t come true (parent F1 hybrid)'

describe('sourcePlantFromPlanting — a planting row as the contract element', () => {
  it('a picker row with its variety', () => {
    expect(sourcePlantFromPlanting({
      id: 'pl-1', name: 'Carmen east', quantity: 3, archived_at: null, variety_id: 'v-car',
      variety_ref: { id: 'v-car', name: 'Carmen', crop_type_slug: 'pepper', breeding_system: 'f1', variety_rank: 'cultivar', blend_key: null },
    })).toEqual({
      id: 'pl-1', name: 'Carmen east', variety_id: 'v-car', variety_name: 'Carmen', breeding_system: 'f1',
      variety_rank: 'cultivar', crop_slug: 'pepper', archived: false, deleted: false,
    })
  })

  it('no variety, no name, archived', () => {
    expect(sourcePlantFromPlanting({ id: 'pl-2', archived_at: '2026-09-01T00:00:00.000Z' })).toEqual({
      id: 'pl-2', name: '', variety_id: null, variety_name: null, breeding_system: null,
      variety_rank: null, crop_slug: null, archived: true, deleted: false,
    })
  })

  it('a row whose variety_ref is missing keeps its variety_id, and a ref without a rank reads null', () => {
    expect(sourcePlantFromPlanting({ id: 'pl-3', name: 'x', variety_id: 'v-gone', variety_ref: null }))
      .toMatchObject({ variety_id: 'v-gone', variety_name: null, crop_slug: null })
    expect(sourcePlantFromPlanting({ id: 'pl-4', name: 'x', variety_ref: { id: 'v-a', name: 'A', crop_type_slug: 'tomato', breeding_system: null } }))
      .toMatchObject({ variety_id: 'v-a', variety_rank: null, breeding_system: null, crop_slug: 'tomato' })
  })

  it('has exactly the keys of a contract element', () => {
    const contractKeys = Object.keys(lotReply().source_plants[0]).sort()
    expect(Object.keys(sourcePlantFromPlanting({ id: 'pl-1', name: 'x' })).sort()).toEqual(contractKeys)
  })
})

describe('parentSetFacts', () => {
  it('source_plants undefined: not known, nothing to read', () => {
    expect(parentSetFacts(PARENTS_UNDEFINED)).toEqual({
      known: false, plantings: [], varieties: [], k: 0, mixed: false, varietyIds: [], cropSlug: null,
    })
  })
  it('source_plants null: not known, nothing to read', () => {
    expect(parentSetFacts(PARENTS_NULL)).toMatchObject({ known: false, plantings: [], k: 0, mixed: false })
  })
  it('source_plants []: known, and empty', () => {
    expect(parentSetFacts(PARENTS_EMPTY)).toMatchObject({ known: true, plantings: [], k: 0, mixed: false, varietyIds: [], cropSlug: null })
  })

  it('distinct varieties in first-seen order, each with its plantings', () => {
    const set = [f1('pl-1', 'Carmen'), sp('pl-2', 'Ajvarski', { breeding_system: 'open_pollinated' }), f1('pl-3', 'Carmen')]
    const facts = parentSetFacts(set)
    expect(facts).toMatchObject({ known: true, k: 2, mixed: true, cropSlug: 'pepper' })
    expect(facts.plantings).toHaveLength(3)
    expect(facts.varieties).toEqual([
      { variety_id: 'v-carmen', variety_name: 'Carmen', breeding_system: 'f1', variety_rank: 'cultivar', crop_slug: 'pepper', plantingIds: ['pl-1', 'pl-3'] },
      { variety_id: 'v-ajvarski', variety_name: 'Ajvarski', breeding_system: 'open_pollinated', variety_rank: 'cultivar', crop_slug: 'pepper', plantingIds: ['pl-2'] },
    ])
    // varietyIds are sorted (uuid order), whatever order the plantings came in.
    expect(facts.varietyIds).toEqual(['v-ajvarski', 'v-carmen'])
  })

  it('plantings with NO variety are ONE entry, and are not in varietyIds', () => {
    const facts = parentSetFacts([sp('pl-1', null), sp('pl-2', null), sp('pl-3', 'Carmen')])
    expect(facts.k).toBe(2)
    expect(facts.varieties[0]).toMatchObject({ variety_id: null, plantingIds: ['pl-1', 'pl-2'] })
    expect(facts.varietyIds).toEqual(['v-carmen'])
  })

  it('archived and deleted plantings still count: a retired planting is still where the seed came off', () => {
    const facts = parentSetFacts([sp('pl-1', 'Carmen', { archived: true }), sp('pl-2', 'Ajvarski', { deleted: true })])
    expect([facts.plantings.length, facts.k]).toEqual([2, 2])
  })

  it('cropSlug: the shared crop, undefined when there is more than one, and no crop is a crop of its own', () => {
    expect(parentSetFacts([sp('pl-1', 'A'), sp('pl-2', 'B')]).cropSlug).toBe('pepper')
    expect(parentSetFacts([sp('pl-1', 'A'), sp('pl-2', 'B', { crop_slug: 'tomato' })]).cropSlug).toBeUndefined()
    expect(parentSetFacts([sp('pl-1', 'A'), sp('pl-2', null, { crop_slug: null })]).cropSlug).toBeUndefined()
    expect(parentSetFacts([sp('pl-1', null, { crop_slug: null })]).cropSlug).toBeNull()
  })
})

describe('lotNotice — the truth table', () => {
  describe('row 0: no parent set to read, so today’s rule on the filed variety', () => {
    const cases = [['source_plants undefined', PARENTS_UNDEFINED], ['source_plants null', PARENTS_NULL], ['source_plants []', PARENTS_EMPTY]]
    for (const [name, parents] of cases) {
      it(`${name}: a saved lot filed under an F1 is F2, in full`, () => {
        expect(lotNotice(lot(parents, { breeding_system: 'f1', source_plant_id: 'pl-1' }))).toEqual({
          row: 0, chips: [F2_CHIP], sentences: [], f2: 'full', breedingFact: ROW1_FACT,
        })
      })
      it(`${name}: a bought F1 packet, and a saved lot that is not F1, say nothing`, () => {
        const quiet = { row: 0, chips: [], sentences: [], f2: null, breedingFact: null }
        expect(lotNotice({ breeding_system: 'f1', source_id: 'src-1', source_plants: parents })).toEqual(quiet)
        expect(lotNotice(lot(parents, { breeding_system: 'open_pollinated', source_plant_id: 'pl-1' }))).toEqual(quiet)
      })
      it(`${name}: a jar filed under a mix reads N2`, () => {
        expect(lotNotice(lot(parents, { variety_rank: 'blend', variety_name: 'Carmen + Ajvarski mix', source_plant_id: 'pl-1' })).sentences).toEqual([
          'Carmen + Ajvarski mix is a mix, not one variety. This jar holds only what the plants you gathered from carried, so the mix shifts each time it is saved.',
        ])
      })
    }
    it('no lot at all', () => {
      expect(lotNotice(null)).toEqual({ row: 0, chips: [], sentences: [], f2: null, breedingFact: null })
      expect(lotNotice(undefined).row).toBe(0)
    })
  })

  it('row 1: one cultivar, F1 — the F2 chip, in full; N5 only from two plantings up', () => {
    expect(lotNotice(lot([f1('pl-1', 'Carmen')]))).toEqual({
      row: 1, chips: [F2_CHIP], sentences: [], f2: 'full', breedingFact: ROW1_FACT,
    })
    expect(lotNotice(lot([f1('pl-1', 'Carmen'), f1('pl-2', 'Carmen'), f1('pl-3', 'Carmen')]))).toEqual({
      row: 1, chips: [F2_CHIP], sentences: ['From 3 plantings of Carmen.'], f2: 'full', breedingFact: ROW1_FACT,
    })
  })

  it('row 1 ADDS the label to a jar whose filed variety is not F1', () => {
    expect(lotNotice(lot([f1('pl-1', 'Carmen')], { breeding_system: 'open_pollinated' })).f2).toBe('full')
  })

  it('row 2: one parent variety that is itself a mix — N2, then N5; no chip and NO Breeding fact', () => {
    const blend = (id) => sp(id, 'Fairy Tale mix', { variety_rank: 'blend' })
    expect(lotNotice(lot([blend('pl-1'), blend('pl-2')], { breeding_system: 'open_pollinated' }))).toEqual({
      row: 2, chips: [], f2: null, breedingFact: '',
      sentences: [
        'Fairy Tale mix is a mix, not one variety. This jar holds only what the plants you gathered from carried, so the mix shifts each time it is saved.',
        'From 2 plantings of Fairy Tale mix.',
      ],
    })
    expect(lotNotice(lot([sp('pl-1', 'Fairy Tale mix', { variety_rank: 'blend', breeding_system: 'unknown' })])).row).toBe(2)
  })

  const oneVariety = [
    [3, 'open_pollinated'],
    [4, 'landrace'],
    [5, 'unknown'],
    [6, null],
  ]
  for (const [row, breeding] of oneVariety) {
    it(`row ${row}: one cultivar, ${breeding ?? 'breeding never recorded'} — no chip; N5 from two plantings up`, () => {
      const one = lotNotice(lot([sp('pl-1', 'Ajvarski', { breeding_system: breeding })]))
      expect(one).toEqual({ row, chips: [], sentences: [], f2: null, breedingFact: null })
      const two = lotNotice(lot([sp('pl-1', 'Ajvarski', { breeding_system: breeding }), sp('pl-2', 'Ajvarski', { breeding_system: breeding })]))
      expect(two).toEqual({ row, chips: [], sentences: ['From 2 plantings of Ajvarski.'], f2: null, breedingFact: null })
    })
    it(`row ${row}: a jar filed under an F1 keeps its F2 label — the set never removes one`, () => {
      const n = lotNotice(lot([sp('pl-1', 'Ajvarski', { breeding_system: breeding })], { breeding_system: 'f1' }))
      expect(n).toMatchObject({ row, chips: [F2_CHIP], f2: 'full', breedingFact: ROW1_FACT })
    })
  }

  it('row 2 filed under an F1 keeps its F2 label too', () => {
    const n = lotNotice(lot([sp('pl-1', 'Fairy Tale mix', { variety_rank: 'blend' })], { breeding_system: 'f1' }))
    expect(n).toMatchObject({ row: 2, chips: [F2_CHIP], f2: 'full', breedingFact: ROW1_FACT })
  })

  it('row 7: the one entry is a plant with no variety — read as row 0, on the filed variety', () => {
    const none = [sp('pl-1', null), sp('pl-2', null)]
    expect(lotNotice(lot(none))).toEqual({ row: 7, chips: [], sentences: [], f2: null, breedingFact: null })
    expect(lotNotice(lot(none, { breeding_system: 'f1' }))).toEqual({
      row: 7, chips: [F2_CHIP], sentences: [], f2: 'full', breedingFact: ROW1_FACT,
    })
  })

  it('row 8: two or more cultivars, every one F1 — Mixed seed + F2, N1 then N4', () => {
    expect(lotNotice(lot([f1('pl-1', 'Sungold'), f1('pl-2', 'Carmen')]))).toEqual({
      row: 8, chips: [MIXED_CHIP, F2_CHIP], f2: 'full',
      sentences: [
        'Mixed seed from Carmen and Sungold. Each seed came off one or the other, and some may be crosses. Expect more than one kind of plant from this jar.',
        'Every plant here is an F1 hybrid, so none of this seed will come true.',
      ],
      breedingFact: 'F2 — won’t come true (parents F1 hybrids)',
    })
  })

  it('row 9: some F1 — Mixed seed + Part F2, N1 then N3 naming the F1', () => {
    const set = [sp('pl-1', 'Ajvarski', { breeding_system: 'open_pollinated' }), f1('pl-2', 'Carmen'), sp('pl-3', 'Jimmy Nardello', { breeding_system: 'landrace' })]
    expect(lotNotice(lot(set))).toEqual({
      row: 9, chips: [MIXED_CHIP, PART_CHIP], f2: 'part',
      sentences: [
        'Mixed seed from Ajvarski, Carmen and Jimmy Nardello. Each seed came off one of them, and some may be crosses. Expect more than one kind of plant from this jar.',
        'The seed that came off Carmen, an F1 hybrid, will vary, sometimes a lot.',
      ],
      breedingFact: 'Part F2 (Carmen is an F1 hybrid)',
    })
  })

  it('row 9: a no-variety parent and a parent that is itself a mix both count as not F1', () => {
    const withNone = lotNotice(lot([f1('pl-1', 'Carmen'), sp('pl-2', null)]))
    expect(withNone).toMatchObject({ row: 9, f2: 'part' })
    expect(withNone.sentences[0]).toBe('Mixed seed from Carmen and a plant with no variety recorded. Each seed came off one or the other, and some may be crosses. Expect more than one kind of plant from this jar.')
    const withBlend = lotNotice(lot([f1('pl-1', 'Carmen'), sp('pl-2', 'Fairy Tale mix', { variety_rank: 'blend', breeding_system: 'f1' })]))
    expect(withBlend).toMatchObject({ row: 9, f2: 'part', breedingFact: 'Part F2 (Carmen is an F1 hybrid)' })
  })

  it('row 9 with two F1s among three: one N3 each, and the fact names both', () => {
    const n = lotNotice(lot([f1('pl-1', 'Sungold'), f1('pl-2', 'Carmen'), sp('pl-3', 'Ajvarski')]))
    expect(n.sentences.slice(1)).toEqual([
      'The seed that came off Carmen, an F1 hybrid, will vary, sometimes a lot.',
      'The seed that came off Sungold, an F1 hybrid, will vary, sometimes a lot.',
    ])
    expect(n.breedingFact).toBe('Part F2 (Carmen and Sungold are F1 hybrids)')
  })

  it('row 10: none F1 — Mixed seed only, N1 only, NO Breeding fact, and no F2 label even filed under an F1', () => {
    const set = [sp('pl-1', 'Jimmy Nardello', { breeding_system: 'landrace' }), sp('pl-2', 'Ajvarski', { breeding_system: 'open_pollinated' })]
    const expected = {
      row: 10, chips: [MIXED_CHIP], f2: null, breedingFact: '',
      sentences: ['Mixed seed from Ajvarski and Jimmy Nardello. Each seed came off one or the other, and some may be crosses. Expect more than one kind of plant from this jar.'],
    }
    expect(lotNotice(lot(set))).toEqual(expected)
    expect(lotNotice(lot(set, { breeding_system: 'f1' }))).toEqual(expected)
  })

  it('rows 8-10 never print N2, even when the jar is filed under a mix', () => {
    const n = lotNotice(lot([sp('pl-1', 'A'), sp('pl-2', 'B')], { variety_rank: 'blend', variety_name: 'A + B mix' }))
    expect(n.sentences).toHaveLength(1)
    expect(n.sentences[0]).toMatch(/^Mixed seed from A and B\./)
  })

  it('N1 names follow the mix name’s order (lower-cased code units), not the order the plants were picked', () => {
    const n = lotNotice(lot([sp('pl-1', 'zebra'), sp('pl-2', 'Apple'), sp('pl-3', 'mango'), sp('pl-4', 'Banana')]))
    expect(n.sentences[0]).toMatch(/^Mixed seed from Apple, Banana, mango and zebra\. Each seed came off one of them,/)
  })

  it('the release-1 default (one element mirroring the cache) answers as today', () => {
    const filed = { source_plant_id: 'pl-1', variety_id: 'v-car', variety_name: 'Carmen', breeding_system: 'f1', variety_rank: 'cultivar', crop_slug: 'pepper' }
    expect(lotNotice({ ...filed, source_plants: PARENTS_R1(filed) })).toMatchObject({ row: 1, chips: [F2_CHIP], f2: 'full', breedingFact: ROW1_FACT })
    const op = { ...filed, breeding_system: 'open_pollinated' }
    expect(lotNotice({ ...op, source_plants: PARENTS_R1(op) })).toEqual({ row: 3, chips: [], sentences: [], f2: null, breedingFact: null })
  })

  it('every chip carries one of the three keys and its own words; the F2 words are seedLots’ F2_LABEL', () => {
    expect(F2_CHIP.label).toBe(F2_LABEL)
    expect(lotNotice(lot([f1('pl-1', 'Carmen')])).chips[0].label).toBe(F2_LABEL)
  })
})

describe('isF2Lot (seedLots.js) is lotNotice(i).f2 === "full"', () => {
  it('agrees with lotNotice on every row', () => {
    const lots = [
      lot(PARENTS_NULL, { breeding_system: 'f1' }),
      lot(PARENTS_EMPTY),
      lot([f1('pl-1', 'Carmen')]),
      lot([f1('pl-1', 'Carmen'), f1('pl-2', 'Sungold')]),
      lot([f1('pl-1', 'Carmen'), sp('pl-2', 'Ajvarski')]),
      lot([sp('pl-1', 'A'), sp('pl-2', 'B')], { breeding_system: 'f1' }),
    ]
    expect(lots.map(isF2Lot)).toEqual([true, false, true, true, false, false])
    for (const l of lots) expect(isF2Lot(l)).toBe(lotNotice(l).f2 === 'full')
  })

  it('isSavedLot is one function, exported from both modules', () => {
    expect(isSavedLotFromSeedLots).toBe(isSavedLot)
    expect(isSavedLot({ source_plant_id: 'pl-1' })).toBe(true)
    expect(isSavedLot({ source_kind: 'gift' })).toBe(true)
    expect(isSavedLot({ seed_stage: 'stored' })).toBe(true)
    expect(isSavedLot({ source_id: 'src-1' })).toBe(false)
    expect(isSavedLot(null)).toBe(false)
  })
})

describe('previewMixName — lambda/varieties/blend.js’s automatic name, read on the client', () => {
  const v = (name, id = `v-${name}`) => ({ variety_id: id, variety_name: name })

  it('two names: joined with " + ", then " mix"', () => {
    expect(previewMixName([v('Sungold'), v('Carmen')])).toBe('Carmen + Sungold mix')
  })
  it('three names', () => {
    expect(previewMixName([v('Sungold'), v('Carmen'), v('Ajvarski')])).toBe('Ajvarski + Carmen + Sungold mix')
  })
  it('four or more: the first two and a count', () => {
    expect(previewMixName([v('D'), v('C'), v('B'), v('A')])).toBe('A + B + 2 more')
    expect(previewMixName([v('E'), v('D'), v('C'), v('B'), v('A')])).toBe('A + B + 3 more')
  })
  it('no " mix" suffix when EVERY name already says mix or blend as a whole word', () => {
    expect(previewMixName([v('Jewel Mix Nasturtium'), v('Alaska Mix')])).toBe('Alaska Mix + Jewel Mix Nasturtium')
    expect(previewMixName([v('Salad Blend'), v('alaska mix')])).toBe('alaska mix + Salad Blend')
    // one of two says it: the suffix stays. "Mixed" and "Blender" are not the whole word.
    expect(previewMixName([v('Alaska Mix'), v('Carmen')])).toBe('Alaska Mix + Carmen mix')
    expect(previewMixName([v('Mixed Greens'), v('Blender Kale')])).toBe('Blender Kale + Mixed Greens mix')
  })
  it('mixed case sorts by the lower-cased name, by code unit — never the locale’s order', () => {
    expect(previewMixName([v('banana'), v('Apple'), v('cherry')])).toBe('Apple + banana + cherry mix')
    // Code units: "é" (U+00E9) sorts after "z"; a locale collator would put it beside "e".
    expect(previewMixName([v('zucchini'), v('éclair')])).toBe('zucchini + éclair mix')
    // "_" (U+005F) sorts before lower-case letters and after digits.
    expect(previewMixName([v('a_b'), v('aab'), v('a1b')])).toBe('a1b + a_b + aab mix')
  })
  it('the same name twice: the id breaks the tie', () => {
    expect(previewMixName([v(' Carmen (red)', 'v-2'), v('Carmen', 'v-9'), v('Carmen', 'v-1')])).toBe('Carmen (red) + Carmen + Carmen mix')
    expect(previewMixName([{ variety_id: 'b', variety_name: 'Same' }, { variety_id: 'a', variety_name: 'same' }]))
      .toBe('same + Same mix')
  })
  it('names are trimmed; an entry with no variety is not part of the name; fewer than two is not a mix', () => {
    expect(previewMixName([v('  Carmen '), v('Sungold  ')])).toBe('Carmen + Sungold mix')
    expect(previewMixName([v('Carmen'), { variety_id: null, variety_name: null }])).toBe('Carmen')
    expect(previewMixName([v('Carmen')])).toBe('Carmen')
    expect(previewMixName([])).toBe('')
    expect(previewMixName(undefined)).toBe('')
  })
  it('reads parentSetFacts’ varieties as they are', () => {
    const facts = parentSetFacts([f1('pl-1', 'Sungold'), f1('pl-2', 'Carmen'), f1('pl-3', 'Sungold')])
    expect(previewMixName(facts.varieties)).toBe('Carmen + Sungold mix')
  })
})

describe('SEED_MULTI_PARENT off — today’s answers, whatever source_plants holds', () => {
  afterEach(() => {
    vi.doMock('../lib/featureFlags.js', async (importOriginal) => ({ ...(await importOriginal()), SEED_MULTI_PARENT: true }))
    vi.resetModules()
  })

  async function flagOff() {
    vi.resetModules()
    vi.doMock('../lib/featureFlags.js', async (importOriginal) => ({ ...(await importOriginal()), SEED_MULTI_PARENT: false }))
    const parents = await import('../components/seed/seedParents.js')
    const lots = await import('../components/seed/seedLots.js')
    const facts = await import('../components/seed/seedFacts.js')
    const model = await import('../components/seed/mySeedsModel.js')
    return { ...parents, isF2Lot: lots.isF2Lot, seedFacts: facts.seedFacts, whereFrom: model.whereFrom }
  }

  const mixedNoF1 = [sp('pl-1', 'A'), sp('pl-2', 'B')]
  const allF1 = [f1('pl-1', 'Carmen'), f1('pl-2', 'Sungold')]

  it('a jar filed under an F1 is F2 in full, even over a mixed set with no F1 in it (row 10 when on)', async () => {
    const m = await flagOff()
    const l = lot(mixedNoF1, { breeding_system: 'f1' })
    expect(m.lotNotice(l)).toEqual({ row: 0, chips: [F2_CHIP], sentences: [], f2: 'full', breedingFact: ROW1_FACT })
    expect(m.isF2Lot(l)).toBe(true)
    expect(m.seedFacts(l).find((f) => f.key === 'breeding').value).toBe(ROW1_FACT)
  })

  it('a jar NOT filed under an F1 says nothing, even when every parent is F1 (row 8 when on)', async () => {
    const m = await flagOff()
    const l = lot(allF1, { breeding_system: 'open_pollinated' })
    expect(m.lotNotice(l)).toEqual({ row: 0, chips: [], sentences: [], f2: null, breedingFact: null })
    expect(m.isF2Lot(l)).toBe(false)
    expect(m.seedFacts(l).find((f) => f.key === 'breeding').value).toBe('Open-pollinated')
  })

  it('no N2 for a jar filed under a mix, and no N5 for several plantings', async () => {
    const m = await flagOff()
    expect(m.lotNotice(lot(PARENTS_EMPTY, { variety_rank: 'blend', variety_name: 'A + B mix' })).sentences).toEqual([])
    expect(m.lotNotice(lot([f1('pl-1', 'Carmen'), f1('pl-2', 'Carmen')])).sentences).toEqual([])
  })

  it('the three no-parent cases answer the same as with the flag on', async () => {
    const m = await flagOff()
    for (const parents of [PARENTS_UNDEFINED, PARENTS_NULL, PARENTS_EMPTY]) {
      const l = lot(parents, { breeding_system: 'f1', source_plant_id: 'pl-1' })
      expect(m.lotNotice(l)).toEqual({ ...lotNotice(l), sentences: [] })
    }
  })

  it('My seeds says "Saved from my plant" for a jar off several plantings', async () => {
    const m = await flagOff()
    expect(m.whereFrom(lot(allF1), null)).toBe('Saved from my plant')
  })
})
