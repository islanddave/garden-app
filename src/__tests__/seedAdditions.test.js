// V5-SEEDLOTADDITION-001 (seed release 3) — the pure tables behind "Put it in a seed lot I already
// started" (contract T18): which of a plant's own lots is open, the request body, the timeline entry,
// the line that says what the lot will say, and the sentence for every answer. The sheet's own cases
// are in SaveSeedSheet.addToLot.test.jsx; nothing here renders.
//
// Both flags are held on by ONE static mock, so this file reads the same in every rehearsal.
// Every lot and reply is built from the contract's recorded examples (seedMix.fixture.js).
import { describe, it, expect, vi } from 'vitest'

vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()), SEED_MULTI_PARENT: true, SEED_ADD_TO_LOT: true,
}))

import contract from '../../tests/contracts/seed-mix.json'
import { additionReply, openLotRow, plantSeedLot } from './fixtures/seedMix.fixture.js'
import {
  addToLotAvailable, isOpenLot, lotFactsLine, lotRowLine, parseAddCount, parseAddWeight,
  buildAdditionBody, additionSaved, additionNote, additionEventBody, outcomeLine, refileSentence,
  sentenceForRefusal, isChangedRefusal, addedToast, lotsLoadingLine, lotsNoneLine, otherLotsDivider,
  cropWords, ADD_CHANGED, ADD_USED_UP, ADD_REFUSED, STORED_LOT_LINE,
} from '../components/seed/seedAdditions.js'

const KEY = '11111111-1111-4111-8111-111111111111'
const PLANT = '00000000-0000-4000-8000-000000000102'
const OTHER = '00000000-0000-4000-8000-000000000103'

describe('addToLotAvailable', () => {
  it('answers on while both flags are on', () => {
    expect(addToLotAvailable()).toBe(true)
  })
})

describe('isOpenLot — one of the plant\'s own lots can still take seed', () => {
  const now = new Date('2026-10-08T15:00:00Z')
  const lot = (over) => plantSeedLot({ seed_stage: 'stored', quantity_on_hand: '1.000', created_at: '2026-08-01T12:00:00Z', ...over })
  it.each([
    ['stored, made this year', {}, true],
    ['drying, made last year', { seed_stage: 'drying', created_at: '2025-09-01T12:00:00Z' }, true],
    ['no stage, made this year', { seed_stage: null }, true],
    ['stored, made last year', { created_at: '2025-09-01T12:00:00Z' }, false],
    ['no stage, made last year', { seed_stage: null, created_at: '2025-09-01T12:00:00Z' }, false],
    ['fermenting, made this year', { seed_stage: 'fermenting' }, false],
    ['used up (0 on hand)', { quantity_on_hand: '0.000' }, false],
    ['used up, still drying', { seed_stage: 'drying', quantity_on_hand: 0 }, false],
    ['nothing recorded on hand', { quantity_on_hand: null }, false],
    // The New York calendar, not UTC: 05:30Z on 1 January is 00:30 in New York, 04:30Z is still 31 December.
    ['stored, made 2026-01-01 05:30Z', { created_at: '2026-01-01T05:30:00Z' }, true],
    ['stored, made 2026-01-01 04:30Z', { created_at: '2026-01-01T04:30:00Z' }, false],
    ['stored, no made date', { created_at: null }, false],
  ])('%s', (_name, over, open) => {
    expect(isOpenLot(lot(over), now)).toBe(open)
  })
  it('is false for no lot at all', () => {
    expect(isOpenLot(null, now)).toBe(false)
  })
})

