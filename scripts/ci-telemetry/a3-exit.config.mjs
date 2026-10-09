// The A3 trial's two exit checks (E1 assertion parity, E2 loaded-module coverage parity), as a vitest config of their
// own. Run by ./a3-exit.sh; compared by ./a3-exit.py. vitest.config.ts does not import this file and nothing here
// changes what `npm test` or a workflow runs.
//
// It runs the node project's files (nodeProjectFiles() of ./vitest-node-project.mjs, the same list vitest.config.ts
// builds its projects from) as ONE unnamed project, in the environment A3_EXIT_ENV names:
//   jsdom   jsdom and the repo setup file src/__tests__/setup.ts: what those files get in ci.yml;
//   node    no DOM and no repo setup file: what they get in the trial's `node` project.
// Any other value, or none, is an error: a default here would let one side of the comparison be the wrong one.
//
// WHAT IS TAKEN FROM vitest.config.ts. That config is IMPORTED, not copied, and everything in it outside `test` is
// passed on as it is (plugins, esbuild, resolve.alias: the Lambda dependency stubs the handlers need to load). From
// its `test` block: globals, testTimeout, exclude and env. Left behind on purpose: environment, setupFiles and
// projects (the thing under comparison), reporters (the CI test-ID notice) and coverage (its include, reporters and
// thresholds measure the SPA and gate `npm test`). Both lists are in ./a3-exit-carry.mjs, and a key of that block
// that is in neither stops this config: a setting added there later is carried or left behind in writing.
//
// ONE FILE IS LEFT OUT BY NAME, in both environments: scripts/ci-telemetry/vitest-projects.test.js. Its first test
// holds this very thing, that a file has no DOM only where the trial's env key is set AND the project is named
// `node`, so in this config's node mode it fails by design (the previous run of these checks saw exactly that one
// failure). Setting the key here would not pass it (the project name is checked too) and would put the key's name in
// a fifth file, which scripts/test_ci_next.py pins to four.
//
// A3_EXIT_OUT is the directory this run writes: tests.jsonl (./a3-exit-recorder.mjs), and with A3_EXIT_WIDE=1
// coverage/coverage-final.json. WIDE turns coverage on: v8 read by the unit run's own provider
// (./coverage-v8-two-forms.mjs, named here exactly as vitest.config.ts names it: the stock provider reads a module
// loaded both through vite and by Node by draw, BUG-ENGINECOVERAGETWOREADINGS-001, and E2 would compare the draws),
// the json reporter, and NO `include`. In vitest 4 that is
// the wide setting: with no include every module a test loaded is reported (node_modules and the test files
// themselves are left out by vitest), and a file nothing loaded is not, which is what `all: false` meant before
// vitest 4 dropped the option. Naming lambda/**, scripts/** and the rest would report every file under them, loaded
// or not, and miss whatever is reached outside them.
//
// A3_EXIT_CONTROL=1 (jsdom only) runs ./a3-exit.control.mjs alone: one test that imports nothing. With WIDE its
// coverage file names exactly the modules the repo setup file loads, which a3-exit.py e2 takes as --setup-loads.
//
// A3_EXIT_FIXTURE=1 (either environment) runs ./a3-exit.fixture.mjs alone: tests with known assertion counts.
// ./a3-exit-fixture.test.js does that and holds the tests.jsonl it gets; a3-exit.sh never sets it.
import { fileURLToPath } from 'node:url'
import base from '../../vitest.config.ts'
import { nodeProjectFiles } from './vitest-node-project.mjs'
import Recorder from './a3-exit-recorder.mjs'
import { carry } from './a3-exit-carry.mjs'

const repo = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')
const here = 'scripts/ci-telemetry'
const LEFT_OUT = `${here}/vitest-projects.test.js`

const mode = process.env.A3_EXIT_ENV
if (mode !== 'jsdom' && mode !== 'node') {
  throw new Error(`A3_EXIT_ENV must be jsdom or node, got ${JSON.stringify(mode)}`)
}
const out = process.env.A3_EXIT_OUT
if (!out || !out.startsWith('/')) {
  throw new Error(`A3_EXIT_OUT must be an absolute directory path, got ${JSON.stringify(out)}`)
}
const control = process.env.A3_EXIT_CONTROL === '1'
if (control && mode !== 'jsdom') throw new Error('A3_EXIT_CONTROL=1 is for A3_EXIT_ENV=jsdom: node has no setup file')
const fixture = process.env.A3_EXIT_FIXTURE === '1'
if (control && fixture) throw new Error('A3_EXIT_CONTROL=1 and A3_EXIT_FIXTURE=1 each run one file alone: set one')
const wide = process.env.A3_EXIT_WIDE === '1'
const alone = control ? `${here}/a3-exit.control.mjs` : fixture ? `${here}/a3-exit.fixture.mjs` : null

const files = nodeProjectFiles(repo)
if (!files.includes(LEFT_OUT)) {
  throw new Error(`${LEFT_OUT} is not a node-project file any more: take it out of LEFT_OUT in ${here}/a3-exit.config.mjs`)
}

const { test: baseTest, ...outsideTest } = base

export default {
  ...outsideTest,
  root: repo,
  test: {
    ...carry(baseTest),
    environment: mode,
    // The counter first in both modes, so the only difference between them is the repo setup file.
    setupFiles: [`./${here}/a3-exit-count.mjs`, ...(mode === 'jsdom' ? ['./src/__tests__/setup.ts'] : [])],
    include: alone ? [alone] : files.filter((file) => file !== LEFT_OUT),
    reporters: ['dot', new Recorder({ out, mode, leftOut: alone ? [] : [LEFT_OUT] })],
    coverage: wide
      ? {
          enabled: true,
          provider: 'custom',
          customProviderModule: './scripts/ci-telemetry/coverage-v8-two-forms.mjs',
          reporter: ['json'],
          reportsDirectory: `${out}/coverage`,
        }
      : { enabled: false },
  },
}
