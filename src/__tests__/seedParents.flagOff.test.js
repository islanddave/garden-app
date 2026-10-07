// V5-SEEDMULTIPARENT-001 release 2b — seedParents.js with SEED_MULTI_PARENT OFF: today's rule on the
// filed variety, whatever the parent set holds. The flag is the release's forward undo, so these are
// the answers the model must give on a flag-off build.
//
// A file of its own, with the flag held off by a STATIC top-level mock. These cases used to live at
// the foot of seedParents.test.js, switching the flag per test with vi.doMock + vi.resetModules over
// that file's own top-level mock; under load one of them ran with the flag on. Nothing here re-mocks,
// resets or imports dynamically.
import { describe, it, expect, vi } from 'vitest'

vi.mock('../lib/featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal()), SEED_MULTI_PARENT: false,
}))

import { lotNotice } from '../components/seed/seedParents.js'
import { isF2Lot } from '../components/seed/seedLots.js'
import { seedFacts } from '../components/seed/seedFacts.js'
import { whereFrom } from '../components/seed/mySeedsModel.js'
import { PARENTS_UNDEFINED, PARENTS_NULL, PARENTS_EMPTY } from './fixtures/seedMix.fixture.js'

// The same builders as seedParents.test.js.
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
const ROW1_FACT = 'F2 — won’t come true (parent F1 hybrid)'

const mixedNoF1 = [sp('pl-1', 'A'), sp('pl-2', 'B')]
const allF1 = [f1('pl-1', 'Carmen'), f1('pl-2', 'Sungold')]

describe('SEED_MULTI_PARENT off — today’s answers, whatever source_plants holds', () => {
  it('a jar filed under an F1 is F2 in full, even over a mixed set with no F1 in it (row 10 when on)', () => {
    const l = lot(mixedNoF1, { breeding_system: 'f1' })
    expect(lotNotice(l)).toEqual({ row: 0, chips: [F2_CHIP], sentences: [], f2: 'full', breedingFact: ROW1_FACT })
    expect(isF2Lot(l)).toBe(true)
    expect(seedFacts(l).find((f) => f.key === 'breeding').value).toBe(ROW1_FACT)
  })

  it('a jar NOT filed under an F1 says nothing, even when every parent is F1 (row 8 when on)', () => {
    const l = lot(allF1, { breeding_system: 'open_pollinated' })
    expect(lotNotice(l)).toEqual({ row: 0, chips: [], sentences: [], f2: null, breedingFact: null })
    expect(isF2Lot(l)).toBe(false)
    expect(seedFacts(l).find((f) => f.key === 'breeding').value).toBe('Open-pollinated')
  })

  it('no N2 for a jar filed under a mix, and no N5 for several plantings', () => {
    expect(lotNotice(lot(PARENTS_EMPTY, { variety_rank: 'blend', variety_name: 'A + B mix' })).sentences).toEqual([])
    expect(lotNotice(lot([f1('pl-1', 'Carmen'), f1('pl-2', 'Carmen')])).sentences).toEqual([])
  })

  it('the three no-parent cases answer the same as with the flag on', () => {
    // The literal seedParents.test.js pins for these same three lots with the flag ON (row 0).
    for (const parents of [PARENTS_UNDEFINED, PARENTS_NULL, PARENTS_EMPTY]) {
      const l = lot(parents, { breeding_system: 'f1', source_plant_id: 'pl-1' })
      expect(lotNotice(l)).toEqual({ row: 0, chips: [F2_CHIP], sentences: [], f2: 'full', breedingFact: ROW1_FACT })
    }
  })

  it('My seeds says "Saved from my plant" for a jar off several plantings', () => {
    expect(whereFrom(lot(allF1), null)).toBe('Saved from my plant')
  })
})