describe('the lines a lot is listed by', () => {
  it('the facts line leaves out what the lot does not have', () => {
    expect(lotFactsLine({ seed_stage: 'drying', seed_count: 120, seed_count_estimated: true })).toBe('Drying · approx. 120 seeds')
    expect(lotFactsLine({ seed_stage: 'stored', seed_count: 40, seed_count_estimated: false })).toBe('Stored · 40 seeds')
    expect(lotFactsLine({ seed_stage: null, seed_count: null, seed_weight_g: '2.500' })).toBe('2.5 g')
    expect(lotFactsLine({ seed_stage: null, seed_count: null, seed_weight_g: null })).toBe('')
  })
  it('a list row names its one parent, unless that parent is this plant', () => {
    const row = openLotRow()
    expect(lotRowLine(row, OTHER)).toBe('Drying · 100 seeds · 12.35 g · from q1-sms-example-run-15')
    expect(lotRowLine({ ...row, is_member: true }, PLANT)).toBe('Has seed from this plant · Drying · 100 seeds · 12.35 g')
  })
  it('two or more parents are counted, and a lot with none says nothing about them', () => {
    const row = openLotRow()
    const two = [...row.source_plants, { ...row.source_plants[0], id: OTHER }]
    expect(lotRowLine({ ...row, source_plants: two, is_member: true }, OTHER))
      .toBe('Has seed from this plant · Drying · 100 seeds · 12.35 g · from 2 plantings')
    expect(lotRowLine({ ...row, source_plants: [], seed_stage: null, seed_weight_g: null }, OTHER)).toBe('100 seeds')
  })
  it('the list\'s own sentences name the crop in lower case', () => {
    const crop = cropWords('Sweet_Pepper')
    expect(crop).toBe('sweet pepper')
    expect(lotsLoadingLine(crop)).toBe('Looking for your other sweet pepper lots…')
    expect(lotsNoneLine(crop)).toBe('No sweet pepper lots to add to right now.')
    expect(otherLotsDivider(crop)).toBe('Other sweet pepper lots. Adding to one makes it a mix.')
    expect(lotsNoneLine('')).toBe('No lots to add to right now.')
  })
})

describe('what was typed', () => {
  it.each([
    ['', null, false], ['  ', null, false], ['1', 1, false], ['30', 30, false], ['1000000', 1000000, false],
    ['0', null, true], ['-1', null, true], ['2.5', null, true], ['1e3', null, true], ['abc', null, true],
    ['1000001', null, true],
  ])('count %j', (raw, value, refused) => {
    const got = parseAddCount(raw)
    expect(got.value).toBe(value)
    expect(!!got.error).toBe(refused)
  })
  it.each([
    ['', null, false], ['2.5', 2.5, false], ['2.5 g', 2.5, false], ['250 mg', 0.25, false], ['.5', 0.5, false],
    ['12.3456', 12.346, false], ['100000', 100000, false],
    // Rounded to three places FIRST, as the route does: 0.0004 is then nothing, and 100000.001 is over.
    ['0', null, true], ['0.0004', null, true], ['100000.001', null, true], ['-1', null, true], ['heavy', null, true],
  ])('weight %j', (raw, value, refused) => {
    const got = parseAddWeight(raw)
    expect(got.value).toBe(value)
    expect(!!got.error).toBe(refused)
  })
})

describe('the request body', () => {
  const spec = contract.seed_additions_post
  const allowed = new Set([...spec.request_required, ...spec.request_optional])
  const base = { key: KEY, plantId: PLANT, expectedIds: [PLANT, OTHER], pickedOn: '2026-10-08' }
  const bodies = {
    'no amount': buildAdditionBody(base),
    'a count': buildAdditionBody({ ...base, count: 30, estimated: true }),
    'a weight': buildAdditionBody({ ...base, weight: 2.5 }),
    'both and a filing': buildAdditionBody({ ...base, count: 30, estimated: false, weight: 2.5,
      filing: { variety_id: 'mix', expect_variety_id: 'was' } }),
    'an empty set': buildAdditionBody({ ...base, expectedIds: [] }),
  }
  it.each(Object.entries(bodies))('%s: the contract\'s required keys, some optional ones, nothing else', (_n, body) => {
    for (const k of spec.request_required) expect(Object.keys(body)).toContain(k)
    for (const k of Object.keys(body)) expect(allowed.has(k)).toBe(true)
    for (const k of spec.request_never) expect(Object.keys(body)).not.toContain(k)
    // Nothing is sent as null: an optional key is there with a value, or not there.
    for (const v of Object.values(body)) expect(v).not.toBeNull()
  })
  it('sends exactly what was given', () => {
    expect(bodies['no amount']).toEqual({
      addition_key: KEY, plant_id: PLANT, expected_source_plant_ids: [PLANT, OTHER], picked_on: '2026-10-08',
    })
    expect(bodies['a count']).toEqual({
      addition_key: KEY, plant_id: PLANT, expected_source_plant_ids: [PLANT, OTHER], picked_on: '2026-10-08',
      add_seed_count: 30, add_estimated: true,
    })
    expect(bodies['both and a filing'].add_estimated).toBe(false)
    expect(bodies['both and a filing'].add_seed_weight_g).toBe(2.5)
    expect(bodies['both and a filing'].filing).toEqual({ variety_id: 'mix', expect_variety_id: 'was' })
    expect(bodies['an empty set'].expected_source_plant_ids).toEqual([])
  })
  it('the basis rides with the count and only with the count', () => {
    expect(Object.keys(buildAdditionBody({ ...base, estimated: true, weight: 1 }))).not.toContain('add_estimated')
  })
  it('only a reply that names its addition is a save', () => {
    expect(additionSaved(additionReply())).toBe(true)
    expect(additionSaved({ id: 'x', name: 'made by an older server' })).toBe(false)
    expect(additionSaved({ addition: {} })).toBe(false)
    expect(additionSaved(null)).toBe(false)
  })
})

