// The test-ID evidence reporter (vitest-test-ids-reporter.mjs): what it hashes, the one line it prints, and the
// property the gate depends on: nothing it does can fail a run.
//
// It runs inside the gating unit steps of ci.yml and ci-next.yml (vitest.config.ts, under GITHUB_ACTIONS only), and
// vitest does not catch what a reporter throws. So "it cannot throw" is tested with inputs no vitest version sends
// today: an upgrade that reshapes the reporter API must cost the evidence, never the gate.
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import TestIdsReporter, {
  testIdLines, fileLines, nameLines, nodeFiles, digest, summary, zoneLabel, TITLE_PREFIX, FORMAT_VERSION,
} from './vitest-test-ids-reporter.mjs'

const mod = (file, tests, state = 'passed') => ({
  relativeModuleId: file,
  state: () => state,
  children: {
    * allTests() {
      for (const [fullName, testState] of tests) yield { fullName, result: () => ({ state: testState }) }
    },
  },
})

const SUITE = [
  mod('src/b.test.js', [['b > second', 'passed'], ['b > first', 'failed']]),
  mod('lambda/a.test.js', [['a > only', 'skipped']]),
]

const run = (testModules, reason = 'passed', env = {}) => {
  const written = []
  const reporter = new TestIdsReporter({ write: (text) => written.push(text), env })
  const returned = reporter.onTestRunEnd(testModules, [], reason)
  return { written, returned }
}

describe('the list', () => {
  it('is one `file :: full test name :: state` line per test, sorted', () => {
    expect(testIdLines(SUITE)).toEqual([
      'lambda/a.test.js :: a > only :: skipped',
      'src/b.test.js :: b > first :: failed',
      'src/b.test.js :: b > second :: passed',
    ])
  })

  it('does not depend on the order vitest hands the modules or the tests over in', () => {
    const shuffled = [mod('lambda/a.test.js', [['a > only', 'skipped']]),
      mod('src/b.test.js', [['b > first', 'failed'], ['b > second', 'passed']])]
    expect(digest(testIdLines(shuffled))).toBe(digest(testIdLines(SUITE)))
  })

  it('sorts by code unit, not by a locale (Z before a, as no collation would have it)', () => {
    const lines = testIdLines([mod('x.test.js', [['a', 'passed'], ['Z', 'passed'], ['é', 'passed']])])
    expect(lines.map((line) => line.split(' :: ')[1])).toEqual(['Z', 'a', 'é'])
  })

  it('keeps two tests of one name as two lines', () => {
    expect(testIdLines([mod('x.test.js', [['same', 'passed'], ['same', 'passed']])])).toHaveLength(2)
  })

  it('keeps a name with a line break on one line', () => {
    const lines = testIdLines([mod('x.test.js', [['first\nsecond\r', 'passed'], ['back\\slash', 'passed']])])
    expect(lines).toEqual(['x.test.js :: back\\\\slash :: passed', 'x.test.js :: first\\nsecond\\r :: passed'])
  })

  it('gives a module that collected no test a line of its own, with the module\'s state', () => {
    expect(testIdLines([mod('broken.test.js', [], 'failed')])).toEqual([
      'broken.test.js :: (no tests collected) :: failed'])
  })
})

describe('the digest', () => {
  it('is the sha256 of the lines as UTF-8, each ended by a newline', () => {
    const lines = testIdLines(SUITE)
    expect(digest(lines)).toBe(createHash('sha256').update(`${lines.join('\n')}\n`, 'utf8').digest('hex'))
    expect(digest(lines)).toMatch(/^[0-9a-f]{64}$/)
  })

  it.each([
    ['a test changes state', [mod('src/b.test.js', [['b > second', 'passed'], ['b > first', 'passed']]), SUITE[1]]],
    ['a test is missing', [mod('src/b.test.js', [['b > second', 'passed']]), SUITE[1]]],
    ['a test is renamed', [mod('src/b.test.js', [['b > second', 'passed'], ['b > 1st', 'failed']]), SUITE[1]]],
    ['a test moves file', [mod('src/c.test.js', [['b > second', 'passed'], ['b > first', 'failed']]), SUITE[1]]],
    ['a file collects nothing', [SUITE[0], mod('lambda/a.test.js', [], 'failed')]],
    ['a file is gone', [SUITE[0]]],
  ])('moves when %s', (_what, changed) => {
    expect(digest(testIdLines(changed))).not.toBe(digest(testIdLines(SUITE)))
  })
})

