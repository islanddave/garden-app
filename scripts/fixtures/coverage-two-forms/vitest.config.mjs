// The unit run's own config (vitest.config.ts: its plugins, and above all its coverage provider), pointed at the
// four cases in this directory and at the two modules they load, forms.js and late.mjs. Run only by the test of
// scripts/ci-telemetry/coverage-v8-two-forms.mjs, from the repo root, with the reports directory given on the
// command line. The cases are not named *.test.*, so the unit run itself never collects them; they are .mjs because
// this directory's package.json makes .js CommonJS.
import base from '../../../vitest.config.ts'

const { projects: _projects, ...test } = base.test

export default {
  ...base,
  test: {
    ...test,
    environment: 'node',
    setupFiles: [],
    include: ['scripts/fixtures/coverage-two-forms/*.case.mjs'],
    cache: false,
    coverage: {
      ...test.coverage,
      include: ['scripts/fixtures/coverage-two-forms/forms.js', 'scripts/fixtures/coverage-two-forms/late.mjs'],
      exclude: [],
      thresholds: undefined,
      reporter: ['json'],
    },
  },
}
