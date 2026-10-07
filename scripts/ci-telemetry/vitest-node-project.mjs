// Which test files the `node` project of the A3 trial runs. vitest.config.ts builds both of its projects from
// nodeProjectFiles(); scripts/ci-telemetry/vitest-projects.test.js holds this file to the tree.
//
// THE RULE. A test file runs in `node` (no jsdom, no src/__tests__/setup.ts) when it lives under a node root AND
// neither it nor anything it loads is under src/. Every other test file runs in `dom`, as the one-project run has it.
// Where a test lives is not enough. When this list was written, 36 of the 530 test files under the node roots
// imported SPA code (47 src/lib and 5 src/components modules and one src/data table), most of them to hold a
// Lambda's copy of a rule to the page's. For that code the browser is production, and six of those modules read or
// sniff browser globals (src/lib/api.js, handedness.js, projectTree.js, seedsRoutes.js, transcribe.js,
// voiceDebug.js). Under node such a test keeps its name and still passes while the code it loads takes its
// no-browser branches, and neither the test-ID digest nor the coverage report can see that.
//
// LOADS_SRC is those files, sorted. It is a list because the set is not directory-shaped (some of
// lambda/daily-plan's tests and not others). It is not kept on trust: the standing test follows the imports of every
// node-project file and fails, naming the chain, when one reaches src/ and is not here; and it fails when a file
// here no longer reaches src/, so an entry stays only while it is true.
//
// WHY THE PROJECTS ARE BUILT FROM A LIST OF FILES. vitest's `exclude` is globs, any one of which removes a file, so
// the dom project cannot exclude "the node roots, but for these". A negated glob does not say it either: measured
// on picomatch 4.0.7, `lambda/!(daily-plan)/**` also rejects lambda/daily-plan-read. So nodeProjectFiles() walks the
// roots and returns the exact files. The node project's `include` and the dom project's `exclude` are that one
// list: no file can be in both projects or in neither, and dom takes every other file wherever it lives.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

export const NODE_ROOTS = ['lambda', 'scripts', 'migrations', 'tests/parity']
// vitest's own test-file extensions and nothing wider: a parked `x.int.test.js.txt` or a snapshot is named like a
// test and the one-project run never collects it. `*.test.*` only, as before: a `*.spec.*` file stays in dom.
export const NODE_TEST_NAMED = /\.test\.[cm]?[jt]sx?$/

export const LOADS_SRC = Object.freeze([
  'lambda/anchor-plausibility-frost.test.js',
  'lambda/critter/appConfig.parity.test.js',
  'lambda/critter/critterSpecies.parity.test.js',
  'lambda/critter/groupby.parity.test.js',
  'lambda/critter/navcustom.parity.test.js',
  'lambda/critter/retired-post-route.test.js',
  'lambda/critter/smokeNavPrefs.static.test.js',
  'lambda/daily-plan-read/cue-impression.test.js',
  'lambda/daily-plan/advisorynight.test.js',
  'lambda/daily-plan/cadence-rename-alias.test.js',
  'lambda/daily-plan/fetchprecip-errorbody.test.js',
  'lambda/daily-plan/forecastlows-wiring.test.js',
  'lambda/daily-plan/frostnightbasis.test.js',
  'lambda/daily-plan/frostnightmove.test.js',
  'lambda/daily-plan/frostrehearsal.test.js',
  'lambda/daily-plan/frostsubject.test.js',
  'lambda/daily-plan/frostwatchline.test.js',
  'lambda/daily-plan/radiativecopy.test.js',
  'lambda/daily-plan/radiativepairing.test.js',
  'lambda/events/batch-validators.test.js',
  'lambda/events/harvest-weight.test.js',
  'lambda/events/loss-token-alias.test.js',
  'lambda/events/moisture-check.test.js',
  'lambda/events/plant-reduction.test.js',
  'lambda/events/seed-saved-batch.test.js',
  'lambda/facebook-share/altText.test.js',
  'lambda/facebook-share/exif.trailer.test.js',
  'lambda/harvests/anchorDerive.test.js',
  'lambda/harvests/ready-impression.test.js',
  'lambda/harvests/watch-impression.test.js',
  'lambda/inventory-items/delete-reference-guard.test.js',
  'lambda/inventory-items/saved-lot-pairing.test.js',
  'lambda/photos/gallery-parent-projection.test.js',
  'lambda/photos/upload-key-policy.test.js',
  'lambda/preservation/pantryRoutes.test.js',
  'lambda/varieties/voice-alias-use.test.js',
])

const testsUnder = (repo, dir, found = []) => {
  for (const entry of readdirSync(join(repo, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') testsUnder(repo, path, found)
    } else if (NODE_TEST_NAMED.test(entry.name)) {
      found.push(path)
    }
  }
  return found
}

// Repo-relative paths, sorted. They are handed to vitest as globs: a name with a glob character in it ([, (, *)
// would match nothing, stay in dom, and red the standing test, which says so.
export const nodeProjectFiles = (repo) =>
  NODE_ROOTS.flatMap((root) => testsUnder(repo, root)).filter((file) => !LOADS_SRC.includes(file)).sort()
