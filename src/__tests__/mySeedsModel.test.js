// V5-SEEDSTAB-001 — what one My seeds row SAYS (src/components/seed/mySeedsModel.js).
//
// The chips are the sow engine's predicates in the engine's order, so the overlaps are the cases that
// matter: a fermenting jar at quantity 0 is NOT used up, an unstarted save at 0 is NOT used up, and an
// archived packet that is ALSO used up keeps both facts. Each is pinned against the engine's own
// answer so the two views cannot drift apart about one jar.
import { describe, it, expect } from 'vitest'
import {
  rowTitle, howMuch, whereFrom, howOld, ageOf, stateChips, lineText, isSowedPreviously,
  sortRows, groupByCrop, NO_CROP,
} from '../components/seed/mySeedsModel.js'

const NOW = new Date('2026-09-18T12:00:00Z')
const bought = (over = {}) => ({
  id: 'b', name: 'Sungold', variety_name: 'Sungold', unit: 'packet', quantity_on_hand: 1, status: 'active',
  source_plant_id: null, source_kind: null, seed_stage: null, ...over,
})
const saved = (over = {}) => ({
  id: 's', name: 'Big Boy — saved 2026', variety_name: 'Big Boy', unit: 'packet', quantity_on_hand: 1,
  status: 'active', source_plant_id: 'pl-1', source_kind: null, seed_stage: 'stored',
  seed_count: null, seed_weight_g: null, ...over,
})
const labels = (i) => stateChips(i, { now: NOW, year: 2026 }).map((c) => c.label)

describe('rowTitle', () => {
  it('is the variety, unless a saved lot carries a name of its own', () => {
    expect(rowTitle(bought())).toBe('Sungold')
    expect(rowTitle(saved())).toBe('Big Boy')                                    // default name
    expect(rowTitle(saved({ name: 'Saved seed 2025' }))).toBe('Big Boy')         // default before a variety
    expect(rowTitle(saved({ name: 'Big Boy — best plant, bed 3' }))).toBe('Big Boy — best plant, bed 3')
    expect(rowTitle(bought({ variety_name: null, name: 'Mystery mix' }))).toBe('Mystery mix')
    // A bought packet's own name never replaces its variety.
    expect(rowTitle(bought({ name: 'Sungold F1 (Johnny’s)' }))).toBe('Sungold')
  })
})

describe('howMuch — seed for a saved lot, containers for a bought packet', () => {
  it.each([
    [bought({ quantity_on_hand: 1 }), '1 packet'],
    [bought({ quantity_on_hand: '3.000' }), '3 packets'],
    [bought({ unit: 'each', quantity_on_hand: 272 }), '272 seeds'],
    [bought({ unit: 'oz', quantity_on_hand: 2 }), '2 oz'],
    [saved({ seed_count: 175, seed_count_estimated: true }), 'approx. 175 seeds'],
    [saved({ seed_count: null, seed_weight_g: 0.5 }), '0.5 g'],
    [saved({ seed_count: null, seed_weight_g: null }), ''],   // uncounted: nothing, never "1 packet"
  ])('%o → %s', (row, text) => {
    expect(howMuch(row)).toBe(text)
  })
})

describe('whereFrom — origin for a saved lot, registry vendor for a bought one', () => {
  const vendorOf = (i) => (i.source_id === 'src-fedco' ? 'Fedco' : '')
  it('names the plant, the kind, or the registry vendor — never the order text', () => {
    expect(whereFrom(saved(), vendorOf)).toBe('Saved from my plant')
    expect(whereFrom(saved({ source_plant_id: null, source_kind: 'farm_stand' }), vendorOf)).toBe('Saved · farm stand')
    expect(whereFrom(saved({ source_plant_id: null, source_kind: 'own_garden' }), vendorOf)).toBe('Saved from my garden')
    expect(whereFrom(bought({ source_id: 'src-fedco', source: 'Order #9' }), vendorOf)).toBe('Fedco')
    expect(whereFrom(bought({ source_id: null, source: 'Order #9' }), vendorOf)).toBe('')
  })
})

describe('howOld / ageOf', () => {
  it('prefers the harvest year, then an in-process lot’s stage year, then the purchase year', () => {
    expect(howOld(saved({ year_harvested: 2024 }))).toBe('harvested 2024')
    expect(howOld(saved({ seed_stage: 'drying', stage_entered_at: '2026-09-10T12:00:00Z' }))).toBe('harvested 2026')
    expect(howOld(bought({ purchase_date: '2025-02-01' }))).toBe('bought 2025')
    expect(howOld(bought())).toBe('')
    expect(ageOf(bought())).toBeNull()
  })
})