describe('the timeline entry', () => {
  it('the note, three forms', () => {
    expect(additionNote('Sungold — saved 2026')).toBe('Added seed to "Sungold — saved 2026".')
    expect(additionNote('Sungold — saved 2026', 30, false)).toBe('Added seed to "Sungold — saved 2026". 30 seeds.')
    expect(additionNote('Sungold — saved 2026', 30, true)).toBe('Added seed to "Sungold — saved 2026". approx. 30 seeds.')
  })
  const reply = additionReply()
  const base = { key: KEY, plantId: PLANT, expectedIds: [PLANT], pickedOn: '2026-10-08' }
  it('no amount: three metadata keys, the lot named as the reply stored it', () => {
    expect(additionEventBody(buildAdditionBody(base), reply)).toEqual({
      plant_id: PLANT, event_type: 'seed_saved', event_date: '2026-10-08',
      notes: `Added seed to "${reply.name}".`,
      metadata: { seed_lot_id: reply.id, addition: true, seed_addition_id: reply.addition.id },
    })
  })
  it('a count: the count and its basis join them', () => {
    const ev = additionEventBody(buildAdditionBody({ ...base, count: 30, estimated: true }), reply)
    expect(ev.metadata).toEqual({
      seed_lot_id: reply.id, addition: true, seed_addition_id: reply.addition.id,
      added_seed_count: 30, added_estimated: true,
    })
    expect(ev.notes).toBe(`Added seed to "${reply.name}". approx. 30 seeds.`)
  })
  it('a count and a weight: all six, and the note says nothing of the weight', () => {
    const ev = additionEventBody(buildAdditionBody({ ...base, count: 1, estimated: false, weight: 2.5 }), reply)
    expect(Object.keys(ev.metadata).sort()).toEqual(['added_estimated', 'added_seed_count', 'added_seed_weight_g',
      'addition', 'seed_addition_id', 'seed_lot_id'])
    expect(ev.metadata.added_seed_weight_g).toBe(2.5)
    expect(ev.notes).toBe(`Added seed to "${reply.name}". 1 seed.`)
  })
})

describe('the outcome line — what the lot will say', () => {
  const counted = { seed_count: 120, seed_count_estimated: false, seed_stage: 'drying' }
  const estimated = { seed_count: 120, seed_count_estimated: true, seed_stage: 'drying' }
  it.each([
    ['counted + counted today', counted, 30, false, 'The lot will say 150 seeds (120 now and 30 today).'],
    ['counted + approximate today', counted, 30, true, 'The lot will say approx. 150 seeds (120 now and 30 today).'],
    ['estimated + counted today', estimated, 30, false, 'The lot will say approx. 150 seeds (120 now and 30 today).'],
    ['counted + blank', counted, null, false, "The lot will say approx. 120 seeds, because today's seed is not counted."],
    ['estimated + blank', estimated, null, true, "The lot will say approx. 120 seeds, because today's seed is not counted."],
    ['counted 0 + counted today', { ...counted, seed_count: 0 }, 5, false, 'The lot will say 5 seeds (0 now and 5 today).'],
    ['counted 0 + blank: no line', { ...counted, seed_count: 0 }, null, false, null],
    ['no count, not stored', { seed_count: null, seed_stage: 'drying' }, null, false,
      "This lot has no seed count yet. You'll be asked for one when you mark it stored."],
    ['no count, no stage', { seed_count: null, seed_stage: null }, null, false,
      "This lot has no seed count yet. You'll be asked for one when you mark it stored."],
    ['no count, not stored, a number typed', { seed_count: null, seed_stage: 'drying' }, 25, false,
      "This lot has no seed count yet. You'll be asked for one when you mark it stored."],
    ['no count, stored', { seed_count: null, seed_stage: 'stored' }, null, false,
      "This lot has no seed count yet. You can add one on the lot's page."],
  ])('%s', (_name, lot, count, est, line) => {
    expect(outcomeLine(lot, count, est)).toBe(line)
  })
  it('the stored-lot line and the two re-file sentences', () => {
    expect(STORED_LOT_LINE).toBe('This lot is marked stored. Seed that is not fully dry can spoil the rest.')
    expect(refileSentence({ plantingName: 'Bed 3 peppers', mixName: 'Ace + Jimmy mix', newLotName: 'Ace + Jimmy mix — saved 2026' }))
      .toBe('Bed 3 peppers is recorded under a different variety, so this lot will be filed as a mix and renamed Ace + Jimmy mix — saved 2026.')
    expect(refileSentence({ plantingName: 'Bed 3 peppers', mixName: 'Ace + Jimmy mix' }))
      .toBe('Bed 3 peppers is recorded under a different variety, so this lot will be filed as a mix: Ace + Jimmy mix. Its name stays the same.')
  })
})

