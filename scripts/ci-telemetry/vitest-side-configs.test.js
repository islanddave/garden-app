// The four configs that build on vitest.config.ts, held to its two projects: vitest.stress.config.ts and the three
// flag-off configs behind the `test:flag-off*` scripts of package.json.
//
// Both were wrong under the projects until ./vitest-side-config.mjs (its header has the two mechanisms):
//   - `npm run test:flag-off:seed` collected 196 files where the one-project config collected 175, because `--dir`
//     does not reach a project: the 21 more were lambda/ tests with "seed" in their path;
//   - the stress run failed every test of the node project, because its setup file loaded there too.
//
// WHAT THIS HOLDS
//   1. Each `test:flag-off*` script, with the arguments package.json gives it, collects exactly the files the unit run
//      collects with the same filters, cut to the `--dir` it passes (all of them when it passes none). So does
//      vitest.flagoff.config.ts under a `--dir`, which its script does not pass and a by-hand run may.
//   2. The stress config lists stressSetup.ts in place of src/__tests__/setup.ts and nowhere else: in the jsdom
//      project, not in the node project, and not beside `projects`.
//   3. A node-project file passes under the stress config.
//
// The children get PATH and HOME and nothing else of this run's environment, as in ./vitest-projects.test.js.
// Until OPS-A3TRIALKEYREMOVE-001 the projects were behind the A3 trial's env key, and 1 and 2 compared each config
// with the key and without it. With one shape, 1 holds the `--dir` against the unit run cut to that directory.
import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { nodeProjectFiles } from './vitest-node-project.mjs'
import { cliDir, withCliDir, withSetupReplaced } from './vitest-side-config.mjs'

const ROOT = process.cwd()
const VITEST = resolve(ROOT, 'node_modules/vitest/vitest.mjs')
const SETUP = './src/__tests__/setup.ts'
const STRESS_SETUP = './src/__tests__/helpers/stressSetup.ts'
const CHILD = { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 }
const posix = (path) => path.split(sep).join('/')
const baseEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME })

// A `test:flag-off*` script as `{ env, args }`: the assignments before `vitest run` and the arguments after it.
const scripts = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).scripts
const parsed = (name) => {
  const words = scripts[name].split(/\s+/)
  const env = {}
  while (/^[A-Z_][A-Z0-9_]*=/.test(words[0])) {
    const [key, ...value] = words.shift().split('=')
    env[key] = value.join('=')
  }
  if (words.shift() !== 'vitest' || words.shift() !== 'run') throw new Error(`${name} is not a "vitest run" script`)
  return { env, args: words }
}

// The files a run with these arguments would collect, repo-relative and sorted, whichever project takes each.
const collected = ({ env, args }) => {
  const out = execFileSync(process.execPath, [VITEST, 'list', ...args, '--filesOnly', '--json'], {
    ...CHILD,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...baseEnv(), ...env },
  })
  return [...new Set(JSON.parse(out).map(({ file }) => posix(relative(ROOT, file))))].sort()
}

// A script's positional filters: its arguments without `--config <file>` and `--dir <dir>` (either spelling).
const filtersOf = (args) => args.filter((word, at) => !['--config', '--dir'].includes(word) &&
  !['--config', '--dir'].includes(args[at - 1]) && !word.startsWith('--dir=') && !word.startsWith('--config='))

const FLAG_OFF = Object.keys(scripts).filter((name) => name.startsWith('test:flag-off')).sort()
const RUNS = [
  ...FLAG_OFF.map((name) => ({ said: `npm run ${name}`, run: parsed(name) })),
  {
    said: 'vitest.flagoff.config.ts under --dir src/__tests__',
    run: { env: {}, args: ['--config', 'vitest.flagoff.config.ts', '--dir', 'src/__tests__', 'seed'] },
  },
]

