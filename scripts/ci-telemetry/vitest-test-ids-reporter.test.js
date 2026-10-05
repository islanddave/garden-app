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
import TestIdsReporter, { testIdLines, digest, summary, zoneLabel, TITLE_PREFIX } from './vitest-test-ids-reporter.mjs'

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

describe('the line it prints', () => {
  it('is one notice titled with the zone, carrying the digest and the counts behind it', () => {
    const { written } = run(SUITE, 'failed')
    expect(written).toHaveLength(1)
    expect(written[0]).toBe(`\n::notice title=${TITLE_PREFIX}UTC::sha256=${digest(testIdLines(SUITE))} tests=3 ` +
      'passed=1 failed=1 skipped=1 pending=0 files=2 reason=failed v=1\n')
    expect(summary(SUITE, 'failed')).toBe(written[0].trim().split('::')[2])
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
})
