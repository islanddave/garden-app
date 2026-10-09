// What ./a3-exit.config.mjs takes from the `test` block of vitest.config.ts, and what it leaves behind, as two
// written lists. A key that is in neither is an error: a setting added to vitest.config.ts later (a pool, a mock
// reset, environmentOptions) would otherwise be silently missing from the exit checks, and their jsdom side would
// stop being what ci.yml runs.
export const CARRIED = ['globals', 'testTimeout', 'exclude', 'env']
// environment, setupFiles and projects are the thing under comparison; reporters is the CI test-ID notice; coverage
// (its include, reporters and thresholds) measures the SPA and gates `npm test`.
export const LEFT_BEHIND = ['environment', 'setupFiles', 'projects', 'reporters', 'coverage']

export function carry(baseTest) {
  const unknown = Object.keys(baseTest).filter((key) => !CARRIED.includes(key) && !LEFT_BEHIND.includes(key))
  if (unknown.length) {
    throw new Error(`vitest.config.ts has test.${unknown.join(', test.')}, which scripts/ci-telemetry/a3-exit-carry.mjs `
      + 'neither carries into the A3 exit checks nor leaves behind: add it to CARRIED or to LEFT_BEHIND there')
  }
  return Object.fromEntries(CARRIED.filter((key) => key in baseTest).map((key) => [key, baseTest[key]]))
}