describe('the flag-off configs collect the files under their --dir', () => {
  it('covers the four scripts, each on a config that builds on vitest.config.ts', () => {
    expect(FLAG_OFF).toEqual(['test:flag-off', 'test:flag-off:seed', 'test:flag-off:seedadd', 'test:flag-off:seedboth'])
    for (const name of FLAG_OFF) {
      const { args } = parsed(name)
      const config = args[args.indexOf('--config') + 1]
      expect(readFileSync(resolve(ROOT, config), 'utf8'), config).toMatch(/test: withCliDir\(/)
    }
  })

  for (const { said, run } of RUNS) {
    it(`${said}: the files under its --dir, or the unit run's`, () => {
      const files = collected(run)
      const dir = cliDir(['node', 'vitest', 'run', ...run.args])
      expect(files.length, 'files collected').toBeGreaterThan(0)
      // The unit run (vitest.config.ts) given the same filters, cut to the --dir: exactly what this run must collect.
      // The unit run does not narrow by a --dir of its own (it does not reach a project), so the cut is made here.
      const unit = collected({ env: run.env, args: filtersOf(run.args) })
      const expected = dir === undefined ? unit : unit.filter((file) => file.startsWith(`${dir.replace(/\/$/, '')}/`))
      const why = dir === undefined ? 'with no --dir, the files the unit run collects'
        : `the files under --dir ${dir} that the unit run collects with the same filters: more means the --dir did ` +
          'not reach a project, fewer that withCliDir (scripts/ci-telemetry/vitest-side-config.mjs) narrowed one'
      expect(files, why).toEqual(expected)
    }, 240000)
  }
})

describe('vitest-side-config.mjs', () => {
  it('cliDir reads both spellings of --dir and nothing else', () => {
    expect(cliDir(['node', 'vitest', 'run', '--dir', 'src/__tests__', 'seed'])).toBe('src/__tests__')
    expect(cliDir(['node', 'vitest', 'run', '--dir=tests/parity'])).toBe('tests/parity')
    expect(cliDir(['node', 'vitest', 'run', '--directory', 'x', 'dir'])).toBeUndefined()
  })

  it('withCliDir gives the directory to every project, and leaves a one-project block as it came', () => {
    const one = { globals: true }
    expect(withCliDir(one, 'src/__tests__')).toBe(one)
    const two = { globals: true, projects: [{ extends: true, test: { name: 'dom' } }, { extends: true, test: { name: 'node' } }] }
    expect(withCliDir(two, undefined)).toBe(two)
    expect(withCliDir(two, 'src/__tests__').projects.map((project) => project.test)).toEqual([
      { name: 'dom', dir: 'src/__tests__' },
      { name: 'node', dir: 'src/__tests__' },
    ])
    expect(two.projects[0].test).toEqual({ name: 'dom' })
  })

  it('withSetupReplaced swaps the file where it is listed, leaves a project without it alone, and throws on none', () => {
    expect(withSetupReplaced({ setupFiles: ['a', 'b'] }, 'a', 'z').setupFiles).toEqual(['z', 'b'])
    const two = { projects: [{ extends: true, test: { name: 'dom', setupFiles: ['a'] } }, { extends: true, test: { name: 'node' } }] }
    const out = withSetupReplaced(two, 'a', 'z')
    expect(out.setupFiles).toBeUndefined()
    expect(out.projects.map((project) => project.test)).toEqual([{ name: 'dom', setupFiles: ['z'] }, { name: 'node' }])
    expect(() => withSetupReplaced(two, 'missing', 'z')).toThrow(/no setupFiles entry is missing/)
  })
})

// vitest.stress.config.ts as vitest is given it: its `test`, read by vite's own config loader in a child `node` (not
// imported here, for the reason given in ./vitest-projects.test.js).
const STRESS_READER = `
  import { loadConfigFromFile } from 'vite'
  const { config } = await loadConfigFromFile({ command: 'serve', mode: 'test' }, 'vitest.stress.config.ts')
  process.stdout.write(JSON.stringify(config.test))`

describe('vitest.stress.config.ts puts its setup file where src/__tests__/setup.ts was', () => {
  const two = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', STRESS_READER], {
    ...CHILD,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: baseEnv(),
  }))

  it('in every jsdom project, in no other, and not beside `projects`', () => {
    expect(two.setupFiles ?? []).toEqual([])
    expect(two.projects.map((project) => project.test.environment).sort()).toEqual(['jsdom', 'node'])
    for (const { test } of two.projects) {
      expect(test.setupFiles ?? [], `project ${test.name}`).toEqual(test.environment === 'jsdom' ? [STRESS_SETUP] : [])
    }
    expect(JSON.stringify(two)).not.toContain(SETUP)
  })

  it('a node-project file passes under the stress config', () => {
    const file = 'lambda/daily-plan/seededgate.test.js'
    expect(nodeProjectFiles(ROOT)).toContain(file)
    const run = spawnSync(process.execPath, [VITEST, 'run', '-c', 'vitest.stress.config.ts', file], {
      ...CHILD,
      env: { ...baseEnv(), NO_COLOR: '1' },
    })
    expect(run.status, `${run.stdout}\n${run.stderr}`.slice(-3000)).toBe(0)
    expect(run.stdout).toMatch(/Test Files\s+1 passed \(1\)/)
  }, 240000)
})
