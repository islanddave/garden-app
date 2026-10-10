// V5-SEEDMULTIPARENT-001 release 2b — the unit suite against the UNDO BUILD: SEED_MULTI_PARENT = false, served in
// memory by tests/harness/seedFlagTransform.mjs with exactly the text scripts/forward-undo.py writes.
// `npm run test:flag-off:seed` runs the seed-related files; drop the filters to run every file.
// SEED_FLAG_OFF_REHEARSAL tells src/__tests__/seedFlagOff.rehearsal.test.js to check the flag really was served
// off, so a transform that silently stopped applying fails the run instead of re-running the ON suite.
import base from './vitest.config'
import { withCliDir } from './scripts/ci-telemetry/vitest-side-config.mjs'
import { seedMultiParentOff } from './tests/harness/seedFlagTransform.mjs'

export default {
  ...base,
  plugins: [seedMultiParentOff(), ...(base.plugins || [])],
  // withCliDir: with the A3 trial key a `--dir` reaches each project (vitest-side-config.mjs).
  test: withCliDir({ ...base.test, env: { ...(base.test && base.test.env), SEED_FLAG_OFF_REHEARSAL: '1' } }),
}
