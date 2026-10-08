// V5-SEEDLOTADDITION-001 (seed release 3) — the unit suite against THIS release's undo build: SEED_ADD_TO_LOT =
// false, served in memory by tests/harness/seedFlagTransform.mjs with exactly the text scripts/forward-undo.py
// writes. Two rehearsals share this file:
//   npm run test:flag-off:seedadd    release 3 undone, release 2b still on (SEED_MULTI_PARENT as it ships).
//   npm run test:flag-off:seedboth   SEED_BOTH_FLAGS_OFF=1: both served false, the build after release 2b is
//                                    undone as well (the runbook's order: this flag off first, then that one).
// Each sets the variable src/__tests__/seedFlagOff.rehearsal.test.js reads, so a transform that silently stopped
// applying fails the run instead of re-running the ON suite. `npm run test:flag-off:seed` is the third: release
// 2b's flag off with this one as it ships (vitest.seedflagoff.config.ts).
import base from './vitest.config'
import { seedAddToLotOff, seedMultiParentOff } from './tests/harness/seedFlagTransform.mjs'

const both = process.env.SEED_BOTH_FLAGS_OFF === '1'

export default {
  ...base,
  plugins: [seedAddToLotOff(), ...(both ? [seedMultiParentOff()] : []), ...(base.plugins || [])],
  test: {
    ...base.test,
    env: {
      ...(base.test && base.test.env),
      ...(both
        ? { SEED_FLAG_OFF_REHEARSAL: '1', SEED_BOTH_FLAGS_OFF_REHEARSAL: '1' }
        : { SEED_ADD_FLAG_OFF_REHEARSAL: '1' }),
    },
  },
}