describe('stateChips — the engine’s predicates, the engine’s order', () => {
  it('fermenting shows its calendar day; drying is named; stored carries no stage chip', () => {
    expect(labels(saved({ seed_stage: 'fermenting', stage_entered_at: '2026-09-15' }))).toEqual(['Fermenting · day 3'])
    expect(labels(saved({ seed_stage: 'fermenting', stage_entered_at: '2026-09-18T11:00:00Z' }))).toEqual(['Fermenting · today'])
    expect(labels(saved({ seed_stage: 'drying' }))).toEqual(['Drying'])
    expect(labels(saved())).toEqual([])
  })

  it('OVERLAP: a fermenting jar at quantity 0 is in process, never Sowed previously', () => {
    const jar = saved({ seed_stage: 'fermenting', stage_entered_at: '2026-09-17', quantity_on_hand: 0 })
    expect(labels(jar)).toEqual(['Fermenting · day 1'])
    expect(isSowedPreviously(jar)).toBe(false)
  })

  it('OVERLAP: an unstarted save at quantity 0 is "Not started", never Sowed previously', () => {
    const lot = saved({ seed_stage: null, quantity_on_hand: 0, seed_count: null, seed_weight_g: null })
    expect(labels(lot)).toEqual(['Not started'])
    expect(isSowedPreviously(lot)).toBe(false)
  })

  it('OVERLAP: archived AND used up keeps both facts', () => {
    const pkt = bought({ quantity_on_hand: 0, sow_archived_season: 2026 })
    expect(isSowedPreviously(pkt)).toBe(true)
    expect(labels(pkt)).toEqual(['Archived for this season'])
  })

  it('the archive chip is a season: it stops applying on 1 January by itself', () => {
    const pkt = bought({ sow_archived_season: 2026 })
    expect(stateChips(pkt, { now: NOW, year: 2026 }).map((c) => c.key)).toContain('archived')
    expect(stateChips(pkt, { now: NOW, year: 2027 }).map((c) => c.key)).not.toContain('archived')
  })

  it('a non-active status is said in words', () => {
    expect(labels(bought({ status: 'retired' }))).toEqual(['Retired'])
  })

  it('an overdue ferment is a danger chip, a due one a warning', () => {
    const tone = (iso) => stateChips(saved({ seed_stage: 'fermenting', stage_entered_at: iso }), { now: NOW, year: 2026 })[0].tone
    expect(tone('2026-09-13')).toBe('danger')
    expect(tone('2026-09-14')).toBe('warn')
    expect(tone('2026-09-16')).toBe('info')
  })
})

describe('lineText — the second line as the eye reads it (and as uniqueness is computed)', () => {
  it('chips first, then how much · where from · how old', () => {
    const lot = saved({ seed_stage: 'drying', seed_count: 40, stage_entered_at: '2026-09-10T12:00:00Z' })
    expect(lineText(lot, { now: NOW, year: 2026 })).toBe('Drying · 40 seeds · Saved from my plant · harvested 2026')
  })
})

describe('sortRows / groupByCrop', () => {
  const r = (id, over) => bought({ id, ...over })
  it('Name: A→Z with numbers in order', () => {
    const out = sortRows([r('1', { variety_name: 'Tomato 10' }), r('2', { variety_name: 'Tomato 9' }), r('3', { variety_name: 'Basil' })], 'name')
    expect(out.map((x) => x.id)).toEqual(['3', '2', '1'])
  })
  it('Oldest: by the age year, unknown years last', () => {
    const out = sortRows([
      r('new', { purchase_date: '2026-03-01' }), r('none', {}), r('old', { year_harvested: 2019 }),
    ], 'oldest')
    expect(out.map((x) => x.id)).toEqual(['old', 'new', 'none'])
  })
  it('Newest: created_at descending, then id — stable on a same-day intake', () => {
    const out = sortRows([
      r('b', { created_at: '2026-07-02T10:00:00Z' }), r('a', { created_at: '2026-07-02T10:00:00Z' }),
      r('z', { created_at: '2026-09-01T10:00:00Z' }),
    ], 'newest')
    expect(out.map((x) => x.id)).toEqual(['z', 'a', 'b'])
  })
  it('groups by crop label, with rows that name no crop in their own group LAST', () => {
    const groups = groupByCrop([
      r('t', { crop_slug: 'tomato' }), r('n', { crop_slug: null }), r('p', { crop_slug: 'pepper' }), r('t2', { crop_slug: 'tomato' }),
    ], (slug) => ({ tomato: 'Tomato', pepper: 'Pepper' })[slug])
    expect(groups.map((g) => [g.label, g.rows.length])).toEqual([['Pepper', 1], ['Tomato', 2], ['No crop recorded', 1]])
    expect(groups[2].slug).toBe(NO_CROP)
  })
})
