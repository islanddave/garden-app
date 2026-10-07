// V5-SEEDCARDS-001 — the one seed-fact vocabulary behind My seeds' expanded row and the seed's detail
// page. Both pages read seedFacts(); these pins are the words themselves, so a wording change is made
// once, here, and shows on both.
import { describe, it, expect, vi } from 'vitest'

// V5-SEEDMULTIPARENT-001 release 2b — the parent-set cases below are the flag-ON answers. The flag is held
// on here so they stay green on a forward flag-off build; featureFlags.test.js alone pins the shipped
// literal, and seedParents.test.js holds the flag-off answers.
vi.mock('../lib/featureFlags.js', async (importOriginal) => ({ ...(await importOriginal()), SEED_MULTI_PARENT: true }))
import { seedFacts, heatFact, HEAT_SOURCE_WORDS } from '../components/seed/seedFacts.js'

const PEPPER = {
  crop_slug: 'pepper', scoville_min: 100000, scoville_max: 350000, scoville_source: 'vendor_catalog',
  origin_country: 'Mexico', origin_region: 'Yucatán', species: 'Capsicum chinense',
  days_to_maturity_min: 90, days_to_maturity_max: 100, dtm_basis: 'from-transplant', breeding_system: 'f1',
}
const pairs = (facts) => facts.map((f) => [f.label, f.value])

describe('seedFacts', () => {
  it('fixed order — From, Heat, Country of origin, Species, Days to maturity, Breeding', () => {
    expect(pairs(seedFacts(PEPPER, { from: 'Sandia Seed Company · bought 2025' }))).toEqual([
      ['From', 'Sandia Seed Company · bought 2025'],
      ['Heat', '100,000–350,000 SHU · from a seller’s catalogue'],
      ['Country of origin', 'Mexico · Yucatán'],
      ['Species', 'Capsicum chinense'],
      ['Days to maturity', '90–100 days from transplant'],
      ['Breeding', 'F1 hybrid'],
    ])
    expect(seedFacts(PEPPER).find((f) => f.key === 'species').italic).toBe(true)
    expect(seedFacts(PEPPER).map((f) => f.key)).toEqual(['heat', 'origin', 'species', 'dtm', 'breeding'])
  })

  it('an absent fact is left out, never dashed; blanks and "unknown" count as absent', () => {
    const got = seedFacts({
      crop_slug: 'tomato', origin_country: '  ', origin_region: null, species: '', breeding_system: 'unknown',
      days_to_maturity_min: 75, days_to_maturity_max: null, dtm_basis: null,
    })
    expect(pairs(got)).toEqual([['Days to maturity', '75 days']])
    expect(seedFacts({ crop_slug: 'tomato' })).toEqual([])
    expect(seedFacts(null)).toEqual([])
  })

  it('maturity: one number when min = max or one is missing; the basis only when the cultivar states it', () => {
    expect(seedFacts({ days_to_maturity_min: 80, days_to_maturity_max: 80, dtm_basis: 'from-sow' })[0].value).toBe('80 days from sowing')
    expect(seedFacts({ days_to_maturity_max: 65 })[0].value).toBe('65 days')
    expect(seedFacts({ days_to_maturity_min: 'x' })).toEqual([])
  })

  it('breeding words', () => {
    expect(seedFacts({ breeding_system: 'open_pollinated' })[0].value).toBe('Open-pollinated')
    expect(seedFacts({ breeding_system: 'landrace' })[0].value).toBe('Landrace')
  })

  // V5-SEEDSTAB-001 slice 3 — the facts must not tell Dave a jar of F2 seed is "F1 hybrid". Both
  // readers (My seeds' expanded row, the detail page's packet card) change together, here.
  it('a lot saved off an F1 plant reads as F2 from an F1 parent — never "F1 hybrid"; a bought packet keeps "F1 hybrid"', () => {
    const breeding = (i) => seedFacts(i).find((f) => f.key === 'breeding')?.value
    for (const saved of [{ seed_stage: 'stored' }, { source_plant_id: 'pl-1' }, { source_kind: 'farm_stand' }]) {
      expect(breeding({ breeding_system: 'f1', ...saved })).toBe('F2 — won’t come true (parent F1 hybrid)')
      expect(breeding({ breeding_system: 'f1', ...saved })).not.toBe('F1 hybrid')
    }
    expect(breeding({ breeding_system: 'f1' })).toBe('F1 hybrid')
    expect(breeding({ breeding_system: 'f1', source_id: 'src-sandia' })).toBe('F1 hybrid')
    // A saved lot of any other cultivar keeps the cultivar's own word — it is only F1 that turns over.
    expect(breeding({ breeding_system: 'open_pollinated', seed_stage: 'stored' })).toBe('Open-pollinated')
    expect(breeding({ breeding_system: 'unknown', seed_stage: 'stored' })).toBeUndefined()
    // Same place in the fixed order: last.
    expect(seedFacts({ ...PEPPER, seed_stage: 'stored' }).map((f) => f.key)).toEqual(['heat', 'origin', 'species', 'dtm', 'breeding'])
  })

  // V5-SEEDMULTIPARENT-001 release 2b — the Breeding fact is seedParents.lotNotice's, one per truth-table
  // row. Row 1's string is byte-equal to the one above (seed-detail-shot.mjs asserts it on the page).
  describe('Breeding fact for a jar with a parent set', () => {
    const breeding = (i) => seedFacts(i).find((f) => f.key === 'breeding')?.value
    const parent = (id, variety, breeding_system, over = {}) => ({
      id, name: id, variety_id: `v-${variety}`, variety_name: variety, breeding_system, variety_rank: 'cultivar',
      crop_slug: 'pepper', archived: false, deleted: false, ...over,
    })
    const jar = (source_plants, over = {}) => ({ source_plant_id: 'p1', seed_stage: 'stored', breeding_system: null, source_plants, ...over })

    it('source_plants undefined, null and [] are each the filed variety’s own answer', () => {
      for (const source_plants of [undefined, null, []]) {
        expect(breeding(jar(source_plants, { breeding_system: 'f1' }))).toBe('F2 — won’t come true (parent F1 hybrid)')
        expect(breeding(jar(source_plants, { breeding_system: 'landrace' }))).toBe('Landrace')
        expect(breeding(jar(source_plants))).toBeUndefined()
      }
    })
    it('row 1 (one F1 cultivar): unchanged, byte for byte', () => {
      expect(breeding(jar([parent('p1', 'Carmen', 'f1'), parent('p2', 'Carmen', 'f1')], { breeding_system: 'f1' })))
        .toBe('F2 — won’t come true (parent F1 hybrid)')
    })
    it('row 8 (every cultivar F1)', () => {
      expect(breeding(jar([parent('p1', 'Carmen', 'f1'), parent('p2', 'Sungold', 'f1')])))
        .toBe('F2 — won’t come true (parents F1 hybrids)')
    })
    it('row 9 (some F1) names the F1', () => {
      expect(breeding(jar([parent('p1', 'Carmen', 'f1'), parent('p2', 'Ajvarski', 'open_pollinated')])))
        .toBe('Part F2 (Carmen is an F1 hybrid)')
    })
    it('rows 2 and 10 print NO Breeding fact, whatever the filed variety would say', () => {
      const blend = [parent('p1', 'Fairy Tale mix', null, { variety_rank: 'blend' })]
      const mixed = [parent('p1', 'Nardello', 'landrace'), parent('p2', 'Ajvarski', 'open_pollinated')]
      expect(breeding(jar(blend, { breeding_system: 'open_pollinated' }))).toBeUndefined()
      expect(breeding(jar(mixed, { breeding_system: 'open_pollinated' }))).toBeUndefined()
      expect(breeding(jar(mixed, { breeding_system: 'f1' }))).toBeUndefined()
      expect(seedFacts(jar(mixed, { ...PEPPER })).map((f) => f.key)).not.toContain('breeding')
    })
    it('rows 3-6 keep the filed variety’s own word', () => {
      expect(breeding(jar([parent('p1', 'Ajvarski', 'open_pollinated')], { breeding_system: 'open_pollinated' }))).toBe('Open-pollinated')
      expect(breeding(jar([parent('p1', 'Nardello', 'landrace')], { breeding_system: 'landrace' }))).toBe('Landrace')
    })
  })
})