describe('the two coarser digests, which say HOW two lists differ', () => {
  const sums = (testModules) => Object.fromEntries(summary(testModules, 'passed').split(' ').map((t) => t.split('=')))
  const base = sums(SUITE)
  const moved = (testModules) => {
    const now = sums(testModules)
    return ['sha256', 'files_sha256', 'names_sha256'].filter((key) => now[key] !== base[key])
  }

  it('are the sha256 of the sorted files, each once, and of the sorted `file :: full test name` lines', () => {
    expect(fileLines(SUITE)).toEqual(['lambda/a.test.js', 'src/b.test.js'])
    expect(fileLines([...SUITE, mod('src/b.test.js', [['again', 'passed']])])).toEqual(fileLines(SUITE))
    expect(nameLines(SUITE)).toEqual(['lambda/a.test.js :: a > only', 'src/b.test.js :: b > first',
      'src/b.test.js :: b > second'])
    expect(base.files_sha256).toBe(digest(fileLines(SUITE)))
    expect(base.names_sha256).toBe(digest(nameLines(SUITE)))
    expect(new Set([base.sha256, base.files_sha256, base.names_sha256]).size).toBe(3)
  })

  it('a test that only changes state moves the full digest and neither of the others', () => {
    expect(moved([mod('src/b.test.js', [['b > second', 'passed'], ['b > first', 'passed']]), SUITE[1]]))
      .toEqual(['sha256'])
  })

  it('a renamed or missing test moves the names digest too, and not the files digest', () => {
    expect(moved([mod('src/b.test.js', [['b > second', 'passed'], ['b > 1st', 'failed']]), SUITE[1]]))
      .toEqual(['sha256', 'names_sha256'])
    expect(moved([mod('src/b.test.js', [['b > second', 'passed']]), SUITE[1]])).toEqual(['sha256', 'names_sha256'])
  })

  it('a file that is gone, added or renamed moves all three', () => {
    expect(moved([SUITE[0]])).toEqual(['sha256', 'files_sha256', 'names_sha256'])
    expect(moved([...SUITE, mod('src/c.test.js', [['c', 'passed']])])).toEqual(['sha256', 'files_sha256', 'names_sha256'])
    expect(moved([mod('src/c.test.js', [['b > second', 'passed'], ['b > first', 'failed']]), SUITE[1]]))
      .toEqual(['sha256', 'files_sha256', 'names_sha256'])
  })

  it('a file that stops collecting tests keeps the files digest: it is still a file of the run', () => {
    expect(moved([SUITE[0], mod('lambda/a.test.js', [], 'failed')])).toEqual(['sha256', 'names_sha256'])
  })

  it('the names are sorted again once their states are gone (a name that is a prefix of another changes place)', () => {
    // With its state, "a !" sorts before "a" ("!" is below ":"); without it, "a" is the shorter and comes first.
    const suite = [mod('x.test.js', [['a', 'skipped'], ['a !', 'failed']])]
    expect(testIdLines(suite)).toEqual(['x.test.js :: a ! :: failed', 'x.test.js :: a :: skipped'])
    expect(nameLines(suite)).toEqual(['x.test.js :: a', 'x.test.js :: a !'])
  })
})

describe('the line it prints', () => {
  it('is one notice titled with the zone, carrying the three digests and the counts behind them', () => {
    const { written } = run(SUITE, 'failed')
    expect(written).toHaveLength(1)
    expect(written[0]).toBe(`\n::notice title=${TITLE_PREFIX}UTC::sha256=${digest(testIdLines(SUITE))} ` +
      `files_sha256=${digest(fileLines(SUITE))} names_sha256=${digest(nameLines(SUITE))} tests=3 ` +
      'passed=1 failed=1 skipped=1 pending=0 files=2 node_files=0 reason=failed v=2\n')
    expect(summary(SUITE, 'failed')).toBe(written[0].trim().split('::')[2])
    expect(FORMAT_VERSION).toBe(2)
  })

  it('counts the files that ran in the node project, and moves no digest with it', () => {
    const inProject = (name, module) => ({ ...module, project: { name } })
    const twoProjects = [inProject('dom', SUITE[0]), inProject('node', SUITE[1])]
    expect(nodeFiles(SUITE)).toBe(0)                                     // one project: no module names one
    expect(nodeFiles(SUITE.map((module) => inProject('', module)))).toBe(0)
    expect(nodeFiles(twoProjects)).toBe(1)
    expect(summary(twoProjects, 'passed')).toBe(summary(SUITE, 'passed').replace(' node_files=0 ', ' node_files=1 '))
    expect(run(twoProjects).written[0]).toContain(' files=2 node_files=1 reason=passed v=2\n')
  })

  it('names the zone the pass ran under, so the two passes of the serial job never share a title', () => {
    expect(run(SUITE, 'passed', { TZ: 'America/New_York' }).written[0]).toContain(
      '::notice title=test-ids America/New_York::sha256=')
    expect(zoneLabel({})).toBe('UTC')
    expect(zoneLabel({ TZ: 'America/New_York' })).toBe('America/New_York')
  })

  it('cannot break out of the workflow command through the zone', () => {
    expect(zoneLabel({ TZ: 'a::b,c\nd%0A' })).toBe('a__b_c_d_0A')
  })
})

