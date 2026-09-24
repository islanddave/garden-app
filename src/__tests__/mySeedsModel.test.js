// V5-SEEDSTAB-001 — what one My seeds row SAYS (src/components/seed/mySeedsModel.js).
//
// The chips are the sow engine's predicates in the engine's order, so the overlaps are the cases that
// matter: a fermenting jar at quantity 0 is NOT used up, an unstarted save at 0 is NOT used up, and an
// archived packet that is ALSO used up keeps both facts. Each is pinned against the engine's own
// answer so the two views cannot drift apart about one jar.
import { describe, it, expect } from 'vitest'
import {
  rowTitle, howMuch, whereFrom, howOld, ageOf, stateChips, lineLayout, lineText, isSowedPreviously,
  sortRows, groupByCrop, NO_CROP, heatOf, heatLabel, SORTS, supplierOptions, matchesSuppliers,
  isFilterActive, groupIsOpen, originNote, NO_SUPPLIER_VALUE,
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
    // EXACTLY "1 packet" is not printed (V5-SEEDCARDS-001): 304 of 327 rows said the same thing.
    [bought({ quantity_on_hand: 1 }), ''],
    [bought({ quantity_on_hand: '1.000' }), ''],
    [bought({ unit: 'each', quantity_on_hand: 1 }), '1 seed'],
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
    // "Ferment", the ferment line's own word (V5-SEEDCARDS-001).
    expect(labels(saved({ seed_stage: 'fermenting', stage_entered_at: '2026-09-15' }))).toEqual(['Ferment · day 3'])
    expect(labels(saved({ seed_stage: 'fermenting', stage_entered_at: '2026-09-18T11:00:00Z' }))).toEqual(['Ferment · today'])
    expect(labels(saved({ seed_stage: 'drying' }))).toEqual(['Drying'])
    expect(labels(saved())).toEqual([])
  })

  it('OVERLAP: a fermenting jar at quantity 0 is in process, never Sowed previously', () => {
    const jar = saved({ seed_stage: 'fermenting', stage_entered_at: '2026-09-17', quantity_on_hand: 0 })
    expect(labels(jar)).toEqual(['Ferment · day 1'])
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

  // V5-SEEDSTAB-001 slice 3 — the one chip that is not an engine state. LAST (the live state keeps the
  // first place, §16) and NEUTRAL (a fact, not an alarm; MySeeds treats only a non-neutral FIRST chip as
  // the live one, and gate:seeds-page (n) reads data-tone the same way). Where it sits is lineLayout's call.
  it('a lot saved off an F1 plant carries "F2 — won’t come true", last and neutral; a bought F1 packet never does', () => {
    const f2 = (over) => stateChips(saved({ breeding_system: 'f1', ...over }), { now: NOW, year: 2026 })
    expect(f2({}).map((c) => [c.key, c.label, c.tone])).toEqual([['f2', 'F2 — won’t come true', 'neutral']])
    expect(labels(saved({ breeding_system: 'f1', seed_stage: 'drying' }))).toEqual(['Drying', 'F2 — won’t come true'])
    expect(f2({ seed_stage: 'drying' })[0].tone).toBe('info')
    expect(labels(saved({ breeding_system: 'f1', seed_stage: 'fermenting', stage_entered_at: '2026-09-17', sow_archived_season: 2026 })))
      .toEqual(['Ferment · day 1', 'Archived for this season', 'F2 — won’t come true'])
    expect(labels(bought({ breeding_system: 'f1' }))).toEqual([])
    expect(labels(saved({ breeding_system: 'open_pollinated' }))).toEqual([])
    expect(labels(saved({ breeding_system: null }))).toEqual([])
  })
})

describe('lineText — the second line as the eye reads it (and as uniqueness is computed)', () => {
  it('chips first, then how much · where from · how old', () => {
    const lot = saved({ seed_stage: 'drying', seed_count: 40, stage_entered_at: '2026-09-10T12:00:00Z' })
    expect(lineText(lot, { now: NOW, year: 2026 })).toBe('Drying · 40 seeds · Saved from my plant · harvested 2026')
  })
  it('a bought packet leads with the supplier chip\'s SHORT label, then amount, heat and tail — the full vendor name is not repeated', () => {
    const vendorOf = () => 'Botanical Interests'
    const pkt = bought({ quantity_on_hand: 2, purchase_date: '2025-01-01', scoville_min: 2500, scoville_max: 8000 })
    expect(lineText(pkt, { vendorOf, now: NOW, year: 2026 })).toBe('Botanical · 2 packets · 2.5K–8K SHU · bought 2025')
    expect(lineText(pkt, { vendorOf, now: NOW, year: 2026 })).not.toContain('Interests')
  })
  it('an F2 lot\'s chip is part of the line uniqueness is computed over — after the state, before the amount', () => {
    const lot = saved({ seed_stage: 'drying', seed_count: 40, breeding_system: 'f1', stage_entered_at: '2026-09-10T12:00:00Z' })
    expect(lineText(lot, { now: NOW, year: 2026 })).toBe('Drying · F2 — won’t come true · 40 seeds · Saved from my plant · harvested 2026')
  })
  it('on an F2 row the line reads as its wrapping line renders: F2 and the amount lead, any other chip rides after them', () => {
    const lot = saved({ breeding_system: 'f1', seed_count: 175, seed_count_estimated: true, sow_archived_season: 2026 })
    expect(lineText(lot, { now: NOW, year: 2026 }))
      .toBe('F2 — won’t come true · approx. 175 seeds · Archived for this season · Saved from my plant')
    // …and a bought F1 packet's line is exactly what it was: chips, then the amount.
    const pkt = bought({ breeding_system: 'f1', quantity_on_hand: 2, sow_archived_season: 2026 })
    expect(lineText(pkt, { now: NOW, year: 2026 })).toBe('Archived for this season · 2 packets')
  })
  it('originNote names a saved lot\'s origin and never a bought packet\'s vendor', () => {
    expect(originNote(saved())).toBe('Saved from my plant')
    expect(originNote(bought({ source_id: 'src-fedco' }))).toBe('')
  })
})

