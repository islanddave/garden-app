// The four configs that build on vitest.config.ts, held to both shapes of the A3 trial (VITEST_NODE_PROJECT=1 or
// not): vitest.stress.config.ts and the three flag-off configs behind the `test:flag-off*` scripts of package.json.
//
// Both were wrong with the key set until ./vitest-side-config.mjs (its header has the two mechanisms):
//   - `npm run test:flag-off:seed` collected 196 files where it collects 175 without the key, because `--dir` does
//     not reach a project;
//   - the stress run failed every test of the node project, because its setup file loaded there too.
//
// WHAT THIS HOLDS
//   1. Each `test:flag-off*` script, with the arguments package.json gives it, collects one set of files with the
//      key and without it. So does vitest.flagoff.config.ts under a `--dir`, which its script does not pass and a
//      by-hand run may.
//   2. The stress config lists stressSetup.ts in place of src/__tests__/setup.ts and nowhere else: at the root
//      without the key; with it, in the jsdom project and not in the node project, and not beside `projects`.
//   3. A node-project file passes under the stress config with the key set.
//
// The children get PATH and HOME and nothing else of this run's environment, as in ./vitest-projects.test.js.
// When the trial ends and the projects are unconditional, the "without the key" halves go and the rest stays.
import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { nodeProjectFiles } from './vitest-node-project.mjs'
import { cliDir, withCliDir, withSetupReplaced } from './vitest-side-config.mjs'

const ROOT = process.cwd()
const KEY = 'VITEST_NODE_PROJECT'
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
const collected = ({ env, args }, switched) => {
  const out = execFileSync(process.execPath, [VITEST, 'list', ...args, '--filesOnly', '--json'], {
    ...CHILD,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...baseEnv(), ...env, ...(switched ? { [KEY]: '1' } : {}) },
  })
  return [...new Set(JSON.parse(out).map(({ file }) => posix(relative(ROOT, file))))].sort()
}

const FLAG_OFF = Object.keys(scripts).filter((name) => name.startsWith('test:flag-off')).sort()
const RUNS = [
  ...FLAG_OFF.map((name) => ({ said: `npm run ${name}`, run: parsed(name) })),
  {
    said: 'vitest.flagoff.config.ts under --dir src/__tests__',
    run: { env: {}, args: ['--config', 'vitest.flagoff.config.ts', '--dir', 'src/__tests__', 'seed'] },
  },
]

describe('the flag-off configs collect one set of files with the A3 trial key and without it', () => {
  it('covers the four scripts, each on a config that builds on vitest.config.ts', () => {
    expect(FLAG_OFF).toEqual(['test:flag-off', 'test:flag-off:seed', 'test:flag-off:seedadd', 'test:flag-off:seedboth'])
    for (const name of FLAG_OFF) {
      const { args } = parsed(name)
      const config = args[args.indexOf('--config') + 1]
      expect(readFileSync(resolve(ROOT, config), 'utf8'), config).toMatch(/test: withCliDir\(/)
    }
  })

  for (const { said, run } of RUNS) {
    it(`${said}: the same files`, () => {
      const without = collected(run, false)
      const withKey = collected(run, true)
      expect(without.length, 'files collected without the key').toBeGreaterThan(0)
      expect(withKey.filter((file) => !without.includes(file)), 'collected only with the key').toEqual([])
      expect(without.filter((file) => !withKey.includes(file)), 'collected only without the key').toEqual([])
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

// vitest.stress.config.ts as vitest is given it, without the key and with it: `test` of each, read by vite's own
// config loader in a child `node` (not imported here, for the reason given in ./vitest-projects.test.js).
const STRESS_READER = `
  import { loadConfigFromFile } from 'vite'
  const read = []
  for (const value of [null, '1']) {
    if (value === null) delete process.env.${KEY}
    else process.env.${KEY} = value
    const { config } = await loadConfigFromFile({ command: 'serve', mode: 'test' }, 'vitest.stress.config.ts')
    read.push(config.test)
  }
  process.stdout.write(JSON.stringify(read))`

describe('vitest.stress.config.ts puts its setup file where src/__tests__/setup.ts was, in both shapes', () => {
  const [one, two] = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', STRESS_READER], {
    ...CHILD,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: baseEnv(),
  }))

  it('without the key: one project, the stress setup alone', () => {
    expect(one.projects).toBeUndefined()
    expect(one.environment).toBe('jsdom')
    expect(one.setupFiles).toEqual([STRESS_SETUP])
  })

  it('with the key: in every jsdom project, in no other, and not beside `projects`', () => {
    expect(two.setupFiles ?? []).toEqual([])
    expect(two.projects.map((project) => project.test.environment).sort()).toEqual(['jsdom', 'node'])
    for (const { test } of two.projects) {
      expect(test.setupFiles ?? [], `project ${test.name}`).toEqual(test.environment === 'jsdom' ? [STRESS_SETUP] : [])
    }
    expect(JSON.stringify(two)).not.toContain(SETUP)
  })

  it('with the key: a node-project file passes under the stress config', () => {
    const file = 'lambda/daily-plan/seededgate.test.js'
    expect(nodeProjectFiles(ROOT)).toContain(file)
    const run = spawnSync(process.execPath, [VITEST, 'run', '-c', 'vitest.stress.config.ts', file], {
      ...CHILD,
      env: { ...baseEnv(), NO_COLOR: '1', [KEY]: '1' },
    })
    expect(run.status, `${run.stdout}\n${run.stderr}`.slice(-3000)).toBe(0)
    expect(run.stdout).toMatch(/Test Files\s+1 passed \(1\)/)
  }, 240000)
})
