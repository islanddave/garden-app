// V5-SEEDMULTIPARENT-001 release 2b — the client's mocks are built from tests/contracts/seed-mix.json, the
// file the server's seam test (tests/integration/seed-mix-seam.int.test.js) verifies against real replies.
// This file is the client half of that seam: it pins the contract VERSION these mocks were written against
// (first, so a raised version fails here before any other assertion can mislead), then holds every mock to
// the contract's own key lists.
import { describe, it, expect } from 'vitest'
import contract from '../../tests/contracts/seed-mix.json'
import {
  blendReply, lotReply, sourcePlantsPutReply, filingReply, measureReply, refusal,
  additionReply, additionReplayReply, openLotsReply, openLotRow, plantSeedLotsReply, plantSeedLot,
  measureChangedRefusal, filingCases,
  PARENTS_UNDEFINED, PARENTS_NULL, PARENTS_EMPTY, PARENTS_R1,
} from './fixtures/seedMix.fixture.js'
import { parentSetFacts } from '../components/seed/seedParents.js'

describe('seed-mix contract — the version these mocks were written against', () => {
  it('is version 3', () => {
    expect(contract.version).toBe(3)
  })
})

const hasAll = (obj, keys) => keys.forEach((k) => expect(obj, `missing key ${k}`).toHaveProperty(k))

describe('seedMix.fixture — every mock carries the keys the contract promises', () => {
  it('blendReply', () => {
    const r = blendReply()
    hasAll(r, contract.varieties_blend.required)
    r.components.forEach((c) => hasAll(c, contract.varieties_blend.component_required))
    expect(r.variety_rank).toBe(contract.varieties_blend.variety_rank)
  })

  it('lotReply, and each parent element is exactly the nine contract keys', () => {
    const r = lotReply()
    hasAll(r, contract.seed_lot.required)
    expect(r.source_plants.length).toBeGreaterThanOrEqual(2)
    for (const p of r.source_plants) {
      expect(Object.keys(p).sort()).toEqual([...contract.seed_lot.source_plant_required].sort())
    }
    // The example jar is a mix: three plantings of two cultivars.
    const facts = parentSetFacts(r.source_plants)
    expect([facts.plantings.length, facts.k, facts.mixed]).toEqual([3, 2, true])
  })

  it('sourcePlantsPutReply carries filing only when asked', () => {
    const plain = sourcePlantsPutReply()
    hasAll(plain, contract.source_plants_put.required)
    expect(plain).not.toHaveProperty('filing')
    const filed = sourcePlantsPutReply({ filing: true })
    hasAll(filed, [...contract.source_plants_put.required, ...contract.source_plants_put.required_when_filing_sent])
    hasAll(filed.filing, contract.source_plants_put.filing_required)
    hasAll(filed.filing.previous, contract.source_plants_put.previous_required)
    expect(sourcePlantsPutReply({ filing: { name: 'Porch jar' } }).filing).toMatchObject({ name: 'Porch jar', changed: true })
  })

  it('filingReply and measureReply', () => {
    const f = filingReply()
    hasAll(f, contract.filing_put.required)
    hasAll(f.previous, contract.filing_put.previous_required)
    hasAll(measureReply(), contract.seed_measure_put.required)
    expect(measureReply({ seed_parent_plant_count: null }).seed_parent_plant_count).toBeNull()
  })

  it('refusal(code) answers every code in the two older refusal tables with its status and required keys', () => {
    for (const [code, spec] of Object.entries(contract.refusals)) {
      const r = refusal(code)
      expect(r.status, code).toBe(spec.status)
      expect(r.body.code).toBe(code)
      hasAll(r.body, spec.required)
      if (spec.error) expect(r.body.error).toBe(spec.error)
    }
    for (const [code, status] of Object.entries(contract.varieties_blend.refusals)) {
      expect(refusal(code)).toEqual({ status, body: { error: expect.any(String), code } })
    }
    expect(() => refusal('not_a_code')).toThrow(/no refusal/)
  })

  it('a reply is a fresh copy: changing one does not change the next', () => {
    const a = lotReply()
    a.source_plants.pop()
    a.name = 'changed'
    expect(lotReply().source_plants).toHaveLength(3)
    expect(lotReply().name).not.toBe('changed')
  })

  it('the three no-parent cases and the release-1 default', () => {
    expect(PARENTS_UNDEFINED).toBeUndefined()
    expect(PARENTS_NULL).toBeNull()
    expect(PARENTS_EMPTY).toEqual([])
    const lot = { source_plant_id: 'pl-1', variety_id: 'v-1', variety_name: 'Carmen', breeding_system: 'f1', variety_rank: 'cultivar', crop_slug: 'pepper' }
    const [only, ...rest] = PARENTS_R1(lot)
    expect(rest).toEqual([])
    expect(Object.keys(only).sort()).toEqual([...contract.seed_lot.source_plant_required].sort())
    expect(only).toMatchObject({ id: 'pl-1', variety_id: 'v-1', variety_name: 'Carmen', breeding_system: 'f1' })
    expect(PARENTS_R1({ source_plant_id: null })).toEqual([])
  })
})

