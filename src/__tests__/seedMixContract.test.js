// V5-SEEDMULTIPARENT-001 release 2b — the client's mocks are built from tests/contracts/seed-mix.json, the
// file the server's seam test (tests/integration/seed-mix-seam.int.test.js) verifies against real replies.
// This file is the client half of that seam: it pins the contract VERSION these mocks were written against
// (first, so a raised version fails here before any other assertion can mislead), then holds every mock to
// the contract's own key lists.
import { describe, it, expect } from 'vitest'
import contract from '../../tests/contracts/seed-mix.json'
import {
  blendReply, lotReply, sourcePlantsPutReply, filingReply, measureReply, refusal,
  PARENTS_UNDEFINED, PARENTS_NULL, PARENTS_EMPTY, PARENTS_R1,
} from './fixtures/seedMix.fixture.js'
import { parentSetFacts } from '../components/seed/seedParents.js'

describe('seed-mix contract — the version these mocks were written against', () => {
  it('is version 2', () => {
    expect(contract.version).toBe(2)
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

  it('refusal(code) answers every code in both refusal tables with its status and required keys', () => {
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
