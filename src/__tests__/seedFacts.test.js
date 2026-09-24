// V5-SEEDCARDS-001 — the one seed-fact vocabulary behind My seeds' expanded row and the seed's detail
// page. Both pages read seedFacts(); these pins are the words themselves, so a wording change is made
// once, here, and shows on both.
import { describe, it, expect } from 'vitest'
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
