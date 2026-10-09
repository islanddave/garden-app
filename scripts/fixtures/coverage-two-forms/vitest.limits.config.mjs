// vitest.config.mjs beside this, pointed at limits/ instead: the shapes the provider's rule for taking vite's item
// maps is known to get wrong, each way (limits/limits.case.mjs says which module is loaded how). This run FAILS, by
// the provider's own ERROR lines and exit 1, and is meant to: scripts/ci-telemetry/coverage-v8-two-forms.test.js
// reads those lines and the report. Its case is in a directory of its own so that the two runs that must pass do
// not collect it.
import one, { DIR } from './vitest.config.mjs'

export default {
  ...one,
  test: {
    ...one.test,
    include: [`${DIR}/limits/limits.case.mjs`],
    coverage: { ...one.test.coverage, include: [`${DIR}/limits/*.js`] },
  },
}
