// The unit run's coverage provider (coverage-v8-two-forms.mjs): which form it takes a script to be in, how each form
// is converted, what it refuses, and the tests that hold it to the installed vitest.
//
// The provider subclasses the INSTALLED @vitest/coverage-v8 provider and replaces five of its methods, so it leans
// on how those five call one another, and none of that is public API. A vitest upgrade must not be able to break
// it quietly. `the installed @vitest/coverage-v8` asks the package itself for its version and for every member and
// call the provider names, and `a real coverage run` puts four modules (one loaded through vite, by Node, and both
// ways in one worker; one that a worker leaves half loaded; one only vite loads; one only Node loads) through
// `vitest run --coverage` under the real vitest.config.ts, as one project and as two, and reads every hit count
// back. When either is red after an upgrade, or on another Node, re-read the provider's header against
// node_modules/@vitest/coverage-v8/dist/provider.js.
//
// Everything above those runs against a stand-in for the stock class, so each rule fails by name. One of them reads
// V8's own record of a module (only-node.v8.json): the stand-in data everywhere else is built by hand.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import provider, {
  fileLength, formOf, splitForms, whyNotSameItems, adoptMaps, negativeHits, twoForms,
  STOCK_PROVIDER, STOCK_CLASS, READ_AT, OVERRIDES, CALLS, ERROR_PREFIX, ANNOTATION,
} from './coverage-v8-two-forms.mjs'

const REREAD = 'coverage-v8-two-forms.mjs leans on the inside of @vitest/coverage-v8 and the installed one no longer ' +
  'matches what it was written against. Re-read the header of scripts/ci-telemetry/coverage-v8-two-forms.mjs ' +
  'against node_modules/@vitest/coverage-v8/dist/provider.js before trusting any coverage figure. '

// From the working directory, as the tests beside this one find the repo: vite rewrites a URL built on import.meta.url.
const HERE = resolve(process.cwd(), 'scripts/ci-telemetry/coverage-v8-two-forms.mjs')
const FIXTURE = 'scripts/fixtures/coverage-two-forms'
const WRAPPER = 209
let dir
let FILE_A
let FILE_B
let FILE_C
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'coverage-two-forms-unit-'))
  writeFileSync(join(dir, 'a.js'), 'a'.repeat(500))
  writeFileSync(join(dir, 'b.js'), 'b'.repeat(300))
  writeFileSync(join(dir, 'c.js'), 'c'.repeat(200))
  FILE_A = pathToFileURL(join(dir, 'a.js')).href
  FILE_B = pathToFileURL(join(dir, 'b.js')).href
  FILE_C = pathToFileURL(join(dir, 'c.js')).href
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// One V8 script entry as @vitest/coverage-v8 hands it over: the outermost range first.
const script = (url, startOffset, end) => ({
  url, startOffset, functions: [{ functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: end, count: 1 }] }],
})
const lengths = (table) => (url) => table[url] ?? -1

describe('which form a script is in', () => {
  const URL = 'file:///repo/lambda/daily-plan/engine.js'

  it('is Node\'s when its outermost range ends at the file\'s own length, with no start offset recorded', () => {
    expect(formOf(script(URL, 0, 500), lengths({ [URL]: 500 }))).toBe('node')
    expect(formOf(script(URL, undefined, 500), lengths({ [URL]: 500 }))).toBe('node')
  })

  it('is Node\'s when it ends at the file\'s own length though it carries vite\'s offset (loaded both ways in one worker)', () => {
    expect(formOf(script(URL, WRAPPER, 500), lengths({ [URL]: 500 }))).toBe('node')
  })

  it('is vite\'s when it carries an offset and ends anywhere else', () => {
    expect(formOf(script(URL, WRAPPER, 1042), lengths({ [URL]: 500 }))).toBe('vite')
    expect(formOf(script(URL, WRAPPER, 499), lengths({ [URL]: 500 }))).toBe('vite')
    expect(formOf(script(URL, WRAPPER, 500), lengths({}))).toBe('vite')
  })

  it('is vite\'s with its offset still to come when it has none and does not end at the file\'s length', () => {
    // src/lib/harvestWindows.js in two test files of the unit run: 13,601 characters of script for a 4,914 character file.
    expect(formOf(script(URL, 0, 13601), lengths({ [URL]: 4914 }))).toBe('pending')
    expect(formOf(script(URL, undefined, 13601), lengths({ [URL]: 4914 }))).toBe('pending')
    expect(formOf({ url: URL, startOffset: 0, functions: [] }, lengths({ [URL]: 4914 }))).toBe('pending')
    expect(formOf(script(URL, 0, 500), lengths({}))).toBe('pending')
  })

  it('measures a file in the characters V8 counts, not in bytes, and says -1 for one it cannot read', () => {
    const path = join(dir, 'wide.js')
    writeFileSync(path, '// é€😀\n')
    expect(readFileSync(path).length).toBe(13)
    expect(fileLength(pathToFileURL(path).href)).toBe(8)
    expect(fileLength(pathToFileURL(join(dir, 'gone.js')).href)).toBe(-1)
    expect(fileLength('not a url')).toBe(-1)
  })
})

describe('the split of one per-test-file result', () => {
  const URL = 'file:///repo/lambda/daily-plan/handler.js'
  const other = 'file:///repo/lambda/daily-plan/rainLog.js'
  const lazy = 'file:///repo/src/lib/harvestWindows.js'
  const viteScript = script(URL, WRAPPER, 1042)
  const required = script(URL, WRAPPER, 500)
  const plain = script(other, 0, 77)
  const inFlight = script(lazy, 0, 13601)
  const table = lengths({ [URL]: 500, [other]: 77, [lazy]: 4914 })
  const coverage = { result: [inFlight, viteScript, required, plain] }
  const { vite, node } = splitForms(coverage, table)

  it('leaves a vite script with its offset exactly as it came', () => {
    expect(vite.result[1]).toBe(viteScript)
  })

  it('gives a vite script that has no offset yet the offset of the other modules of its worker', () => {
    expect(vite.result).toEqual([{ ...inFlight, startOffset: WRAPPER }, viteScript])
  })

  it('leaves such a script as it came when the result holds no offset to give it', () => {
    const alone = splitForms({ result: [inFlight, plain] }, table)
    expect(alone.vite.result).toEqual([inFlight])
    expect(alone.vite.result[0]).toBe(inFlight)
    expect(alone.node.result).toEqual([{ ...plain, startOffset: 0 }])
  })

  it('reads every Node script at offset 0, whatever offset it came with', () => {
    expect(node.result).toEqual([{ ...required, startOffset: 0 }, { ...plain, startOffset: 0 }])
  })

  it('does not write on what it was given', () => {
    expect([inFlight.startOffset, required.startOffset]).toEqual([0, WRAPPER])
    expect(coverage.result).toEqual([inFlight, viteScript, required, plain])
  })
})

// The istanbul data of one converted file. Item i of each map starts on line i + 1 unless `starts` places it:
// [line, column] per item, which then ends nine columns on, or [line, column, last line, end column] for an item
// whose end the case is about. `column` stands for what differs between a list parsed from the file and the same
// list read through a source map: where on its line an item starts and ends. EOL is how the converter writes an end
// with nothing after it on its line that the source map has an entry for. A function's name is where its body is
// unless `decls` places it, by the function's number.
const EOL = Infinity
const loc = (line, column, lastLine = line, endColumn = column + 9) => ({
  start: { line, column }, end: { line: lastLine, column: endColumn },
})
const converted = ({
  statements = 3, fns = ['outer', 'inner'], branches = [['if', 2], ['cond-expr', 2]], column = 0, hits = 1, starts = {},
  decls = {},
} = {}) => {
  const at = (map, i) => (starts[map]?.[i] ? loc(...starts[map][i]) : loc(i + 1, column))
  return {
    statementMap: Object.fromEntries(Array.from({ length: statements }, (_, i) => [i, at('statementMap', i)])),
    fnMap: Object.fromEntries(fns.map((name, i) => [i, {
      name, decl: decls[i] ? loc(...decls[i]) : at('fnMap', i), loc: at('fnMap', i),
    }])),
    branchMap: Object.fromEntries(branches.map(([type, arms], i) => [i, {
      type, loc: at('branchMap', i), locations: Array.from({ length: arms }, () => at('branchMap', i)),
    }])),
    s: Object.fromEntries(Array.from({ length: statements }, (_, i) => [i, hits])),
    f: Object.fromEntries(fns.map((_, i) => [i, hits])),
    b: Object.fromEntries(branches.map(([, arms], i) => [i, Array(arms).fill(hits)])),
  }
}
const lines = (...numbers) => numbers.map((line) => [line, 0])

