// A saved seed's count, surfaced — the pure half (seedLots.lotCountFact, and candidateFacts' saved arm).
//
// Dave, 2026-09-25: "on a saved seed's detail page, it never surfaces the count. It seems to default to
// showing 1 packet which is not correct ever." The page half is InventoryDetail.savedSeedCount.test.jsx;
// this file pins the words both halves share, so the lot page, the picker line and My seeds say one thing.
//
// Rows are shaped as the routes return them: seed_weight_g is numeric(10,3) and arrives as a STRING,
// quantity_on_hand likewise ('1.000'); seed_count is an integer column and arrives as a number.
import { describe, it, expect } from 'vitest'
import { lotCountFact, NOT_COUNTED, candidateFacts, lotMeasure, isSavedLot } from '../components/seed/seedLots.js'

// Saved three ways — each door that makes a saved lot writes a different one of these facts.
const OFF_A_PLANT = { source_plant_id: 'pl-1', source_kind: null, seed_stage: 'stored' }
const FROM_A_FARM_STAND = { source_plant_id: null, source_kind: 'farm_stand', seed_stage: null }
const STAGED_ONLY = { source_plant_id: null, source_kind: null, seed_stage: 'drying' }
const BOUGHT = { source_plant_id: null, source_kind: null, seed_stage: null }
const UNMEASURED = { seed_count: null, seed_count_estimated: null, seed_weight_g: null }

describe('lotCountFact — the packet card\'s first fact', () => {
  it('a saved lot that was counted reads "Seed count · 175 seeds"', () => {
    const row = { ...OFF_A_PLANT, seed_count: 175, seed_count_estimated: false, seed_weight_g: null }
    expect(lotCountFact(row)).toEqual({ key: 'count', label: 'Seed count', value: '175 seeds' })
  })

  it('an estimated count says so in words — "approx.", never a glyph', () => {
    const row = { ...OFF_A_PLANT, seed_count: 40, seed_count_estimated: true, seed_weight_g: null }
    expect(lotCountFact(row).value).toBe('approx. 40 seeds')
  })

  it('a counted AND weighed lot carries both, count first, the weight through formatSeedWeight', () => {
    const row = { ...OFF_A_PLANT, seed_count: 175, seed_count_estimated: false, seed_weight_g: '3.200' }
    expect(lotCountFact(row)).toEqual({ key: 'count', label: 'Seed count', value: '175 seeds · 3.2 g' })
  })

  it('a lot only WEIGHED is labelled "Seed weight" — a gram figure never sits under "Seed count"', () => {
    const row = { ...FROM_A_FARM_STAND, seed_count: null, seed_count_estimated: null, seed_weight_g: '0.050' }
    expect(lotCountFact(row)).toEqual({ key: 'count', label: 'Seed weight', value: '50 mg' })
  })

  it('a measured zero is a fact, not an absence', () => {
    const row = { ...OFF_A_PLANT, seed_count: 0, seed_count_estimated: false, seed_weight_g: null }
    expect(lotCountFact(row).value).toBe('0 seeds')
  })

  it.each([
    ['off one of my plants', OFF_A_PLANT],
    ['from a farm stand', FROM_A_FARM_STAND],
    ['in a stage only', STAGED_ONLY],
  ])('a saved lot (%s) that nobody measured STATES the absence', (_label, origin) => {
    const row = { ...origin, ...UNMEASURED }
    expect(isSavedLot(row)).toBe(true)
    expect(lotCountFact(row)).toEqual({ key: 'count', label: 'Seed count', value: NOT_COUNTED })
    expect(NOT_COUNTED).toBe('Not counted yet')
  })

  it('a bought packet with a count shows it; with nothing measured it says nothing', () => {
    expect(lotCountFact({ ...BOUGHT, seed_count: 185, seed_count_estimated: true, seed_weight_g: null }))
      .toEqual({ key: 'count', label: 'Seed count', value: 'approx. 185 seeds' })
    expect(lotCountFact({ ...BOUGHT, ...UNMEASURED })).toBeNull()
  })

  it('the caller\'s `saved` answer wins over the row — the page passes its LIVE provenance', () => {
    // A bought row whose origin was JUST picked on the page (the row still says nothing), and the
    // mirror: a row that reads saved, told otherwise.
    expect(lotCountFact({ ...BOUGHT, ...UNMEASURED }, true)).toEqual({ key: 'count', label: 'Seed count', value: NOT_COUNTED })
    expect(lotCountFact({ ...OFF_A_PLANT, ...UNMEASURED }, false)).toBeNull()
    // A measure is shown either way: `saved` only decides the stated absence.
    expect(lotCountFact({ ...BOUGHT, seed_count: 12, seed_count_estimated: false }, false).value).toBe('12 seeds')
  })

  it('never names the container — the card reads the SEED, whatever quantity_on_hand holds', () => {
    const row = { ...OFF_A_PLANT, quantity_on_hand: '1.000', unit: 'packet', seed_count: 175, seed_count_estimated: false }
    expect(lotCountFact(row).value).not.toMatch(/packet/)
    expect(lotCountFact({ ...OFF_A_PLANT, ...UNMEASURED, quantity_on_hand: '1.000', unit: 'packet' }).value).not.toMatch(/packet|1/)
    // The same words lotMeasure gives Saved seeds' cards and My seeds' line 2.
    expect(lotCountFact(row).value).toBe(lotMeasure(row))
  })
})

describe('candidateFacts — the picker line leaves a SAVED lot\'s container count out', () => {
  it('a saved lot reads "175 seeds", never "175 seeds · 1 packet"', () => {
    const row = { ...OFF_A_PLANT, seed_stage: null, quantity_on_hand: '1.000', unit: 'packet', seed_count: 175, seed_count_estimated: false }
    expect(candidateFacts(row)).toBe('175 seeds')
  })

  it('each kind of saved lot drops it — an uncounted one then has no amount at all', () => {
    for (const origin of [OFF_A_PLANT, FROM_A_FARM_STAND, STAGED_ONLY]) {
      const row = { ...origin, ...UNMEASURED, quantity_on_hand: '1.000', unit: 'packet', purchase_date: '2026-01-14' }
      expect(candidateFacts(row, () => '')).toBe('Jan 14, 2026')
    }
  })

  it('the one saved lot holding another amount (272 each) reads by its seed count too, lotMeasure\'s rule', () => {
    // Prod's "Green Flesh Honeydew seed seed 2026": quantity_on_hand 272 'each' AND seed_count 247.
    // The picker line is the seed; the 272 stays editable on the lot page's Qty on hand field.
    const row = { ...OFF_A_PLANT, quantity_on_hand: '272.000', unit: 'each', seed_count: 247, seed_count_estimated: false }
    expect(candidateFacts(row)).toBe('247 seeds')
  })

  it('a BOUGHT packet is unchanged: seeds, weight, then its container amount', () => {
    const row = { ...BOUGHT, quantity_on_hand: '1.000', unit: 'packet', seed_count: 185, seed_count_estimated: false, seed_weight_g: '0.500' }
    expect(candidateFacts(row)).toBe('185 seeds · 0.5 g · 1 packet')
    expect(candidateFacts({ ...BOUGHT, ...UNMEASURED, quantity_on_hand: 2, unit: 'packet' })).toBe('2 packet')
    expect(candidateFacts({ ...BOUGHT, ...UNMEASURED, quantity_on_hand: 3, unit: null })).toBe('3')
  })
})
