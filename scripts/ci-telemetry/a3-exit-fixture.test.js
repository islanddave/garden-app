// The parts of the A3 exit checks that are not the comparer: ./a3-exit.config.mjs, ./a3-exit-count.mjs,
// ./a3-exit-recorder.mjs and ./a3-exit-carry.mjs. (./a3-exit.py is held by scripts/test_a3_exit.py and the wrapper
// ./a3-exit.sh by scripts/test_a3_exit_sh.py.)
//
// The counter cannot be held by reading it: what it writes depends on what vitest's runner does with expect's state
// and with a task's meta. So ./a3-exit.fixture.mjs, tests whose assertion counts are known by reading them, is run
// through the config for real, once in each environment, and the tests.jsonl each run writes is held whole.
import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CARRIED, LEFT_BEHIND, carry } from './a3-exit-carry.mjs'
import { FORMAT, NOTES, testLines } from './a3-exit-recorder.mjs'

const ROOT = process.cwd()
const FIXTURE = 'scripts/ci-telemetry/a3-exit.fixture.mjs'
const scratch = mkdtempSync(join(tmpdir(), 'a3-exit-fixture-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

// One run of the config, in a child that has a shell's PATH and HOME, `given`, and nothing else of this run's
// environment.
const run = (given) => {
  const done = spawnSync(process.execPath,
    [resolve(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'scripts/ci-telemetry/a3-exit.config.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TZ: 'UTC', ...given },
    })
  return { code: done.status, said: `${done.stdout}${done.stderr}` }
}

// name, state, assertions: read off ./a3-exit.fixture.mjs
const FIXTURE_TESTS = [
  ['five through the global expect', 'passed', 5],
  ['three through the expect of its own context', 'passed', 3],
  ['two through its own and one through the global', 'passed', 3],
  ['four after an await', 'passed', 4],
  ['skipped', 'skipped', null],
  ['one, with a document of its own making from here on', 'passed', 1],
  ['none', 'passed', 0],
]

describe('the A3 exit checks: the counter and the recorder, run for real', () => {
  it.each([['jsdom', true], ['node', false]])('under %s every test carries its count, and dom %s', (mode, dom) => {
    const out = join(scratch, mode)
    const { code, said } = run({ A3_EXIT_ENV: mode, A3_EXIT_OUT: out, A3_EXIT_FIXTURE: '1' })
    expect(code, said).toBe(0)
    const [header, ...lines] = readFileSync(join(out, 'tests.jsonl'), 'utf8').trimEnd().split('\n')
      .map((line) => JSON.parse(line))
    expect(header).toEqual({ a3_exit: 2, env: mode, files: 1, tests: 7, left_out: [], notes: NOTES })
    expect(FORMAT).toBe(2)
    // The count of each test by itself: the runner zeroes it between tests. `dom` is what the environment gave the
    // file, also for the two tests that run after one of them has made a document of its own.
    expect(lines).toEqual(FIXTURE_TESTS.map(([name, state, assertionCalls]) => ({
      file: FIXTURE,
      name: `counter fixture > ${name}`,
      state,
      assertionCalls,
      dom: state === 'skipped' ? null : dom,
    })))
  }, 120000)
})

describe('the A3 exit checks: what the config refuses', () => {
  const out = join(scratch, 'refused')
  // The title is the label and nothing of `given`: `out` is a new directory every run, and a test's name is its
  // identity, to the trial's test IDs and to the exit checks themselves.
  it.each([
    ['no environment', { A3_EXIT_OUT: out }, 'A3_EXIT_ENV must be jsdom or node, got undefined'],
    ['an environment that is neither of the two', { A3_EXIT_OUT: out, A3_EXIT_ENV: 'happy-dom' },
      'A3_EXIT_ENV must be jsdom or node, got "happy-dom"'],
    ['an output directory that is not absolute', { A3_EXIT_ENV: 'node', A3_EXIT_OUT: 'out' },
      'A3_EXIT_OUT must be an absolute directory path, got "out"'],
    ['the control under node', { A3_EXIT_ENV: 'node', A3_EXIT_OUT: out, A3_EXIT_CONTROL: '1' },
      'A3_EXIT_CONTROL=1 is for A3_EXIT_ENV=jsdom'],
    ['the control and the fixture at once',
      { A3_EXIT_ENV: 'jsdom', A3_EXIT_OUT: out, A3_EXIT_CONTROL: '1', A3_EXIT_FIXTURE: '1' },
      'A3_EXIT_CONTROL=1 and A3_EXIT_FIXTURE=1 each run one file alone'],
  ])('%s stops it', (_label, given, why) => {
    const { code, said } = run(given)
    expect(code, said).not.toBe(0)
    expect(said).toContain(why)
  }, 120000)
})

describe('the A3 exit checks: what is carried from the test block of vitest.config.ts', () => {
  const block = { globals: true, reporters: ['default'], testTimeout: 20000, exclude: ['x/**'], env: { A: 'b' },
    coverage: { provider: 'v8' } }

  it('carries the four keys, from either shape of the block, and nothing else', () => {
    const carried = { globals: true, testTimeout: 20000, exclude: ['x/**'], env: { A: 'b' } }
    expect(carry({ ...block, environment: 'jsdom', setupFiles: ['./src/__tests__/setup.ts'] })).toEqual(carried)
    expect(carry({ ...block, projects: [{ extends: true }] })).toEqual(carried)
    expect(CARRIED.filter((key) => LEFT_BEHIND.includes(key))).toEqual([])
    // a key the block does not have is not made up
    expect(Object.keys(carry({ globals: true }))).toEqual(['globals'])
  })

  it('stops on a key it neither carries nor leaves behind, and names it', () => {
    expect(() => carry({ ...block, pool: 'forks', environmentOptions: {} }))
      .toThrow(/has test\.pool, test\.environmentOptions, which .*a3-exit-carry\.mjs neither carries/)
    for (const key of [...CARRIED, ...LEFT_BEHIND]) expect(() => carry({ [key]: 1 })).not.toThrow()
  })
})

describe('the A3 exit checks: the lines the recorder writes', () => {
  const test = (fullName, state, meta) => ({ fullName, result: () => ({ state }), meta: () => meta })
  const file = (relativeModuleId, tests, state = 'passed') =>
    ({ relativeModuleId, children: { allTests: () => tests }, state: () => state })

  it('one line per test, files in order, and a line for a file that collected none', () => {
    expect(testLines([
      file('lambda/b.test.js', [], 'failed'),
      file('lambda/a.test.js', [
        test('a > counted', 'passed', { a3ExitAssertions: 4, a3ExitDom: false }),
        test('a > never ran', 'skipped', {}),
        test('a > a count that is not a number', 'failed', { a3ExitAssertions: '4', a3ExitDom: 'yes' }),
      ]),
    ])).toEqual([
      { file: 'lambda/a.test.js', name: 'a > counted', state: 'passed', assertionCalls: 4, dom: false },
      { file: 'lambda/a.test.js', name: 'a > never ran', state: 'skipped', assertionCalls: null, dom: null },
      { file: 'lambda/a.test.js', name: 'a > a count that is not a number', state: 'failed', assertionCalls: null,
        dom: null },
      { file: 'lambda/b.test.js', name: null, state: 'failed', assertionCalls: null, dom: null },
    ])
  })
})