describe('the sentence for every answer', () => {
  it.each([
    ['lot_changed', ADD_CHANGED], ['parents_changed', ADD_CHANGED], ['blend_required', ADD_CHANGED],
    ['lot_used_up', ADD_USED_UP],
    ['addition_key_conflict', ADD_REFUSED], ['own_source_lot', ADD_REFUSED], ['amount_too_large', ADD_REFUSED],
    ['variety_mismatch_no_parents', ADD_REFUSED], ['too_many_parents', ADD_REFUSED],
    ['parent_without_variety', ADD_REFUSED], ['mixed_crop_parents', ADD_REFUSED], ['variety_unusable', ADD_REFUSED],
    ['filing_crop_mismatch', ADD_REFUSED], [undefined, ADD_REFUSED], ['a code from a newer server', ADD_REFUSED],
  ])('%s', (code, sentence) => {
    expect(sentenceForRefusal(code)).toBe(sentence)
  })
  it('the exact words', () => {
    expect(ADD_CHANGED).toBe('This lot changed somewhere else just now. This is the latest. Tap Add to this lot if it still needs adding.')
    expect(ADD_USED_UP).toBe('That lot is marked used up or no longer in use. Nothing was added. Open the lot to change that first.')
    expect(ADD_REFUSED).toBe("Couldn't add to that lot. Nothing was changed.")
  })
  it('every code the contract gives the additions route has a sentence, and none is the server\'s', () => {
    const codes = [
      ...Object.keys(contract.seed_additions_post.refusals),
      ...Object.entries(contract.refusals).filter(([, r]) => r.routes.includes(contract.seed_additions_post.route)).map(([c]) => c),
    ]
    expect(codes.length).toBeGreaterThanOrEqual(12)
    for (const code of codes) {
      const said = sentenceForRefusal(code)
      expect([ADD_CHANGED, ADD_USED_UP, ADD_REFUSED]).toContain(said)
      const server = contract.seed_additions_post.refusals[code]?.error ?? contract.refusals[code]?.error
      if (server) expect(said).not.toBe(server)
    }
    expect(isChangedRefusal('lot_changed')).toBe(true)
    expect(isChangedRefusal('lot_used_up')).toBe(false)
  })
  it('the toast, four forms', () => {
    expect(addedToast('Ace — saved 2026', 'Ace — saved 2026')).toEqual({ message: 'Added to Ace — saved 2026', tone: 'success' })
    expect(addedToast('Ace — saved 2026', 'Ace + Jimmy mix — saved 2026'))
      .toEqual({ message: 'Added. The lot is now Ace + Jimmy mix — saved 2026.', tone: 'success' })
    expect(addedToast('Ace — saved 2026', 'Ace — saved 2026', true))
      .toEqual({ message: "Added to Ace — saved 2026. The timeline entry didn't save.", tone: 'error' })
    expect(addedToast('Ace — saved 2026', 'Ace + Jimmy mix — saved 2026', true))
      .toEqual({ message: "Added. The lot is now Ace + Jimmy mix — saved 2026. The timeline entry didn't save.", tone: 'error' })
  })
})