// ── Release 3 (V5-SEEDLOTADDITION-001) — the add-to-a-lot mocks, held to the same contract ──────────
describe('seedMix.fixture — the release 3 mocks carry the keys the contract promises', () => {
  const adds = contract.seed_additions_post
  const exactly = (obj, keys, what) => expect(Object.keys(obj).sort(), what).toEqual([...keys].sort())

  it('additionReply: the lot keys and `addition`, and `filing` only when asked', () => {
    const plain = additionReply()
    exactly(plain, adds.required, 'additionReply()')
    exactly(plain.addition, adds.addition_required, 'addition')
    expect(plain.addition.replayed).toBe(false)
    for (const p of plain.source_plants) exactly(p, contract.seed_lot.source_plant_required, 'a source_plants element')
    // The driver hands numerics back as strings; the count is a number and the basis a boolean.
    expect([typeof plain.seed_count, typeof plain.seed_count_estimated, typeof plain.seed_weight_g, typeof plain.quantity_on_hand])
      .toEqual(['number', 'boolean', 'string', 'string'])
    const filed = additionReply({ filing: true })
    exactly(filed, [...adds.required, ...adds.required_when_filing_sent], 'additionReply({ filing: true })')
    hasAll(filed.filing, contract.source_plants_put.filing_required)
    hasAll(filed.filing.previous, contract.source_plants_put.previous_required)
    expect(additionReply({ filing: { name: 'Porch lot' } }).filing).toMatchObject({ name: 'Porch lot', changed: true })
    // `addition` is spread over the example's, never replaced by a partial.
    const same = additionReply({ name: 'Back fence lot', addition: { plant_was_added: false } })
    expect(same.name).toBe('Back fence lot')
    exactly(same.addition, adds.addition_required, 'a partial addition override')
    expect(same.addition).toMatchObject({ plant_was_added: false, replayed: false })
  })

  it('additionReplayReply: replayed true, the same addition, and never `filing`', () => {
    const replay = additionReplayReply()
    exactly(replay, adds.required, 'additionReplayReply()')
    expect(replay).not.toHaveProperty('filing')
    expect(replay.addition.replayed).toBe(true)
    // The recorded pair is one request sent twice: the same picking, the same lot.
    expect(replay.addition).toEqual({ ...additionReply().addition, replayed: true })
    expect(replay.id).toBe(additionReply().id)
    expect(additionReplayReply({ addition: { count_applied: false } }).addition).toMatchObject({ replayed: true, count_applied: false })
  })

  it('openLotsReply and openLotRow: the envelope, and each row exactly the row keys', () => {
    const open = openLotsReply()
    exactly(open, contract.seed_lots_open_get.required, 'openLotsReply()')
    expect(open.open_lots.length).toBeGreaterThanOrEqual(1)
    for (const row of open.open_lots) {
      exactly(row, contract.seed_lots_open_get.row_required, 'an open_lots row')
      expect([typeof row.is_member, typeof row.same_variety]).toEqual(['boolean', 'boolean'])
      for (const p of row.source_plants) exactly(p, contract.seed_lot.source_plant_required, 'a row\'s source_plants element')
    }
    const row = openLotRow({ is_member: true, name: 'Mine' })
    exactly(row, contract.seed_lots_open_get.row_required, 'openLotRow(over)')
    expect(row).toMatchObject({ is_member: true, name: 'Mine' })
    expect(openLotsReply({ open_lots: [] }).open_lots).toEqual([])
  })

  it('plantSeedLotsReply and plantSeedLot: the envelope, each lot\'s keys, and the other parent\'s', () => {
    const spec = contract.plants_seed_lots_get
    const reply = plantSeedLotsReply()
    exactly(reply, spec.envelope_required, 'plantSeedLotsReply()')
    for (const lot of reply.seed_lots) {
      exactly(lot, spec.required, 'a seed_lots row')
      for (const p of lot.other_parents) exactly(p, spec.other_parent_required, 'an other_parents element')
    }
    // The example lot has one other parent, so `plant + other_parents[].id` is a set of two.
    expect(plantSeedLot().other_parents).toHaveLength(1)
    expect(plantSeedLot({ other_parents: [] }).other_parents).toEqual([])
  })

  it('refusal(code) answers every code of the additions route\'s own table, with its status, keys and exact sentence', () => {
    expect(Object.keys(adds.refusals).sort()).toEqual([
      'addition_key_conflict', 'amount_too_large', 'lot_used_up', 'own_source_lot', 'too_many_parents', 'variety_mismatch_no_parents',
    ])
    for (const [code, spec] of Object.entries(adds.refusals)) {
      expect(refusal(code)).toEqual({ status: spec.status, body: { error: spec.error, code } })
      expect(spec.routes).toEqual([adds.route])
      // No code is in two tables: which one answers is never a question.
      expect(contract.refusals).not.toHaveProperty(code)
      expect(contract.varieties_blend.refusals).not.toHaveProperty(code)
    }
    // The refusals the route shares with the set route and the filing route name it too.
    for (const code of ['parent_without_variety', 'mixed_crop_parents', 'blend_required', 'variety_unusable', 'filing_crop_mismatch', 'parents_changed', 'lot_changed']) {
      expect(contract.refusals[code].routes, code).toContain(adds.route)
    }
    expect(contract.refusals.multi_parent_lot.routes).not.toContain(adds.route)
  })

  it('measureChangedRefusal: 409 lot_changed with the four measure keys, all of them keys the contract lists for that refusal', () => {
    expect(contract.seed_measure_put.statuses).toEqual([200, 409])
    expect(contract.refusals.lot_changed.routes).toContain(contract.seed_measure_put.route)
    const r = measureChangedRefusal()
    expect(r.status).toBe(409)
    exactly(r.body, ['error', 'code', 'seed_count', 'seed_count_estimated', 'seed_weight_g', 'seed_parent_plant_count'], 'the 409 body')
    expect(r.body).toMatchObject({ code: 'lot_changed', error: contract.refusals.lot_changed.error })
    for (const key of Object.keys(r.body)) {
      expect([...contract.refusals.lot_changed.required, ...contract.refusals.lot_changed.optional], key).toContain(key)
    }
    expect(measureChangedRefusal({ seed_count: 7 }).body.seed_count).toBe(7)
    // The three keys a measure PUT may carry to be compared.
    for (const key of ['expected_seed_count', 'expected_seed_count_estimated', 'expected_seed_weight_g']) {
      expect(contract.seed_measure_put.request_optional).toContain(key)
    }
  })

  it('the additions request: four required keys, four optional, and never a name, a type or a category', () => {
    expect(adds.request_required).toEqual(['addition_key', 'plant_id', 'expected_source_plant_ids', 'picked_on'])
    expect(adds.request_optional).toEqual(['add_seed_count', 'add_estimated', 'add_seed_weight_g', 'filing'])
    expect(adds.request_never).toEqual(['name', 'type', 'category'])
    for (const key of adds.request_never) {
      expect([...adds.request_required, ...adds.request_optional]).not.toContain(key)
    }
  })

  it('filingCases: every case states both answers, and the two definitions agree with themselves', () => {
    const cases = filingCases()
    expect(cases.length).toBeGreaterThanOrEqual(6)
    const leavesOf = (v) => (v == null ? [] : v.startsWith('mix(') ? v.slice(4, -1).split(',') : [v])
    for (const c of cases) {
      exactly(c, ['name', 'lot_variety', 'parent_varieties', 'plant_variety', 'same_variety', 'refile', 'refile_to'], c.name)
      // same_variety, restated: the lot's variety is the plant's, or a parent has the plant's.
      expect(c.lot_variety === c.plant_variety || c.parent_varieties.includes(c.plant_variety), c.name).toBe(c.same_variety)
      // refile, restated: the set's distinct varieties are not what the lot is filed under.
      const set = [...new Set([...c.parent_varieties.filter((v) => v != null).flatMap(leavesOf), ...leavesOf(c.plant_variety)])].sort()
      const filedAs = leavesOf(c.lot_variety).sort()
      const mustRefile = set.length >= 2 && set.join(',') !== filedAs.join(',')
      expect(mustRefile, c.name).toBe(c.refile)
      expect(c.refile_to, c.name).toBe(c.refile ? `mix(${set.join(',')})` : null)
    }
    // Both branches of each answer are present, and the one case where they part ways is named.
    expect(cases.some((c) => c.same_variety && !c.refile)).toBe(true)
    expect(cases.some((c) => !c.same_variety && c.refile)).toBe(true)
    expect(cases.filter((c) => !c.same_variety && !c.refile)).toHaveLength(1)
    // A fresh copy each time.
    cases[0].name = 'changed'
    expect(filingCases()[0].name).not.toBe('changed')
  })
})
