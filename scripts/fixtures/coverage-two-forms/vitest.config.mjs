// The unit run's own config (vitest.config.ts: its plugins, and above all its coverage provider), pointed at the
// four cases in this directory and at the four modules they load: forms.js (through vite, by Node, and both ways in
// one worker), late.mjs (left half loaded by one worker), only-vite.mjs and only-node.js (one form each). Run only
// by the test of scripts/ci-telemetry/coverage-v8-two-forms.mjs, from the repo root, with the reports directory
// given on the command line. The cases are not named *.test.*, so the unit run itself never collects them; they
// are .mjs because this directory's package.json makes .js CommonJS.
// One project, as the unit run is without its trial key. vitest.projects.config.mjs beside this is the same run as
// two projects.
import base from '../../../vitest.config.ts'

const { projects: _projects, ...test } = base.test

export const DIR = 'scripts/fixtures/coverage-two-forms'

export default {
  ...base,
  test: {
    ...test,
    environment: 'node',
    setupFiles: [],
    include: [`${DIR}/*.case.mjs`],
    cache: false,
    coverage: {
      ...test.coverage,
      include: [`${DIR}/forms.js`, `${DIR}/late.mjs`, `${DIR}/only-vite.mjs`, `${DIR}/only-node.js`],
      exclude: [],
      thresholds: undefined,
      reporter: ['json'],
    },
  },
}