// BUG-MYSEEDSF2HIDESSHU-001 (Dave, 2026-09-24 — "I want the shu shown"): the heat is never dropped, on any
// row. Every row's line 2 WRAPS instead, so lineLayout no longer picks a shape per row (the `amountOnLine`
// of the slice 3 amendment, then an F2-only `wraps`); what it still decides is which chips are whole items
// of the line — the live state, an F2 lot's chip — and which give way.
describe('lineLayout — which chips are whole items of line 2 and which give way', () => {
  const at = { now: NOW, year: 2026 }
  it('decides chips only: no per-row layout mode is left, because every row\'s line wraps', () => {
    for (const row of [saved({ breeding_system: 'f1', seed_count: 175 }), bought({ sow_archived_season: 2026 }), saved()]) {
      expect(Object.keys(lineLayout(row, at)).sort()).toEqual(['f2', 'giveWayChips', 'live'])
    }
  })

  it('an F2 row: its F2 chip is a whole item of the line, never one of the chips that give way', () => {
    const lay = lineLayout(saved({ breeding_system: 'f1', seed_count: 175, seed_count_estimated: true }), at)
    expect(lay.f2).toEqual({ key: 'f2', label: 'F2 — won’t come true', tone: 'neutral' })
    expect(lay.live).toBeNull()
    expect(lay.giveWayChips).toEqual([])
  })

  it('an F2 row in process: the live state keeps the first place; any other chip still gives way', () => {
    const lay = lineLayout(saved({
      breeding_system: 'f1', seed_stage: 'fermenting', stage_entered_at: '2026-09-17', sow_archived_season: 2026,
    }), at)
    expect(lay.live.key).toBe('fermenting')
    expect(lay.f2.key).toBe('f2')
    expect(lay.giveWayChips.map((c) => c.key)).toEqual(['archived'])
  })

  it('bought packets (F1 or not) and every non-F2 row: the live state on the line, every other chip gives way', () => {
    for (const row of [
      bought({ breeding_system: 'f1', sow_archived_season: 2026 }),
      bought({ status: 'retired' }),
      saved({ breeding_system: 'open_pollinated', seed_stage: 'drying' }),
      saved({ seed_stage: null, quantity_on_hand: 0 }),
      saved(),
    ]) {
      const lay = lineLayout(row, at)
      expect(lay.f2).toBeNull()
      // The chips in the engine's order, the first one on the line only when it is a live state.
      expect([lay.live, ...lay.giveWayChips].filter(Boolean)).toEqual(stateChips(row, at))
      if (lay.live) expect(lay.live.tone).not.toBe('neutral')
    }
  })
})

describe('heat (V5-SEEDCARDS-001)', () => {
  it('heatOf keys a range by its top, falls back to one end, and is null with no figure', () => {
    expect(heatOf(bought({ scoville_min: 100000, scoville_max: 350000 }))).toEqual({ min: 100000, max: 350000, key: 350000 })
    expect(heatOf(bought({ scoville_min: 5000, scoville_max: null }))).toEqual({ min: 5000, max: 5000, key: 5000 })
    expect(heatOf(bought({ scoville_min: 0, scoville_max: 0 }))?.key).toBe(0)
    expect(heatOf(bought())).toBeNull()
    // A best guess sorts by the same key as a stated figure; it is marked where it is shown (heatLabel).
    expect(heatOf(bought({ scoville_min: 1, scoville_max: 2, scoville_source: 'inference' }))).toEqual({ min: 1, max: 2, key: 2 })
  })
  it('heatLabel reuses the one SHU formatter (varietySpec.shuLabel)', () => {
    expect(heatLabel(bought({ scoville_min: 100000, scoville_max: 350000 }))).toBe('100K–350K SHU')
    // …which marks a best guess with the word, as the row, the card and the detail page all read it.
    expect(heatLabel(bought({ scoville_min: 100000, scoville_max: 350000, scoville_source: 'inference' }))).toBe('est. 100K–350K SHU')
    expect(heatLabel(bought({ scoville_min: 0, scoville_max: 0 }))).toBe('Sweet · 0 SHU')
    expect(heatLabel(bought())).toBe('')
  })
  it('Hottest: top of range descending, then bottom descending, then A→Z; no figure last', () => {
    const r = (id, mn, mx) => bought({ id, variety_name: id, scoville_min: mn, scoville_max: mx })
    const out = sortRows([r('mild', 0, 500), r('none', null, null), r('hab', 100000, 350000), r('tie-b', 30000, 50000), r('tie-a', 10000, 50000), r('aaa', null, null)], 'heat')
    expect(out.map((x) => x.id)).toEqual(['hab', 'tie-b', 'tie-a', 'mild', 'aaa', 'none'])
    expect(SORTS.map((x) => x.value)).toEqual(['name', 'oldest', 'newest', 'heat'])
  })
})

