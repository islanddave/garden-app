// V5-SEEDMULTIPARENT-001 release 2b — the flag-off rehearsal must really serve the flag off. Under
// `npm run test:flag-off:seed` (vitest.seedflagoff.config.ts sets SEED_FLAG_OFF_REHEARSAL) the seed files run
// against SEED_MULTI_PARENT = false; if the transform stopped applying, every file that reads the literal would
// quietly run its ON branch and the rehearsal would prove nothing about the undo build. In an ordinary run it is
// skipped: the shipped value is the flag's own business (a forward flag-off build IS the undo).
import { describe, it, expect } from 'vitest'
import { SEED_MULTI_PARENT, SEED_ADD_TO_LOT } from '../lib/featureFlags.js'
import { lotNotice } from '../components/seed/seedParents.js'
import { addToLotAvailable } from '../components/seed/seedAdditions.js'

describe('the seed flag-off rehearsal', () => {
  it.runIf(process.env.SEED_FLAG_OFF_REHEARSAL === '1')('serves SEED_MULTI_PARENT = false to every module, the parent-set model included', () => {
    expect(SEED_MULTI_PARENT).toBe(false)
    // lotNotice answers by the flag as seedParents.js imported it. Two F1 parents under a jar filed
    // open-pollinated is row 8 with the flag on; with it off the set is not read at all.
    const f1 = (id, variety) => ({
      id, name: id, variety_id: `v-${variety}`, variety_name: variety, breeding_system: 'f1',
      variety_rank: 'cultivar', crop_slug: 'pepper', archived: false, deleted: false,
    })
    expect(lotNotice({
      id: 'lot-1', name: 'Porch jar', variety_id: 'v-filed', variety_name: 'Filed', variety_rank: 'cultivar',
      breeding_system: 'open_pollinated', source_plant_id: 'pl-1', source_plants: [f1('pl-1', 'carmen'), f1('pl-2', 'sungold')],
    })).toEqual({ row: 0, chips: [], sentences: [], f2: null, breedingFact: null })
  })

  // V5-SEEDLOTADDITION-001 (seed release 3) — the same canary for SEED_ADD_TO_LOT. Under
  // `npm run test:flag-off:seedadd` (vitest.seedaddflagoff.config.ts) release 3 is undone and release 2b is not:
  // this flag reads false, that one still true, and the one reader every surface of release 3 asks answers off.
  it.runIf(process.env.SEED_ADD_FLAG_OFF_REHEARSAL === '1')('serves SEED_ADD_TO_LOT = false with SEED_MULTI_PARENT still true, and addToLotAvailable() answers off', () => {
    expect(SEED_ADD_TO_LOT).toBe(false)
    expect(SEED_MULTI_PARENT).toBe(true)
    expect(addToLotAvailable()).toBe(false)
  })

  // `npm run test:flag-off:seedboth`: both undone. The case above is skipped there (it requires release 2b on)
  // and the first one runs beside this.
  it.runIf(process.env.SEED_BOTH_FLAGS_OFF_REHEARSAL === '1')('serves BOTH seed flags false, and addToLotAvailable() answers off', () => {
    expect(SEED_ADD_TO_LOT).toBe(false)
    expect(SEED_MULTI_PARENT).toBe(false)
    expect(addToLotAvailable()).toBe(false)
  })
})
