// V5-SEEDMULTIPARENT-001 release 2b — the flag-off rehearsal must really serve the flag off. Under
// `npm run test:flag-off:seed` (vitest.seedflagoff.config.ts sets SEED_FLAG_OFF_REHEARSAL) the seed files run
// against SEED_MULTI_PARENT = false; if the transform stopped applying, every file that reads the literal would
// quietly run its ON branch and the rehearsal would prove nothing about the undo build. In an ordinary run it is
// skipped: the shipped value is the flag's own business (a forward flag-off build IS the undo).
import { describe, it, expect } from 'vitest'
import { SEED_MULTI_PARENT } from '../lib/featureFlags.js'
import { lotNotice } from '../components/seed/seedParents.js'

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
})