describe('it never fails the run it reports on', () => {
  const garbage = [
    ['no modules at all', undefined],
    ['null', null],
    ['a module with no children', [{ relativeModuleId: 'x.test.js', state: () => 'passed' }]],
    ['a test with no result()', [{ relativeModuleId: 'x', state: () => 'passed', children: { * allTests() { yield { fullName: 'x' } } } }]],
    ['allTests() that throws', [{ relativeModuleId: 'x', state: () => 'passed', children: { allTests() { throw new Error('boom\nsecond line') } } }]],
    ['a string', 'not modules'],
  ]

  it.each(garbage)('on %s it warns in one line and returns', (_what, testModules) => {
    const { written, returned } = run(testModules)
    expect(returned).toBeUndefined()
    expect(written).toHaveLength(1)
    expect(written[0]).toMatch(/^\n::warning title=test-ids UTC::no test-ID evidence for this pass: [^\n]*\n$/)
    expect(written[0]).not.toContain('sha256=')
  })

  it('swallows a stdout that throws, on the notice and on the warning', () => {
    const reporter = new TestIdsReporter({ write: () => { throw new Error('EPIPE') }, env: {} })
    expect(() => reporter.onTestRunEnd(SUITE, [], 'passed')).not.toThrow()
    expect(() => reporter.onTestRunEnd(null, [], 'passed')).not.toThrow()
  })

  it('has no other hook vitest could call', () => {
    const own = Object.getOwnPropertyNames(TestIdsReporter.prototype).filter((name) => name !== 'constructor')
    expect(own).toEqual(['onTestRunEnd'])
  })
})

describe('where it is switched on (vitest.config.ts)', () => {
  const config = readFileSync(resolve(process.cwd(), 'vitest.config.ts'), 'utf8')

  it('is imported unconditionally, so a broken reporter fails a local run and not only CI', () => {
    expect(config).toMatch(/^import TestIdsReporter from '\.\/scripts\/ci-telemetry\/vitest-test-ids-reporter\.mjs';$/m)
  })

  it('is added under GITHUB_ACTIONS only, behind vitest\'s own two default reporters', () => {
    const block = config.match(/\.\.\.\(process\.env\.GITHUB_ACTIONS === 'true'\s*\? \{ reporters: \[([^\]]*)\] \}\s*: \{\}\)/)
    expect(block).not.toBeNull()
    expect(block[1]).toBe("'default', 'github-actions', new TestIdsReporter()")
    expect(config.match(/reporters:/g)).toHaveLength(1)
  })

  it('restates exactly the reporters vitest itself defaults to on a runner', () => {
    // Setting `reporters` replaces vitest's default, so the config has to list it. This asks the installed vitest
    // what that default is (resolveConfig, no config file) in a child with a runner's environment and nothing
    // else: under an agent's environment vitest substitutes its `agent` reporter for `default`. A vitest upgrade
    // that changes the default reds here, and the fix is to restate the new one in vitest.config.ts.
    const ask = "import { resolveConfig } from 'vitest/node'\n" +
      'const { vitestConfig } = await resolveConfig({ config: false, watch: false })\n' +
      'process.stdout.write(JSON.stringify(vitestConfig.reporters.map((r) => (Array.isArray(r) ? r[0] : r))))\n'
    const defaults = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', ask], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 60000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_ACTIONS: 'true' },
    }))
    const restated = config.match(/reporters: \[([^\]]*)\]/)[1].split(',').map((entry) => entry.trim())
    expect(restated.pop()).toBe('new TestIdsReporter()')
    expect(restated.map((entry) => entry.replace(/^'|'$/g, ''))).toEqual(defaults)
    expect(defaults.length).toBeGreaterThan(0)
  }, 60000)
})
