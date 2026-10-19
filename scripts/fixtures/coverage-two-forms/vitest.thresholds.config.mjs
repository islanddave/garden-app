// The two-project config with every global threshold at 100, which these cases do not reach: what ci.yml's coverage
// shards and their merge meet in vitest.config.ts (plan A4), where a third of the suite misses the floors the whole
// clears. scripts/ci-telemetry/coverage-v8-two-forms.test.js runs the shard and merge commands under it.
import projects from './vitest.projects.config.mjs'

export default {
  ...projects,
  test: {
    ...projects.test,
    coverage: { ...projects.test.coverage, thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 } },
  },
}