describe('taking the vite conversion\'s item maps', () => {
  it('does, when both list the same items and only their columns differ, and leaves the hit counts alone', () => {
    const node = converted({ column: 0, hits: 5 })
    const vite = converted({ column: 3, hits: 2 })
    expect(adoptMaps(node, vite)).toBeNull()
    expect(node.statementMap).toBe(vite.statementMap)
    expect(node.fnMap).toBe(vite.fnMap)
    expect(node.branchMap).toBe(vite.branchMap)
    expect([node.s, node.f, node.b]).toEqual([{ 0: 5, 1: 5, 2: 5 }, { 0: 5, 1: 5 }, { 0: [5, 5], 1: [5, 5] }])
  })

  // Each is a shape where vite's source map starts or ends an item somewhere other than the file does, and every
  // one is one item read twice, so the rule must take it. The first six are in lambda/daily-plan; where a file is
  // named the row has the extents the two conversions gave. The next six were measured in a scratch file of shapes
  // those modules do not have, put through the same run, and are what a rule with a distance in it refuses: "a
  // column late at most" the two late starts, "started together only on one line" the `if`, "ends on the line the
  // file ends it" the two early ends. The last two are not measured: no two items of those modules that start
  // together are both started early, and no start is ten lines early (the first of the six is three).
  it.each([
    ['a value on the line after its `const x =`, started a line early (handler.js:20-21)',
      'statementMap', [[10, 0], [21, 2, 21, 91], [22, 0]], [[10, 0], [20, 6, 21, EOL], [22, 0]]],
    ['an `if` and the `(a || b) && c` it tests, started at one place (handler.js:29)',
      'branchMap', [[29, 2, 33, EOL], [29, 6, 29, 63]], [[29, 2, 33, EOL], [29, 2, 29, 65]]],
    ['a start behind a bracket the reprint dropped, a column late',
      'statementMap', [[4, 2], [5, 10], [6, 2]], [[4, 2], [5, 11], [6, 2]]],
    ['an item a column late where the item inside it starts (frostClass.js:415)',
      'branchMap', [[415, 42, 415, 81], [415, 43, 415, 69]], [[415, 43, 415, 83], [415, 43, 415, 73]]],
    ['two items that start together in the file and in vite\'s text',
      'fnMap', [[7, 4], [7, 4]], [[7, 4], [7, 4]]],
    ['a template literal of several lines, ended on the line it starts (handler.js:205-290)',
      'statementMap', [[204, 2], [205, 2, 290, 30], [291, 2]], [[204, 2], [205, 2, 205, EOL], [291, 2]]],
    ['a value three lines after its `const x =`, started three lines early',
      'statementMap', [[10, 0], [14, 2, 14, EOL], [16, 12]], [[10, 0], [11, 6, 14, EOL], [16, 12]]],
    ['a statement that starts with a function in brackets, started seven columns late where the function\'s body is',
      'statementMap', [[94, 20, 94, 28], [95, 1, 95, EOL], [95, 8, 95, 9]], [[94, 20, 94, 29], [95, 8, 95, EOL], [95, 8, 95, 9]]],
    ['a start a line late, behind a bracket the reprint dropped before a line break',
      'statementMap', [[54, 12, 54, EOL], [55, 12, 57, EOL], [58, 12, 58, EOL]], [[54, 13, 54, EOL], [56, 4, 57, EOL], [58, 8, 58, EOL]]],
    ['an `if` whose test starts on the next line, started where the `if` is',
      'branchMap', [[33, 2, 38, EOL], [34, 4, 35, EOL]], [[33, 2, 38, EOL], [33, 2, 35, EOL]]],
    ['an end a line early, behind a closing bracket the reprint dropped',
      'statementMap', [[125, 47, 125, 53], [126, 2, 128, EOL], [132, 2, 132, EOL]], [[125, 47, 125, 54], [126, 2, 127, EOL], [132, 2, 132, EOL]]],
    ['an end a line early, before a `;` on the next line',
      'statementMap', [[91, 2, 91, EOL], [94, 1, 95, 1], [94, 20, 94, 28]], [[91, 2, 91, EOL], [94, 2, 94, EOL], [94, 20, 94, 29]]],
    ['two items that start together in the file, both started early',
      'branchMap', [[7, 4, 7, 40], [7, 4, 7, 20]], [[7, 0, 7, 42], [7, 0, 7, 22]]],
    ['a start many lines early that is still after the item before it',
      'statementMap', [[10, 0], [30, 2, 30, 40], [31, 0]], [[10, 0], [20, 6, 30, EOL], [31, 0]]],
  ])('does, with %s', (_, map, inFile, inVite) => {
    const node = converted({ starts: { [map]: inFile } })
    const vite = converted({ starts: { [map]: inVite } })
    expect(whyNotSameItems(node, vite)).toBeNull()
    expect(adoptMaps(node, vite)).toBeNull()
    expect(node[map]).toBe(vite[map])
  })

  it.each([
    ['one statement more', { statements: 4 }, /statementMap has 3 items read from the file and 4 read from vite's text/],
    ['one function fewer', { fns: ['outer'] }, /fnMap has 2 items read from the file and 1 read from vite's text/],
    ['one branch more', { branches: [['if', 2], ['cond-expr', 2], ['if', 2]] }, /branchMap has 2 items read from the file and 3/],
    ['a function of another name', { fns: ['outer', 'other'] }, /function 1 \(line 2\) is inner read from the file and other read from vite's text/],
    ['a function of another number where neither has a name', { fns: ['outer', '(anonymous_7)'] }, /function 1 \(line 2\) is \(anonymous_1\) read from the file and \(anonymous_7\) read from vite's text/],
    ['its two functions under each other\'s names', { fns: ['inner', 'outer'] }, /function 0 \(line 1\) is outer read from the file and inner read from vite's text/],
    ['a branch of another kind', { branches: [['if', 2], ['binary-expr', 2]] }, /branch 1 \(line 2\) is cond-expr with 2 arms read from the file and binary-expr with 2/],
    ['its two branches of each other\'s kinds', { branches: [['cond-expr', 2], ['if', 2]] }, /branch 0 \(line 1\) is if with 2 arms read from the file and cond-expr with 2/],
    ['a branch with one arm more', { branches: [['if', 2], ['cond-expr', 3]] }, /branch 1 \(line 2\) is cond-expr with 2 arms read from the file and cond-expr with 3/],
    ['a branch with one arm fewer', { branches: [['if', 2], ['cond-expr', 1]] }, /branch 1 \(line 2\) is cond-expr with 2 arms read from the file and cond-expr with 1/],
  ])('does not, and says why, when vite\'s list has %s', (_, change, why) => {
    const node = converted(change.fns?.[1]?.startsWith('(anonymous') ? { fns: ['outer', '(anonymous_1)'] } : {})
    const kept = { ...node }
    const vite = converted({ column: 3, ...change })
    expect(whyNotSameItems(node, vite)).toMatch(why)
    expect(adoptMaps(node, vite)).toMatch(why)
    expect(node.statementMap).toBe(kept.statementMap)
    expect(node.fnMap).toBe(kept.fnMap)
    expect(node.branchMap).toBe(kept.branchMap)
  })

  // The same number of items, and not the same items: every count above agrees. What gives a shifted list away is
  // an item that is not between its neighbours.
  it.each([
    ['lost its second statement and gained one before the last, so four statements sit under the number before',
      { statements: 6 }, 'statementMap', lines(1, 2, 3, 4, 5, 6), [[1, 0], [3, 0], [4, 0], [5, 0], [5, 8], [6, 0]],
      /statementMap item 1 starts at 2:0 read from the file and at 3:0 read from vite's text, which is not between the items before and after it in the file \(1:0 and 3:0\)/],
    ['gained a statement after the first and lost the fifth, so four statements sit under the number after',
      { statements: 6 }, 'statementMap', lines(1, 2, 3, 4, 5, 6), [[1, 0], [1, 8], [2, 0], [3, 0], [4, 0], [6, 0]],
      /statementMap item 2 starts at 3:0 read from the file and at 2:0 read from vite's text, which is not between the items before and after it in the file \(2:0 and 4:0\)/],
    ['lost a function and gained one of the same name further on',
      { fns: ['cb', 'cb', 'cb', 'cb'] }, 'fnMap', lines(1, 5, 9, 13), [[1, 0], [9, 0], [13, 0], [13, 4]],
      /fnMap item 1 starts at 5:0 read from the file and at 9:0 read from vite's text, which is not between the items before and after it in the file \(1:0 and 9:0\)/],
    ['gained a branch of the same kind and lost the last',
      { branches: [['if', 2], ['if', 2], ['if', 2]] }, 'branchMap', lines(2, 4, 6), [[2, 0], [2, 9], [4, 0]],
      /branchMap item 2 starts at 6:0 read from the file and at 4:0 read from vite's text, which is not between the items before and after it in the file \(4:0 and none\)/],
    ['its last two statements in each other\'s places',
      {}, 'statementMap', lines(1, 2, 3), [[1, 0], [3, 0], [2, 0]],
      /statementMap item 1 starts at 2:0 read from the file and at 3:0 read from vite's text/],
    ['only its first statement out of place, past the second',
      {}, 'statementMap', lines(5, 6, 7), [[6, 4], [6, 0], [7, 0]],
      /statementMap item 0 starts at 5:0 read from the file and at 6:4 read from vite's text, which is not between the items before and after it in the file \(none and 6:0\)/],
    ['only its last statement out of place, before the second',
      {}, 'statementMap', lines(5, 6, 7), [[5, 0], [6, 0], [5, 4]],
      /statementMap item 2 starts at 7:0 read from the file and at 5:4 read from vite's text, which is not between the items before and after it in the file \(6:0 and none\)/],
    ['a statement on the line of the one before it, a column short of it',
      {}, 'statementMap', [[4, 2], [4, 20], [5, 2]], [[4, 2], [4, 1], [5, 2]],
      /statementMap item 1 starts at 4:20 read from the file and at 4:1 read from vite's text/],
    ['a statement its source map gives no place',
      {}, 'statementMap', lines(1, 2, 3), [[1, 0], [undefined, undefined], [3, 0]],
      /statementMap item 1 starts at 2:0 read from the file and at undefined:undefined read from vite's text/],
    // From here on, lists that are in order, every start between its neighbours: the order alone took each of them
    // (OPS-COVPROVIDERMAPADOPT-001). An item is held to its own place too, and a start shared with a neighbour to
    // the two being one inside the other in the file.
    // One item under the wrong number. Four values, each on the line after its `const x =` and started at the name
    // (the handler.js:20-21 shape), so every moved start is early and still after the item before it.
    ['lost its second statement and gained one after the third, so ONE statement sits under the number before',
      { statements: 4 }, 'statementMap', [[2, 2, 2, 20], [4, 2, 4, 20], [6, 2, 6, 20], [8, 2, 8, 20]],
      [[1, 6, 2, EOL], [5, 6, 6, EOL], [6, 22, 6, EOL], [7, 6, 8, EOL]],
      /statementMap item 1 is at 4:2 to 4:20 read from the file and starts at 5:6 read from vite's text, which is past that item's own end in the file/],
    ['lost its second statement and gained one after the seventh, so five such statements sit under the number before',
      { statements: 8 }, 'statementMap', [2, 4, 6, 8, 10, 12, 14, 16].map((line) => [line, 2, line, 20]),
      [[1, 6, 2, EOL], [5, 6, 6, EOL], [7, 6, 8, EOL], [9, 6, 10, EOL], [11, 6, 12, EOL], [13, 6, 14, EOL], [14, 30, 14, EOL], [15, 6, 16, EOL]],
      /statementMap item 1 is at 4:2 to 4:20 read from the file and starts at 5:6 read from vite's text, which is past that item's own end in the file/],
    ['lost a function and gained one of the same name further on, each started a line early',
      { fns: ['cb', 'cb', 'cb', 'cb'] }, 'fnMap', [[2, 2, 2, 20], [4, 2, 4, 20], [6, 2, 6, 20], [8, 2, 8, 20]],
      [[1, 6, 2, EOL], [5, 6, 6, EOL], [7, 6, 8, EOL], [8, 30, 8, EOL]],
      /fnMap item 1 is at 4:2 to 4:20 read from the file and starts at 5:6 read from vite's text, which is past that item's own end in the file/],
    // A start shared with a neighbour that the file does not have inside it.
    ['gained a statement where its second starts and lost the third, so ONE statement sits under the number after',
      { statements: 4 }, 'statementMap', lines(1, 2, 3, 4), [[1, 0], [2, 0], [2, 0], [4, 0]],
      /statementMap item 2 starts at 3:0 read from the file and at 2:0 read from vite's text, which is not between the items before and after it in the file \(2:0 and 4:0\)/],
    ['lost its second statement, gained one before the last, and the three between started at one token',
      { statements: 6 }, 'statementMap', lines(1, 2, 3, 4, 5, 6), [[1, 0], [3, 0], [3, 0], [3, 0], [3, 0], [6, 0]],
      /statementMap item 1 starts at 2:0 read from the file and at 3:0 read from vite's text, which is not between the items before and after it in the file \(1:0 and 3:0\)/],
    ['every statement started at one place, whatever their order',
      { statements: 6 }, 'statementMap', lines(1, 2, 3, 4, 5, 6), [[1, 0], [1, 0], [1, 0], [1, 0], [1, 0], [1, 0]],
      /statementMap item 1 starts at 2:0 read from the file and at 1:0 read from vite's text, which is not between the items before and after it in the file \(1:0 and 3:0\)/],
    ['its first statement started where the second is, which the file has two lines above it and not inside it',
      { statements: 2 }, 'statementMap', [[5, 0, 5, 40], [3, 0, 3, 20]], [[5, 0, 5, EOL], [5, 0, 5, EOL]],
      /statementMap item 0 starts at 5:0 read from the file and at 5:0 read from vite's text, which is not between the items before and after it in the file \(none and 3:0\)/],
    ['a branch started where the branch after it on its line starts, which it does not hold',
      { branches: [['if', 2], ['if', 2]] }, 'branchMap', [[29, 2, 29, 40], [29, 44, 29, 80]], [[29, 44, 29, EOL], [29, 44, 29, EOL]],
      /branchMap item 0 starts at 29:2 read from the file and at 29:44 read from vite's text, which is not between the items before and after it in the file \(none and 29:44\)/],
    ['a branch started where the branch before it on its line starts, which does not hold it',
      { branches: [['if', 2], ['if', 2]] }, 'branchMap', [[29, 2, 29, 40], [29, 44, 29, 80]], [[29, 2, 29, 42], [29, 2, 29, EOL]],
      /branchMap item 1 starts at 29:44 read from the file and at 29:2 read from vite's text, which is not between the items before and after it in the file \(29:2 and none\)/],
    // One item exchanged for another in place: the list is the file's but for the one.
    ['its first statement exchanged for one after it on its line',
      {}, 'statementMap', [[12, 0, 12, 3], [13, 0], [14, 0]], [[12, 5, 12, EOL], [13, 0], [14, 0]],
      /statementMap item 0 is at 12:0 to 12:3 read from the file and starts at 12:5 read from vite's text, which is past that item's own end in the file/],
    ['its second statement exchanged for one after it on its line',
      {}, 'statementMap', [[11, 0], [12, 0, 12, 3], [13, 0]], [[11, 0], [12, 5, 12, EOL], [13, 0]],
      /statementMap item 1 is at 12:0 to 12:3 read from the file and starts at 12:5 read from vite's text, which is past that item's own end in the file/],
    ['its second statement exchanged for one that starts where it ends',
      {}, 'statementMap', [[11, 0], [12, 0, 12, 3], [13, 0]], [[11, 0], [12, 3, 12, EOL], [13, 0]],
      /statementMap item 1 is at 12:0 to 12:3 read from the file and starts at 12:3 read from vite's text, which is past that item's own end in the file/],
    ['its second statement exchanged for one many lines on',
      {}, 'statementMap', [[10, 0], [12, 0], [40, 0]], [[10, 0], [39, 0], [40, 0]],
      /statementMap item 1 is at 12:0 to 12:9 read from the file and starts at 39:0 read from vite's text, which is past that item's own end in the file/],
    ['its second statement exchanged for one on the line before it (a `return` lost, a `void 0` gained after the `if` above)',
      {}, 'statementMap', [[28, 37, 28, 70], [29, 2, 29, 18], [33, 2]], [[28, 37, 28, 71], [28, 71, 28, EOL], [33, 2]],
      /statementMap item 1 is at 29:2 to 29:18 read from the file and ends at 28:Infinity read from vite's text, which is neither on that item's last line at or past its end nor the end of an earlier line of it/],
    ['its second statement exchanged for one that starts there and runs on to the next line',
      {}, 'statementMap', [[11, 0], [12, 0, 12, 30], [14, 0]], [[11, 0], [12, 0, 13, EOL], [14, 0]],
      /statementMap item 1 is at 12:0 to 12:30 read from the file and ends at 13:Infinity read from vite's text, which is neither on that item's last line/],
    ['its second statement exchanged for one that starts there and ends short of it',
      {}, 'statementMap', [[11, 0], [12, 0, 12, 30], [14, 0]], [[11, 0], [12, 0, 12, 12], [14, 0]],
      /statementMap item 1 is at 12:0 to 12:30 read from the file and ends at 12:12 read from vite's text, which is neither on that item's last line at or past its end/],
    ['its second statement, of three lines, exchanged for one that ends inside its first line',
      {}, 'statementMap', [[11, 0], [12, 0, 14, 1], [15, 0]], [[11, 0], [12, 0, 12, 12], [15, 0]],
      /statementMap item 1 is at 12:0 to 14:1 read from the file and ends at 12:12 read from vite's text, which is neither on that item's last line at or past its end nor the end of an earlier line of it/],
    ['a branch exchanged for one of its kind on the line before it',
      { branches: [['if', 2], ['if', 2]] }, 'branchMap', [[5, 2, 5, 40], [9, 2, 12, 3]], [[5, 2, 5, 42], [8, 0, 8, EOL]],
      /branchMap item 1 is at 9:2 to 12:3 read from the file and ends at 8:Infinity read from vite's text, which is neither on that item's last line/],
    ['a statement whose end has a line and no column',
      {}, 'statementMap', lines(1, 2, 3), [[1, 0], [2, 0, 2, null], [3, 0]],
      /statementMap item 1 ends at 2:9 read from the file and at 2:null read from vite's text, and one of the two is no place in a file/],
    ['every statement in its place, and the file\'s own list has one with no end',
      {}, 'statementMap', [[1, 0], [2, 0, null, null], [3, 0]], lines(1, 2, 3),
      /statementMap item 1 ends at null:null read from the file and at 2:9 read from vite's text, and one of the two is no place in a file/],
  ])('does not, and says which item, when vite\'s list has %s', (_, shape, map, inFile, inVite, why) => {
    const node = converted({ ...shape, starts: { [map]: inFile } })
    const kept = node[map]
    const vite = converted({ ...shape, starts: { [map]: inVite } })
    expect(Object.keys(node[map])).toHaveLength(Object.keys(vite[map]).length)
    expect(whyNotSameItems(node, vite)).toMatch(why)
    expect(adoptMaps(node, vite)).toMatch(why)
    expect(node[map]).toBe(kept)
  })

  // What the rule cannot tell, held here so that the limit is in a test and not only in a comment. Each is a list
  // with one item that is not the file's, and each is taken: the other item lies over the place the lost one has
  // in the file, which is all that vite's place for the lost one itself is known to do (the rows of `does, with`).
  // Node's hits on the lost item are then counted on the other. The order alone took these too.
  it.each([
    ['its second statement exchanged for one that starts inside it and ends past it',
      'statementMap', [[11, 0], [12, 0, 12, 9], [13, 0]], [[11, 0], [12, 5, 12, EOL], [13, 0]]],
    ['its second statement, of three lines, exchanged for one that ends with its first line',
      'statementMap', [[11, 0], [12, 0, 14, 1], [15, 0]], [[11, 0], [12, 0, 12, EOL], [15, 0]]],
    ['lost its second statement and holds the one inside it twice (ONE item under the number before, of two that end together)',
      'statementMap', [[11, 0], [12, 0, 12, EOL], [12, 10, 12, EOL]], [[11, 0], [12, 10, 12, EOL], [12, 10, 12, EOL]]],
  ])('does all the same (a known limit), when vite\'s list has %s', (_, map, inFile, inVite) => {
    const node = converted({ starts: { [map]: inFile } })
    const vite = converted({ starts: { [map]: inVite } })
    expect(whyNotSameItems(node, vite)).toBeNull()
  })

  // A function has two places, its name's (`decl`) and its body's (`loc`), and vite's `decl` is often short of the
  // file's: an arrow function's is its `(` in the file and the token before that in vite's text. The body's is the
  // one held (engine.js:102).
  it('reads a function where its body is, not where its name is', () => {
    const bodies = { fnMap: [[1, 0], [102, 43, 102, 117]] }
    const node = converted({ starts: bodies, decls: { 1: [102, 40, 102, 41] } })
    const vite = converted({ starts: bodies, decls: { 1: [102, 35, 102, 40] } })
    expect(whyNotSameItems(node, vite)).toBeNull()
    expect(adoptMaps(node, vite)).toBeNull()
    expect(node.fnMap[1].decl.end.column).toBe(40)
  })

  it('does not when the two lists number their items differently', () => {
    const node = converted()
    const vite = converted()
    vite.statementMap = { 0: vite.statementMap[0], 1: vite.statementMap[1], 3: vite.statementMap[2] }
    expect(adoptMaps(node, vite)).toMatch(/statementMap item 2 read from the file is item 3 read from vite's text/)
  })
})

const MAPS = ['statementMap', 'fnMap', 'branchMap']
const mapOf = (files) => ({
  data: files,
  files: () => Object.keys(files),
  fileCoverageFor: (file) => ({ data: files[file] }),
  filter: (keep) => {
    for (const file of Object.keys(files)) if (!keep(file)) delete files[file]
  },
})
const hitsOf = ({ s, f, b }) => ({ s, f, b })
// Functions by name, and statements or branches by the line they start on: how the tests below read a file.
const byName = (file) => Object.fromEntries(Object.entries(file.fnMap).map(([key, fn]) => [fn.name, file.f[key]]))
const byLine = (map, hits) => {
  const found = {}
  for (const [key, item] of Object.entries(map)) (found[(item.loc || item).start.line] ??= []).push(hits[key])
  return found
}

describe('negative hit counts', () => {
  it('are counted per file over statements, functions and every branch arm, wherever the file is', () => {
    const found = negativeHits(mapOf({
      '/repo/clean.js': { s: { 0: 0, 1: 7 }, f: { 0: 0 }, b: { 0: [0, 3] } },
      '/repo/statement.js': { s: { 0: 1, 1: -1 }, f: { 0: 1 }, b: {} },
      '/repo/function.js': { s: { 0: 1 }, f: { 0: -4, 1: 2 }, b: {} },
      '/repo/lambda/daily-plan/engine.js': { s: {}, f: {}, b: { 0: [3, -3], 1: [-1, -2, 0] } },
    }))
    expect(found).toEqual([['/repo/statement.js', 1], ['/repo/function.js', 1], ['/repo/lambda/daily-plan/engine.js', 3]])
  })

  it('are none in a map that has none, zero included', () => {
    expect(negativeHits(mapOf({ '/repo/clean.js': { s: { 0: 0 }, f: { 0: 0 }, b: { 0: [0, 0] } } }))).toEqual([])
    expect(negativeHits(mapOf({}))).toEqual([])
  })
})

// As istanbul merges two readings of one file: hit for hit where they hold the same items; where they do not,
// every item of both (`twice`), which is what a file loaded both ways came to before its Node reading took the
// vite reading's maps.
const mergeFile = (kept, next) => {
  if (!kept) return next
  if (!MAPS.every((map) => JSON.stringify(kept[map]) === JSON.stringify(next[map]))) return { ...kept, twice: true }
  const add = (a, b) => (Array.isArray(a) ? a.map((count, arm) => count + b[arm]) : a + b)
  const sum = (hits) => Object.fromEntries(Object.keys(kept[hits]).map((key) => [key, add(kept[hits][key], next[hits][key])]))
  return { ...kept, s: sum('s'), f: sum('f'), b: sum('b') }
}

// A stand-in for the stock provider class: the calls the real one makes between the five methods (the provider's
// header lists them), and nothing else of it. What a script "converts" to comes from `table`, by form, and the
// form is told from the transform it hands getSources: vite's when that was asked, the file's when it was not.
// Like the stock class it keeps ONE start offset per URL, the last it was handed, and merges what each pass
// converts into the run's one map; it also says how many scripts of the URL it was handed in the pass.
class StandIn {
  name = 'v8'
  errors = []
  logs = []
  ctx = { logger: { error: (line) => this.errors.push(line), log: (line) => this.logs.push(line) } }
  passes = []
  table = { vite: () => converted({ column: 3 }), node: () => converted({ column: 0 }) }
  conversions = []
  returned = []
  events = []

  async generateCoverage() {
    const files = {}
    let scripts = []
    await this.readCoverageFiles({
      onFileRead: (coverage) => scripts.push(...coverage.result),
      onFinished: async (project, environment) => {
        const map = await this.convertCoverage({ result: scripts }, project, environment)
        for (const file of map.files()) files[file] = mergeFile(files[file], map.fileCoverageFor(file).data)
        scripts = []
      },
      onDebug: () => {},
    })
    this.events.push('coverage generated')
    return mapOf(files)
  }

  async generateReports() {
    this.events.push('reports written')
  }

  async readCoverageFiles({ onFileRead, onFinished }) {
    for (const [project, environment, coverages] of this.passes) {
      for (const coverage of coverages) onFileRead(coverage)
      await onFinished(project, environment)
    }
  }

  async convertCoverage(coverage, project, environment) {
    const perUrl = new Map()
    for (const entry of coverage.result) {
      perUrl.set(entry.url, { startOffset: entry.startOffset, scripts: [...(perUrl.get(entry.url)?.scripts ?? []), entry] })
    }
    const files = {}
    let form
    for (const [url, { startOffset, scripts }] of perUrl) {
      let transformed = false
      const { code } = await this.getSources(url, async () => {
        transformed = true
        return { code: 'VITE TEXT', map: {} }
      }, [])
      form = transformed ? 'vite' : 'node'
      this.conversions.push([project, environment, url, form, { startOffset, scripts: scripts.length }])
      files[url] = this.read({ url, form, project, code, startOffset, scripts })
    }
    const map = mapOf(files)
    this.returned.push({ form, project, map })
    return map
  }

  read({ url, form, project }) {
    return this.table[form](url, project)
  }

  async getSources(url, onTransform) {
    const transformed = await onTransform(url)
    return transformed ? transformed : { code: 'FILE TEXT' }
  }
}

describe('the provider class', () => {
  const TwoForms = twoForms(StandIn)
  let exitCode
  beforeAll(() => { exitCode = process.exitCode })
  // A runner sets GITHUB_ACTIONS for the whole unit run: these say what happens off one, but for the one that asks.
  beforeEach(() => { vi.stubEnv('GITHUB_ACTIONS', '') })
  afterEach(() => {
    vi.unstubAllEnvs()
    process.exitCode = exitCode
  })

  it('is the class it was handed, under the stock name, with exactly the five methods replaced', () => {
    const made = new TwoForms()
    expect(made).toBeInstanceOf(StandIn)
    expect(made.name).toBe('v8')
    const own = Object.getOwnPropertyNames(TwoForms.prototype).filter((name) => name !== 'constructor').sort()
    expect(own).toEqual([...OVERRIDES].sort())
  })

  it('converts vite\'s scripts first, each at its own offset against vite\'s text, then Node\'s at 0 against the file', async () => {
    const made = new TwoForms()
    made.passes = [['dom', 'client', [
      { result: [script(FILE_A, WRAPPER, 1042)] },
      { result: [script(FILE_A, 0, 500)] },
      // The same file both ways in one worker: both scripts carry vite's offset, and Node's is read LAST.
      { result: [script(FILE_A, WRAPPER, 1042), script(FILE_A, WRAPPER, 500)] },
    ]]]
    await made.generateCoverage({ allTestsRun: true })
    expect(made.conversions).toEqual([
      ['dom', 'client', FILE_A, 'vite', { startOffset: WRAPPER, scripts: 2 }],
      ['dom', 'client', FILE_A, 'node', { startOffset: 0, scripts: 2 }],
    ])
    expect(made.twoFormsProblems).toEqual([])
    expect(made.errors).toEqual([])
    expect(process.exitCode).toBe(exitCode)
  })

  it('converts a vite script whose offset was never recorded with the other vite scripts, at its worker\'s offset', async () => {
    const made = new TwoForms()
    made.passes = [['dom', 'client', [
      { result: [script(FILE_A, WRAPPER, 1042)] },
      // Read LAST, so its offset is the one the stock class keeps for the file. FILE_B is the worker's other module.
      { result: [script(FILE_B, WRAPPER, 777), script(FILE_A, 0, 1042)] },
    ]]]
    await made.generateCoverage({ allTestsRun: true })
    expect(made.conversions).toEqual([
      ['dom', 'client', FILE_A, 'vite', { startOffset: WRAPPER, scripts: 2 }],
      ['dom', 'client', FILE_B, 'vite', { startOffset: WRAPPER, scripts: 1 }],
    ])
    expect(made.twoFormsProblems).toEqual([])
  })

  it('holds every project\'s Node scripts until every project\'s vite scripts are converted', async () => {
    const made = new TwoForms()
    // `node` is read first and only requires the file; `dom` only imports it.
    made.passes = [
      ['node', 'ssr', [{ result: [script(FILE_A, 0, 500), script(FILE_B, 0, 300)] }]],
      ['dom', 'client', [{ result: [script(FILE_A, WRAPPER, 1042)] }]],
    ]
    await made.generateCoverage({ allTestsRun: true })
    expect(made.conversions).toEqual([
      ['dom', 'client', FILE_A, 'vite', { startOffset: WRAPPER, scripts: 1 }],
      ['node', 'ssr', FILE_A, 'node', { startOffset: 0, scripts: 1 }],
      ['node', 'ssr', FILE_B, 'node', { startOffset: 0, scripts: 1 }],
    ])
    const vite = made.returned.find((entry) => entry.form === 'vite').map.data[FILE_A]
    const node = made.returned.find((entry) => entry.form === 'node').map.data
    // The file converted both ways took the other project's vite maps; the file only Node loaded kept its own.
    expect(node[FILE_A].statementMap).toBe(vite.statementMap)
    expect(node[FILE_A].fnMap).toBe(vite.fnMap)
    expect(node[FILE_A].branchMap).toBe(vite.branchMap)
    expect(node[FILE_B].statementMap[0].start.column).toBe(0)
    expect(made.twoFormsProblems).toEqual([])
  })

  it('takes the maps of the FIRST vite conversion of a file, the ones the merged map starts from', async () => {
    const made = new TwoForms()
    // Two projects import the file, and their conversions differ by a column; the second also requires it.
    made.table.vite = (_, project) => converted({ column: project === 'dom' ? 3 : 5 })
    made.passes = [
      ['dom', 'client', [{ result: [script(FILE_A, WRAPPER, 1042)] }]],
      ['node', 'ssr', [{ result: [script(FILE_A, WRAPPER, 1042), script(FILE_A, WRAPPER, 500)] }]],
    ]
    await made.generateCoverage({ allTestsRun: true })
    const first = made.returned.find((entry) => entry.form === 'vite' && entry.project === 'dom').map.data[FILE_A]
    const node = made.returned.find((entry) => entry.form === 'node').map.data[FILE_A]
    expect(first.statementMap[0].start.column).toBe(3)
    expect(node.statementMap).toBe(first.statementMap)
    expect(node.fnMap).toBe(first.fnMap)
    expect(node.branchMap).toBe(first.branchMap)
  })

  it('leaves a count of zero at zero in every form: a file only vite loaded, one only Node loaded, one loaded both ways', async () => {
    const made = new TwoForms()
    const onlyVite = { s: { 0: 0, 1: 4, 2: 0 }, f: { 0: 0, 1: 4 }, b: { 0: [0, 4], 1: [0, 0] } }
    const onlyNode = { s: { 0: 2, 1: 0, 2: 0 }, f: { 0: 2, 1: 0 }, b: { 0: [0, 2], 1: [0, 0] } }
    const bothVite = { s: { 0: 0, 1: 3, 2: 0 }, f: { 0: 0, 1: 3 }, b: { 0: [0, 3], 1: [0, 0] } }
    const bothNode = { s: { 0: 0, 1: 2, 2: 1 }, f: { 0: 0, 1: 2 }, b: { 0: [0, 2], 1: [1, 0] } }
    made.table.vite = (url) => ({ ...converted({ column: 3 }), ...structuredClone(url === FILE_B ? onlyVite : bothVite) })
    made.table.node = (url) => ({ ...converted({ column: 0 }), ...structuredClone(url === FILE_C ? onlyNode : bothNode) })
    made.passes = [['', 'ssr', [
      { result: [script(FILE_B, WRAPPER, 777), script(FILE_A, WRAPPER, 1042)] },
      { result: [script(FILE_C, 0, 200), script(FILE_A, 0, 500)] },
    ]]]
    const coverageMap = await made.generateCoverage({ allTestsRun: true })
    expect(made.conversions.map(([, , url, form]) => [url, form])).toEqual([
      [FILE_B, 'vite'], [FILE_A, 'vite'], [FILE_C, 'node'], [FILE_A, 'node'],
    ])
    expect(hitsOf(coverageMap.data[FILE_B])).toEqual(onlyVite)
    expect(hitsOf(coverageMap.data[FILE_C])).toEqual(onlyNode)
    // Hit for hit: what vite's scripts ran plus what Node's ran, and nothing where neither did.
    expect(hitsOf(coverageMap.data[FILE_A])).toEqual({ s: { 0: 0, 1: 5, 2: 1 }, f: { 0: 0, 1: 5 }, b: { 0: [0, 5], 1: [1, 0] } })
    expect(coverageMap.data[FILE_A].twice).toBeUndefined()
    expect(made.twoFormsProblems).toEqual([])
  })

  it('names a file whose two conversions do not list the same items, leaves what Node ran of it out, and fails the run', async () => {
    const made = new TwoForms()
    made.table.vite = () => converted({ column: 3, statements: 4, hits: 2 })
    made.passes = [['', 'ssr', [{ result: [script(FILE_A, WRAPPER, 1042), script(FILE_A, WRAPPER, 500), script(FILE_C, 0, 200)] }]]]
    const coverageMap = await made.generateCoverage({ allTestsRun: true })
    expect(made.twoFormsProblems).toHaveLength(1)
    expect(made.twoFormsProblems[0]).toContain(FILE_A)
    expect(made.twoFormsProblems[0]).toMatch(/statementMap has 3 items read from the file and 4 read from vite's text/)
    expect(made.twoFormsProblems[0]).toMatch(/What Node ran of it is left out of the report, so its figures are too low/)
    expect(made.errors).toEqual([ERROR_PREFIX + made.twoFormsProblems[0]])
    expect(made.logs).toEqual([])
    // Nothing is merged on a guess: the report holds the vite reading alone, not every item twice. The file only
    // Node loaded, converted in the same pass, is still there.
    expect(Object.keys(made.returned.find((entry) => entry.form === 'node').map.data)).toEqual([FILE_C])
    expect(coverageMap.data[FILE_A].twice).toBeUndefined()
    expect(hitsOf(coverageMap.data[FILE_A])).toEqual(hitsOf(converted({ statements: 4, hits: 2 })))
    expect(process.exitCode).toBe(1)
  })

  it('does the same for a file whose two conversions have the same number of items in other places', async () => {
    const made = new TwoForms()
    const shape = { statements: 6 }
    made.table.node = () => converted({ ...shape, starts: { statementMap: lines(1, 2, 3, 4, 5, 6) } })
    made.table.vite = () => converted({ ...shape, hits: 2, starts: { statementMap: [[1, 0], [3, 0], [4, 0], [5, 0], [5, 8], [6, 0]] } })
    made.passes = [['', 'ssr', [{ result: [script(FILE_A, WRAPPER, 1042), script(FILE_A, WRAPPER, 500)] }]]]
    const coverageMap = await made.generateCoverage({ allTestsRun: true })
    expect(made.twoFormsProblems).toHaveLength(1)
    expect(made.twoFormsProblems[0]).toMatch(/statementMap item 1 starts at 2:0 read from the file and at 3:0 read from vite's text/)
    expect(made.returned.find((entry) => entry.form === 'node').map.data).toEqual({})
    expect(coverageMap.data[FILE_A].twice).toBeUndefined()
    expect(coverageMap.data[FILE_A].s).toEqual({ 0: 2, 1: 2, 2: 2, 3: 2, 4: 2, 5: 2 })
    expect(process.exitCode).toBe(1)
  })

  it('fails the run on a negative hit count, naming the file and how many, and says it again after the reports', async () => {
    const made = new TwoForms()
    made.table.vite = () => ({ ...converted({ column: 3 }), b: { 0: [3, -3], 1: [1, -1] } })
    made.passes = [['', 'ssr', [{ result: [script(FILE_A, WRAPPER, 1042)] }]]]
    const coverageMap = await made.generateCoverage({ allTestsRun: true })
    expect(made.twoFormsProblems).toHaveLength(1)
    expect(made.twoFormsProblems[0]).toMatch(/^2 hit count\(s\) below zero in /)
    expect(made.twoFormsProblems[0]).toContain(FILE_A)
    expect(made.errors).toEqual([ERROR_PREFIX + made.twoFormsProblems[0]])
    expect(made.logs).toEqual([])
    expect(process.exitCode).toBe(1)

    process.exitCode = exitCode
    await made.generateReports(coverageMap, true)
    expect(made.events).toEqual(['coverage generated', 'reports written'])
    expect(made.errors).toEqual([ERROR_PREFIX + made.twoFormsProblems[0], ERROR_PREFIX + made.twoFormsProblems[0]])
    expect(process.exitCode).toBe(1)
  })

  it('fails it wherever the negative count is: in a file only Node loaded, and when not every test file ran', async () => {
    const made = new TwoForms()
    made.table.node = () => ({ ...converted(), s: { 0: 1, 1: -1, 2: 1 } })
    made.passes = [['', 'ssr', [{ result: [script(FILE_A, WRAPPER, 1042), script(FILE_C, 0, 200)] }]]]
    await made.generateCoverage({ allTestsRun: false })
    expect(made.twoFormsProblems).toHaveLength(1)
    expect(made.twoFormsProblems[0]).toMatch(/^1 hit count\(s\) below zero in /)
    expect(made.twoFormsProblems[0]).toContain(FILE_C)
    expect(process.exitCode).toBe(1)
  })

  it('puts each problem on a GitHub runner\'s summary too, once, as an ::error annotation', async () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true')
    const made = new TwoForms()
    const odd = 'file:///repo/50%25/a\nb\rc.js'
    made.table.vite = () => ({ ...converted({ column: 3 }), f: { 0: -1, 1: 1 } })
    made.passes = [['', 'ssr', [{ result: [script(FILE_A, WRAPPER, 1042), script(odd, WRAPPER, 9)] }]]]
    const coverageMap = await made.generateCoverage({ allTestsRun: true })
    await made.generateReports(coverageMap, true)
    expect(made.twoFormsProblems).toHaveLength(2)
    expect(made.errors).toHaveLength(4)
    // One line a problem, with what a workflow command cannot carry escaped.
    expect(made.logs).toEqual([
      ANNOTATION + made.twoFormsProblems[0],
      ANNOTATION + made.twoFormsProblems[1].replace('50%25', '50%2525').replace('a\nb\rc', 'a%0Ab%0Dc'),
    ])
    expect(made.logs[1]).not.toMatch(/[\n\r]/)
    expect(ANNOTATION).toBe('::error title=coverage-v8-two-forms::')

    // The next run of the same provider (watch mode) says its own.
    made.logs.length = 0
    await made.generateCoverage({ allTestsRun: true })
    expect(made.logs).toHaveLength(2)
  })

  it('says nothing and leaves the exit code alone on a clean run, and forgets the last run\'s problems', async () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true')
    const made = new TwoForms()
    made.table.vite = () => ({ ...converted({ column: 3 }), f: { 0: -1, 1: 1 } })
    made.passes = [['', 'ssr', [{ result: [script(FILE_A, WRAPPER, 1042)] }]]]
    await made.generateCoverage({ allTestsRun: true })
    expect(made.twoFormsProblems).toHaveLength(1)

    process.exitCode = exitCode
    made.errors.length = 0
    made.logs.length = 0
    made.table.vite = () => converted({ column: 3 })
    const coverageMap = await made.generateCoverage({ allTestsRun: true })
    await made.generateReports(coverageMap, true)
    expect(made.twoFormsProblems).toEqual([])
    expect(made.errors).toEqual([])
    expect(made.logs).toEqual([])
    expect(process.exitCode).toBe(exitCode)
  })

  it('goes back to vite\'s text after a Node conversion that threw', async () => {
    const made = new TwoForms()
    made.table.node = () => { throw new Error('conversion failed') }
    made.passes = [['', 'ssr', [{ result: [script(FILE_A, 0, 500)] }]]]
    await expect(made.generateCoverage({ allTestsRun: true })).rejects.toThrow('conversion failed')
    expect((await made.getSources(FILE_A, async () => ({ code: 'VITE TEXT' }), [])).code).toBe('VITE TEXT')
  })
})

// What the fixture run must report for only-node.js, by the calls required.case.mjs makes: called(1), called(2).
// Held twice: by the real run below, and by V8's own record of that load put through the provider here.
const ONLY_NODE = {
  functions: { called: 2, notCalled: 0 },
  arms: { 10: [[0, 2]] },
  statements: { 10: [2, 0], 11: [2], 15: [0], 18: [1] },
}

describe('V8\'s own record of a module only Node loaded (scripts/fixtures/coverage-two-forms/only-node.v8.json)', () => {
  // The record is the script entry V8 gave for only-node.js in the worker of required.case.mjs, as
  // @vitest/coverage-v8 wrote it into that test file's result in a real run of the fixture (Node v26.4.0): `url` is
  // made a path from the repo root and nothing else is changed. V8 says the same of the same load outside vitest,
  // which is how to cut it again after only-node.js or the calls in required.case.mjs change:
  //   NODE_V8_COVERAGE=<an empty directory> node -e "const m = require(process.argv[1]); m.called(1); m.called(2)" "$PWD/scripts/fixtures/coverage-two-forms/only-node.js"
  // then copy `functions` of the entry whose url ends in only-node.js from the one JSON file in that directory.
  const CUT_AGAIN = `${FIXTURE}/only-node.v8.json is no longer V8's record of ${FIXTURE}/only-node.js as it is: cut it ` +
    'again (the comment above this test says how). '
  const record = JSON.parse(readFileSync(resolve(process.cwd(), `${FIXTURE}/only-node.v8.json`), 'utf8'))
  const url = pathToFileURL(resolve(process.cwd(), record.script.url)).href
  const recorded = { ...record.script, url }

  // A stand-in that READS. It converts only-node.js from V8's ranges as the stock class would: at the one start
  // offset it keeps for the URL, against the text getSources hands it. An item's count is that of the smallest
  // range that holds its first character, added up over the URL's scripts; the else that the `if` does not have
  // gets the `if`'s count less the consequent's.
  const STATEMENTS = ['if (n > 10)', 'return \'big\'', 'return \'small\'', 'return \'never\'', 'module.exports =']
  const FUNCTIONS = ['called', 'notCalled']
  class Reader extends StandIn {
    read({ code, startOffset, scripts }) {
      const place = (needle) => {
        const before = code.slice(0, code.indexOf(needle)).split('\n')
        return { start: { line: before.length, column: before.at(-1).length }, end: {} }
      }
      const smallest = (entry, offset) => entry.functions.flatMap((fn) => fn.ranges)
        .filter((range) => range.startOffset <= offset && offset < range.endOffset)
        .sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset))[0]
      const count = (needle) => scripts.reduce((sum, entry) => sum + (smallest(entry, code.indexOf(needle) + startOffset)?.count ?? 0), 0)
      return {
        statementMap: Object.fromEntries(STATEMENTS.map((needle, i) => [i, place(needle)])),
        fnMap: Object.fromEntries(FUNCTIONS.map((name, i) => [i, { name, loc: place(`function ${name}`) }])),
        branchMap: { 0: { type: 'if', loc: place(STATEMENTS[0]), locations: [place(STATEMENTS[1]), {}] } },
        s: Object.fromEntries(STATEMENTS.map((needle, i) => [i, count(needle)])),
        f: Object.fromEntries(FUNCTIONS.map((name, i) => [i, count(`function ${name}`)])),
        b: { 0: [count(STATEMENTS[1]), count(STATEMENTS[0]) - count(STATEMENTS[1])] },
      }
    }

    async getSources(url, onTransform) {
      const transformed = await onTransform(url)
      const text = readFileSync(fileURLToPath(url), 'utf8')
      return transformed ? { code: `/* vite's text of it */ ${text}` } : { code: text }
    }
  }
  const through = async (Class, entry) => {
    const made = new Class()
    made.passes = [['', 'ssr', [{ result: [entry] }]]]
    const file = (await made.generateCoverage({ allTestsRun: true })).data[url]
    return { made, functions: byName(file), arms: byLine(file.branchMap, file.b), statements: byLine(file.statementMap, file.s) }
  }

  it('is a record of the file as it is, and is Node\'s by the rule', () => {
    expect(recorded.functions[0].ranges[0].endOffset, CUT_AGAIN).toBe(fileLength(url))
    expect(formOf(recorded, fileLength)).toBe('node')
  })

  it('comes out of the provider call for call, with zero where nothing ran', async () => {
    const { made, ...read } = await through(twoForms(Reader), recorded)
    expect(read, CUT_AGAIN).toEqual(ONLY_NODE)
    expect(made.conversions).toEqual([['', 'ssr', url, 'node', { startOffset: 0, scripts: 1 }]])
    expect(made.twoFormsProblems).toEqual([])
  })

  it('comes out the same from a worker that also imported the file, where it carries vite\'s offset', async () => {
    const { made, ...read } = await through(twoForms(Reader), { ...recorded, startOffset: WRAPPER })
    expect(read).toEqual(ONLY_NODE)
    expect(made.conversions).toEqual([['', 'ssr', url, 'node', { startOffset: 0, scripts: 1 }]])
  })

  it('is misread without the provider, against vite\'s text or at vite\'s offset, with no count below zero', async () => {
    // What makes the two tests above mean something: the stand-in does read, and a misreading shows in the counts.
    const text = await through(Reader, recorded)
    expect(text.made.conversions).toEqual([['', 'ssr', url, 'vite', { startOffset: 0, scripts: 1 }]])
    expect(text.statements).not.toEqual(ONLY_NODE.statements)
    const offset = await through(Reader, { ...recorded, startOffset: WRAPPER })
    expect(offset.statements).not.toEqual(ONLY_NODE.statements)
    for (const misread of [text, offset]) {
      const counts = [...Object.values(misread.statements).flat(), ...Object.values(misread.functions), ...Object.values(misread.arms).flat(2)]
      expect(counts.filter((count) => count < 0)).toEqual([])
    }
  })
})

describe('the installed @vitest/coverage-v8', () => {
  it('is the version the provider was read against, with every member it replaces, calling one another as it expects', () => {
    // Asked in a child: the stock class pulls in vitest/node, which a test worker has no business loading.
    const ask = [
      'const { default: provider, OVERRIDES, CALLS, STOCK_PROVIDER, STOCK_CLASS } = await import(process.env.PROVIDER_MODULE)',
      "const { default: stock } = await import('@vitest/coverage-v8')",
      'const facts = { importable: false, isClass: false, missing: [], uncalled: [], workerSide: [] }',
      'let Stock',
      'try { Stock = (await import(STOCK_PROVIDER))[STOCK_CLASS]; facts.importable = true } catch (error) { facts.error = String(error) }',
      "facts.isClass = typeof Stock === 'function'",
      'if (facts.isClass) {',
      "  facts.missing = OVERRIDES.filter((name) => typeof Stock.prototype[name] !== 'function')",
      "  facts.uncalled = CALLS.filter(([from, call]) => !String(Stock.prototype[from] || '').includes(call))",
      '  const made = await provider.getProvider()',
      '  facts.made = { isStock: made instanceof Stock, name: made.name, stockName: new Stock().name, version: made.version }',
      '}',
      "const worker = ['startCoverage', 'takeCoverage', 'stopCoverage']",
      "facts.workerSide = worker.filter((name) => typeof stock[name] !== 'function' || provider[name] !== stock[name])",
      // A worker of a run with projects evaluates the module twice: a second copy, and still the one stock state.
      "const again = (await import(process.env.PROVIDER_MODULE + '?a-second-copy')).default",
      'facts.twice = { copies: again !== provider, workerSide: worker.filter((name) => again[name] !== stock[name]) }',
      'process.stdout.write(JSON.stringify(facts))',
    ].join('\n')
    const facts = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', ask], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 120000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, PROVIDER_MODULE: pathToFileURL(HERE).href },
    }))
    expect(facts.importable, `${REREAD}${STOCK_PROVIDER} can no longer be imported: ${facts.error}`).toBe(true)
    expect(facts.isClass, `${REREAD}${STOCK_PROVIDER} no longer exports the class ${STOCK_CLASS}.`).toBe(true)
    expect(facts.made.version, `${REREAD}It was read against ${READ_AT} and this is another version. When the header ` +
      'has been re-read against it and the tests below are green, move READ_AT in the provider to it.').toBe(READ_AT)
    expect(facts.missing, `${REREAD}${STOCK_CLASS} no longer has these methods, which the provider replaces: ${facts.missing}.`).toEqual([])
    expect(facts.uncalled, `${REREAD}These calls are gone from ${STOCK_CLASS} (method, call): ${JSON.stringify(facts.uncalled)}.`).toEqual([])
    expect([facts.made.isStock, facts.made.name, facts.made.stockName], `${REREAD}getProvider() no longer returns the ` +
      'stock class under the stock name \'v8\', which is what keeps a one-project run\'s workers on the stock module.')
      .toEqual([true, 'v8', 'v8'])
    expect(facts.workerSide, `${REREAD}The module's worker side is no longer the stock one: ${facts.workerSide}.`).toEqual([])
    expect(facts.twice, `${REREAD}A second copy of the module, as a worker of a run with projects holds, no longer ` +
      'carries the stock module\'s own three functions.').toEqual({ copies: true, workerSide: [] })
  }, 120000)

  it('is what the provider module hands the workers, with its own getProvider', () => {
    expect(Object.keys(provider).sort()).toEqual(['getProvider', 'startCoverage', 'stopCoverage', 'takeCoverage'])
  })
})

// One run of the fixture's cases under the real vitest.config.ts. `one project` is the unit run's shape without
// the trial key, where only the main process evaluates the provider module. `two projects` is its shape with the
// key: every worker evaluates the module too and takes its coverage through the module's own default export, one
// project runs under jsdom, and forms.js is imported in one project and required in the other. Both must report
// every count the same, by the calls the cases make.
describe.each([
  ['one project', 'vitest.config.mjs'],
  ['two projects', 'vitest.projects.config.mjs'],
])('a real coverage run of scripts/fixtures/coverage-two-forms, %s', (_, config) => {
  let reports
  let run
  let said
  let final
  beforeAll(() => {
    reports = mkdtempSync(join(tmpdir(), 'coverage-two-forms-'))
    run = spawnSync(process.execPath, [
      resolve(process.cwd(), 'node_modules/vitest/vitest.mjs'), 'run', '--config', `${FIXTURE}/${config}`,
      '--coverage', `--coverage.reportsDirectory=${reports}`,
    ], { cwd: process.cwd(), encoding: 'utf8', timeout: 240000, env: { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: '1' } })
    said = `${REREAD}The run of ${FIXTURE}/${config} said:\n${run.stdout}\n${run.stderr}`
    try {
      final = Object.fromEntries(Object.entries(JSON.parse(readFileSync(join(reports, 'coverage-final.json'), 'utf8')))
        .map(([file, data]) => [relative(process.cwd(), file), data]))
    } catch {
      final = {}
    }
  }, 240000)
  afterAll(() => rmSync(reports, { recursive: true, force: true }))
  const read = (name) => {
    const file = final[`${FIXTURE}/${name}`]
    return { functions: byName(file), arms: byLine(file.branchMap, file.b), statements: byLine(file.statementMap, file.s) }
  }

  it('passes, says nothing of its own, and reports the four modules the cases load', () => {
    expect(run.status, said).toBe(0)
    expect(run.stdout + run.stderr, said).not.toContain(ERROR_PREFIX)
    expect(run.stdout, said).toMatch(/Tests +7 passed \(7\)/)
    expect(Object.keys(final).sort(), said)
      .toEqual(['forms.js', 'late.mjs', 'only-node.js', 'only-vite.mjs'].map((name) => `${FIXTURE}/${name}`))
  })

  it('reads a module loaded through vite, by Node, and both ways in one worker call for call', () => {
    // forms.js is imported by one case, required by another, and both by a third; the calls each case makes are
    // in the cases. The stock provider reads the same run as byNode 0 and bothWays 1, with an arm at -3.
    // Twelve statements, not twenty-four: the two conversions merged item for item, though one starts LABELS'
    // value on line 15 and the other on line 14, and one starts the `&&` of line 28 where the other starts its
    // `if`. Line 14 is run once by each of the four loads, like module.exports on line 36. Nothing calls never():
    // its function, its statement and both its arms stay at zero.
    expect(read('forms.js'), said).toEqual({
      functions: { throughVite: 4, byNode: 3, bothWays: 2, never: 0 },
      arms: { 18: [[3, 1]], 23: [[1, 2]], 28: [[2, 0], [2, 1, 2], [1, 1]], 33: [[0, 0]] },
      statements: { 14: [4], 18: [4, 3], 19: [1], 23: [3, 1], 24: [2], 28: [2, 2], 29: [0], 33: [0], 36: [4] },
    })
  })

  it('reads a module only vite loaded call for call, with zero where nothing ran', () => {
    // only-vite.mjs: called(1), called(2), called(3) in imported.case.mjs. `return 'big'` and its arm never run.
    expect(read('only-vite.mjs'), said).toEqual({
      functions: { called: 3, notCalled: 0 },
      arms: { 5: [[0, 3]] },
      statements: { 5: [3, 0], 6: [3], 10: [0] },
    })
  })

  it('reads a module only Node loaded call for call, with zero where nothing ran', () => {
    // No vite conversion of only-node.js exists in the run, so this is the Node conversion and nothing else: the
    // case in which the stock provider read lambda/daily-plan/rainLog.js as 103 covered items where this one reads
    // 94, and reads notCalled here as entered.
    expect(read('only-node.js'), said).toEqual(ONLY_NODE)
  })

  it('reads a module one worker left half loaded as the one finished load it had', () => {
    // late.mjs is loaded to the end by imported.case.mjs and left at its first import by pending.case.mjs, whose
    // script of it has no start offset. Read as Node's, at 0 against the file, that script adds a hit to every
    // line here: early 2, late 3.
    expect(read('late.mjs'), said).toEqual({ functions: { early: 1, late: 2 }, arms: {}, statements: { 5: [1], 9: [2], 12: [1] } })
  })
})

describe('where it is switched on (vitest.config.ts)', () => {
  const config = readFileSync(resolve(process.cwd(), 'vitest.config.ts'), 'utf8')
  const code = (name) => readFileSync(resolve(process.cwd(), `${FIXTURE}/${name}`), 'utf8')
    .split('\n').filter((line) => !line.startsWith('//')).join('\n')

  it('is the one coverage provider, named as a custom module', () => {
    expect(config.match(/^\s*provider: .*$/gm)).toEqual(["      provider: 'custom',"])
    expect(config.match(/^\s*customProviderModule: .*$/gm))
      .toEqual(["      customProviderModule: './scripts/ci-telemetry/coverage-v8-two-forms.mjs',"])
  })

  it('is the config both fixture runs build on, and neither names a provider of its own', () => {
    const one = code('vitest.config.mjs')
    expect(one).toMatch(/^import base from '\.\.\/\.\.\/\.\.\/vitest\.config\.ts'$/m)
    expect(one).toMatch(/\.\.\.test\.coverage,/)
    expect(one).not.toMatch(/provider/i)
    const two = code('vitest.projects.config.mjs')
    expect(two).toMatch(/^import one, \{ DIR \} from '\.\/vitest\.config\.mjs'$/m)
    expect(two).toMatch(/^ {2}\.\.\.one,$/m)
    expect(two.match(/name: '\w+', environment: '\w+'/g)).toEqual(["name: 'dom', environment: 'jsdom'", "name: 'node', environment: 'node'"])
    expect(two).not.toMatch(/provider|coverage/i)
  })
})

describe('where else it is switched on (scripts/ci-telemetry/a3-exit.config.mjs)', () => {
  it('is the provider of the A3 exit checks, named as vitest.config.ts names it', () => {
    // That config writes a coverage block of its own and so inherits nothing from vitest.config.ts. Its E2 check
    // compares what two environments covered in every module they load: on the stock provider it compared two
    // draws of lambda/daily-plan/engine.js and read a difference or not by which were drawn.
    const exit = readFileSync(resolve(process.cwd(), 'scripts/ci-telemetry/a3-exit.config.mjs'), 'utf8')
    expect(exit.match(/^\s*provider: .*$/gm)).toEqual(["          provider: 'custom',"])
    expect(exit.match(/^\s*customProviderModule: .*$/gm))
      .toEqual(["          customProviderModule: './scripts/ci-telemetry/coverage-v8-two-forms.mjs',"])
  })
})