describe('supplier facet (V5-SEEDCARDS-001)', () => {
  const NAMES = { a: 'Botanical Interests', b: 'Bentley Seeds', c: 'Fedco Seeds' }
  const vendorOf = (i) => NAMES[i.source_id] ?? ''
  const rows = [
    bought({ id: '1', source_id: 'b' }), bought({ id: '2', source_id: 'a' }), bought({ id: '3', source_id: 'a' }),
    bought({ id: '4', source_id: 'c' }), saved({ id: '5' }),
  ]
  it('options are every supplier present, count-descending, keyed by the folded name, "No supplier" last', () => {
    const opts = supplierOptions(rows, vendorOf)
    expect(opts.map((o) => [o.value, o.label, o.count])).toEqual([
      ['botanicalinterests', 'Botanical', 2], ['bentleyseeds', 'Bentley', 1], ['fedcoseeds', 'Fedco', 1], [NO_SUPPLIER_VALUE, 'No supplier', 1],
    ])
  })
  it('matchesSuppliers ORs within the set and treats an empty set as no filter', () => {
    const sel = new Set(['bentleyseeds', NO_SUPPLIER_VALUE])
    expect(rows.filter((i) => matchesSuppliers(i, sel, vendorOf)).map((i) => i.id)).toEqual(['1', '5'])
    expect(rows.every((i) => matchesSuppliers(i, new Set(), vendorOf))).toBe(true)
  })
  it('isFilterActive sees search, crop chips AND supplier chips — one filter object', () => {
    expect(isFilterActive({ q: '', crops: new Set(), suppliers: new Set() })).toBe(false)
    expect(isFilterActive({ q: '  ', crops: new Set(), suppliers: new Set() })).toBe(false)
    expect(isFilterActive({ q: 'x', crops: new Set(), suppliers: new Set() })).toBe(true)
    expect(isFilterActive({ q: '', crops: new Set(['pepper']), suppliers: new Set() })).toBe(true)
    expect(isFilterActive({ q: '', crops: new Set(), suppliers: new Set(['a']) })).toBe(true)
  })
})

describe('groupIsOpen — folded by default, opened by the user or a rule (V5-SEEDCARDS-001)', () => {
  const none = new Set()
  it.each([
    ['default: closed', 'tomato', { openGroups: none, closedByUser: none, filterActive: false, sort: 'name' }, false],
    ['opened by the user', 'tomato', { openGroups: new Set(['tomato']), closedByUser: none, filterActive: false, sort: 'name' }, true],
    ['any active filter opens it', 'tomato', { openGroups: none, closedByUser: none, filterActive: true, sort: 'name' }, true],
    ['Hottest opens Pepper', 'pepper', { openGroups: none, closedByUser: none, filterActive: false, sort: 'heat' }, true],
    ['Hottest leaves the rest folded', 'tomato', { openGroups: none, closedByUser: none, filterActive: false, sort: 'heat' }, false],
    ['a user close beats a rule', 'tomato', { openGroups: none, closedByUser: new Set(['tomato']), filterActive: true, sort: 'name' }, false],
  ])('%s', (_label, slug, state, open) => {
    expect(groupIsOpen(slug, state)).toBe(open)
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
  it('the crop chips\' PINNED crops lead in pin order, then A→Z; Hottest\'s lead crop goes first', () => {
    const label = (slug) => ({ tomato: 'Tomato', pepper: 'Pepper', bean: 'Bean', arugula: 'Arugula' })[slug]
    const rows = [r('a', { crop_slug: 'arugula' }), r('b', { crop_slug: 'bean' }), r('p', { crop_slug: 'pepper' }), r('t', { crop_slug: 'tomato' }), r('n', { crop_slug: null })]
    expect(groupByCrop(rows, label, { pinned: ['pepper', 'tomato'] }).map((g) => g.slug)).toEqual(['pepper', 'tomato', 'arugula', 'bean', NO_CROP])
    expect(groupByCrop(rows, label, { pinned: ['tomato', 'bean'], leadSlug: 'pepper' }).map((g) => g.slug)).toEqual(['pepper', 'tomato', 'bean', 'arugula', NO_CROP])
  })
})
