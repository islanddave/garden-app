'use strict'
// The module the *.case.mjs files beside it load: through vite (an import), by Node (createRequire), and both
// ways in one worker. CommonJS, like the modules of lambda/daily-plan that the two-form defect was found in.
// scripts/ci-telemetry/coverage-v8-two-forms.test.js runs the cases under the real vitest.config.ts and holds every
// hit count below to the calls the cases make. Editing this file changes those figures: change them together.
//
// Three shapes of the real modules are here on purpose. This comment is not ASCII (é, €, 😀): V8 counts a file in
// UTF-16 units, so a length taken in bytes or in code points would not find Node's script of this file. LABELS is a
// `const x =` whose value starts on the next line, behind a bracket (lambda/daily-plan/handler.js:20-21): vite's
// source map has no entry for the bracket and starts that item at `LABELS`, a line early. And the `if` of
// bothWays tests `(a || b) && c` (handler.js:29): read through the same map, the `&&` starts where the `if` does.
// Both conversions must still be taken for one list.

const LABELS =
  ('positive' + ',not positive').split(',')

function throughVite(n) {
  if (n > 0) return LABELS[0]
  return LABELS[1]
}

function byNode(n) {
  if (n > 0) return LABELS[0]
  return LABELS[1]
}

function bothWays(n) {
  if ((n === 2 || n === 3) && n > 0) return n % 2 === 0 ? 'even' : 'odd'
  return 'neither'
}

function never(flag) {
  return flag ? 'never' : 'called'
}

module.exports = { throughVite, byNode, bothWays, never }
