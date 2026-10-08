'use strict'
// The module the three *.case.mjs files beside it load: through vite (an import), by Node (createRequire), and both
// ways in one worker. CommonJS, like the modules of lambda/daily-plan that the two-form defect was found in.
// scripts/ci-telemetry/coverage-v8-two-forms.test.js runs the cases under the real vitest.config.ts and holds every
// hit count below to the calls the cases make. Editing this file changes those figures: change them together.

function throughVite(n) {
  if (n > 0) return 'positive'
  return 'not positive'
}

function byNode(n) {
  if (n > 0) return 'positive'
  return 'not positive'
}

function bothWays(n) {
  return n % 2 === 0 ? 'even' : 'odd'
}

function never() {
  return 'never called'
}

module.exports = { throughVite, byNode, bothWays, never }