describe('heatFact', () => {
  it('a pepper with no number says "not recorded"; any other crop says nothing', () => {
    expect(heatFact({ crop_slug: 'pepper' })).toBe('not recorded')
    expect(heatFact({ crop_slug: 'tomato' })).toBe('')
  })

  it('names each source in words; never the lot\'s supplier', () => {
    for (const [src, words] of Object.entries(HEAT_SOURCE_WORDS)) {
      expect(heatFact({ ...PEPPER, scoville_source: src })).toBe(`100,000–350,000 SHU · ${words}`)
    }
    expect(HEAT_SOURCE_WORDS.inference).toBe('best guess')
  })

  it('"source not recorded" only when the row carries the column and it is empty; no column, no words', () => {
    expect(heatFact({ ...PEPPER, scoville_source: null })).toBe('100,000–350,000 SHU · source not recorded')
    const { scoville_source: _drop, ...noColumn } = PEPPER
    expect(heatFact(noColumn)).toBe('100,000–350,000 SHU')
  })

  it('a saved lot is always a guess, whatever the cultivar figure\'s source', () => {
    for (const saved of [{ seed_stage: 'stored' }, { source_plant_id: 'pl-1' }, { source_kind: 'harvest' }]) {
      expect(heatFact({ ...PEPPER, ...saved })).toBe('100,000–350,000 SHU · saved seed may have crossed')
    }
  })

  it('compact numbers for a narrow column, same words — and one mark of a guess, not two', () => {
    expect(heatFact({ ...PEPPER, scoville_min: 1200000, scoville_max: 2000000, scoville_source: 'inference' }, { compact: true }))
      .toBe('1.2M–2M SHU · best guess')
    expect(heatFact({ ...PEPPER, scoville_min: 50000, scoville_max: 50000 }, { compact: true }))
      .toBe('50K SHU · from a seller’s catalogue')
  })

  it('sweet: both ends zero is "Sweet · 0 SHU"; one end zero is a range', () => {
    expect(heatFact({ ...PEPPER, scoville_min: 0, scoville_max: 0, scoville_source: 'inference' })).toBe('Sweet · 0 SHU · best guess')
    expect(heatFact({ ...PEPPER, scoville_min: 0, scoville_max: 500, scoville_source: 'inference' })).toBe('0–500 SHU · best guess')
    expect(heatFact({ crop_slug: 'pepper', scoville_min: null, scoville_max: 5000 })).toBe('5,000 SHU')
  })
})
