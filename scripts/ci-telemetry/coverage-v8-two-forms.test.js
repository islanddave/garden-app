// The unit run's coverage provider (coverage-v8-two-forms.mjs): which form it takes a script to be in, how each form
// is converted, what it refuses, and the two tests that hold it to the installed vitest.
//
// The provider subclasses the INSTALLED @vitest/coverage-v8 provider and replaces five of its methods, so it leans
// on how those five call one another, and none of that is public API. A vitest upgrade must not be able to break
// it quietly. `the installed @vitest/coverage-v8` asks the package itself for every member and call the provider
// names, and `a real coverage run` puts a module that is loaded through vite, by Node, and both ways in one worker,
// and a second that one worker leaves half loaded, through `vitest run --coverage` under the real vitest.config.ts
// and reads every hit count back. When either is red after an upgrade, or on another Node, re-read the provider's
// header against node_modules/@vitest/coverage-v8/dist/provider.js.
//
// Everything above those two runs against a stand-in for the stock class, so each rule fails by name.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import provider, {
  fileLength, formOf, splitForms, whyNotSameItems, adoptMaps, negativeHits, twoForms,
  STOCK_PROVIDER, STOCK_CLASS, OVERRIDES, CALLS, ERROR_PREFIX,
} from './coverage-v8-two-forms.mjs'

const REREAD = 'coverage-v8-two-forms.mjs leans on the inside of @vitest/coverage-v8 and the installed one no longer ' +
  'matches what it was written against. Re-read the header of scripts/ci-telemetry/coverage-v8-two-forms.mjs ' +
  'against node_modules/@vitest/coverage-v8/dist/provider.js before trusting any coverage figure. '

// From the working directory, as the tests beside this one find the repo: vite rewrites a URL built on import.meta.url.
const HERE = resolve(process.cwd(), 'scripts/ci-telemetry/coverage-v8-two-forms.mjs')
const WRAPPER = 209
let dir
let FILE_A
let FILE_B
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'coverage-two-forms-unit-'))
  writeFileSync(join(dir, 'a.js'), 'a'.repeat(500))
  writeFileSync(join(dir, 'b.js'), 'b'.repeat(300))
  FILE_A = pathToFileURL(join(dir, 'a.js')).href
  FILE_B = pathToFileURL(join(dir, 'b.js')).href
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

// The istanbul data of one converted file. `column` stands for what differs between a list parsed from the file
// and the same list read through a source map: where on its line an item starts and ends.
const loc = (line, column) => ({ start: { line, column }, end: { line, column: column + 9 } })
const converted = ({ statements = 3, fns = ['outer', 'inner'], branches = [['if', 2], ['cond-expr', 2]], column = 0, hits = 1 } = {}) => ({
  statementMap: Object.fromEntries(Array.from({ length: statements }, (_, i) => [i, loc(i + 1, column)])),
  fnMap: Object.fromEntries(fns.map((name, i) => [i, { name, decl: loc(i + 1, column), loc: loc(i + 1, column) }])),
  branchMap: Object.fromEntries(branches.map(([type, arms], i) => [i, {
    type, loc: loc(i + 1, column), locations: Array.from({ length: arms }, () => loc(i + 1, column)),
  }])),
  s: Object.fromEntries(Array.from({ length: statements }, (_, i) => [i, hits])),
  f: Object.fromEntries(fns.map((_, i) => [i, hits])),
  b: Object.fromEntries(branches.map(([, arms], i) => [i, Array(arms).fill(hits)])),
})

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

  it.each([
    ['one statement more', { statements: 4 }, /statementMap has 3 items read from the file and 4 read from vite's text/],
    ['one function fewer', { fns: ['outer'] }, /fnMap has 2 items read from the file and 1 read from vite's text/],
    ['one branch more', { branches: [['if', 2], ['cond-expr', 2], ['if', 2]] }, /branchMap has 2 items read from the file and 3/],
    ['a function of another name', { fns: ['outer', 'other'] }, /function 1 \(line 2\) is inner read from the file and other read from vite's text/],
    ['a branch of another kind', { branches: [['if', 2], ['binary-expr', 2]] }, /branch 1 \(line 2\) is cond-expr with 2 arms read from the file and binary-expr with 2/],
    ['a branch with another number of arms', { branches: [['if', 2], ['cond-expr', 3]] }, /branch 1 \(line 2\) is cond-expr with 2 arms read from the file and cond-expr with 3/],
  ])('does not, and says why, when vite\'s list has %s', (_, change, why) => {
    const node = converted()
    const kept = { ...node }
    const vite = converted({ column: 3, ...change })
    expect(whyNotSameItems(node, vite)).toMatch(why)
    expect(adoptMaps(node, vite)).toMatch(why)
    expect(node.statementMap).toBe(kept.statementMap)
    expect(node.fnMap).toBe(kept.fnMap)
    expect(node.branchMap).toBe(kept.branchMap)
  })
})

const mapOf = (files) => ({
  data: files,
  files: () => Object.keys(files),
  fileCoverageFor: (file) => ({ data: files[file] }),
})

describe('negative hit counts', () => {
  it('are counted per file over statements, functions and every branch arm', () => {
    const found = negativeHits(mapOf({
      '/repo/clean.js': { s: { 0: 0, 1: 7 }, f: { 0: 0 }, b: { 0: [0, 3] } },
      '/repo/statement.js': { s: { 0: 1, 1: -1 }, f: { 0: 1 }, b: {} },
      '/repo/function.js': { s: { 0: 1 }, f: { 0: -4, 1: 2 }, b: {} },
      '/repo/arms.js': { s: {}, f: {}, b: { 0: [3, -3], 1: [-1, -2, 0] } },
    }))
    expect(found).toEqual([['/repo/statement.js', 1], ['/repo/function.js', 1], ['/repo/arms.js', 3]])
  })

  it('are none in a map that has none, zero included', () => {
    expect(negativeHits(mapOf({ '/repo/clean.js': { s: { 0: 0 }, f: { 0: 0 }, b: { 0: [0, 0] } } }))).toEqual([])
    expect(negativeHits(mapOf({}))).toEqual([])
  })
})

// A stand-in for the stock provider class: the calls the real one makes between the five methods (the provider's
// header lists them), and nothing else of it. What a script "converts" to comes from `table`, by form, and the
// form is told from the text getSources hands back: vite's when the transform answered, the file's when it did not.
// Like the stock class it keeps ONE start offset per URL, the last it was handed; it also says how many scripts of
// the URL it was handed in the pass.
class StandIn {
  name = 'v8'
  errors = []
  ctx = { logger: { error: (line) => this.errors.push(line) } }
  passes = []
  table = { vite: () => converted({ column: 3 }), node: () => converted({ column: 0 }) }
  conversions = []
  returned = []
  events = []

  async generateCoverage() {
    const merged = []
    let scripts = []
    await this.readCoverageFiles({
      onFileRead: (coverage) => scripts.push(...coverage.result),
      onFinished: async (project, environment) => {
        merged.push(await this.convertCoverage({ result: scripts }, project, environment))
        scripts = []
      },
      onDebug: () => {},
    })
    this.events.push('coverage generated')
    return mapOf(Object.assign({}, ...merged.map((map) => map.data)))
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
    for (const { url, startOffset } of coverage.result) {
      perUrl.set(url, { startOffset, scripts: (perUrl.get(url)?.scripts ?? 0) + 1 })
    }
    const files = {}
    for (const [url, { startOffset, scripts }] of perUrl) {
      const { code } = await this.getSources(url, async () => ({ code: 'VITE TEXT', map: {} }), [])
      const form = code === 'VITE TEXT' ? 'vite' : 'node'
      this.conversions.push([project, environment, url, form, { startOffset, scripts }])
      files[url] = this.table[form](url)
    }
    const map = mapOf(files)
    this.returned.push({ form: this.conversions.at(-1)?.[3], map })
    return map
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
  afterEach(() => { process.exitCode = exitCode })

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

  it('names a file whose two conversions do not list the same items, merges nothing on a guess, and fails the run', async () => {
    const made = new TwoForms()
    made.table.vite = () => converted({ column: 3, statements: 4 })
    made.passes = [['', 'ssr', [{ result: [script(FILE_A, WRAPPER, 1042), script(FILE_A, WRAPPER, 500)] }]]]
    await made.generateCoverage({ allTestsRun: true })
    expect(made.twoFormsProblems).toHaveLength(1)
    expect(made.twoFormsProblems[0]).toContain(FILE_A)
    expect(made.twoFormsProblems[0]).toMatch(/statementMap has 3 items read from the file and 4 read from vite's text/)
    expect(made.errors).toEqual([ERROR_PREFIX + made.twoFormsProblems[0]])
    expect(made.returned.find((entry) => entry.form === 'node').map.data[FILE_A].statementMap[0].start.column).toBe(0)
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
    expect(process.exitCode).toBe(1)

    process.exitCode = exitCode
    await made.generateReports(coverageMap, true)
    expect(made.events).toEqual(['coverage generated', 'reports written'])
    expect(made.errors).toEqual([ERROR_PREFIX + made.twoFormsProblems[0], ERROR_PREFIX + made.twoFormsProblems[0]])
    expect(process.exitCode).toBe(1)
  })

  it('says nothing and leaves the exit code alone on a clean run, and forgets the last run\'s problems', async () => {
    const made = new TwoForms()
    made.table.vite = () => ({ ...converted({ column: 3 }), f: { 0: -1, 1: 1 } })
    made.passes = [['', 'ssr', [{ result: [script(FILE_A, WRAPPER, 1042)] }]]]
    await made.generateCoverage({ allTestsRun: true })
    expect(made.twoFormsProblems).toHaveLength(1)

    process.exitCode = exitCode
    made.errors.length = 0
    made.table.vite = () => converted({ column: 3 })
    const coverageMap = await made.generateCoverage({ allTestsRun: true })
    await made.generateReports(coverageMap, true)
    expect(made.twoFormsProblems).toEqual([])
    expect(made.errors).toEqual([])
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

describe('the installed @vitest/coverage-v8', () => {
  it('still has every member the provider replaces, calling one another as the provider expects', () => {
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
      "facts.workerSide = ['startCoverage', 'takeCoverage', 'stopCoverage'].filter((name) => typeof stock[name] !== 'function' || provider[name] !== stock[name])",
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
    expect(facts.missing, `${REREAD}${STOCK_CLASS} no longer has these methods, which the provider replaces: ${facts.missing}.`).toEqual([])
    expect(facts.uncalled, `${REREAD}These calls are gone from ${STOCK_CLASS} (method, call): ${JSON.stringify(facts.uncalled)}.`).toEqual([])
    expect([facts.made.isStock, facts.made.name, facts.made.stockName], `${REREAD}getProvider() no longer returns the ` +
      'stock class under the stock name \'v8\', which is what keeps the workers on the stock module.').toEqual([true, 'v8', 'v8'])
    expect(facts.workerSide, `${REREAD}The module's worker side is no longer the stock one: ${facts.workerSide}.`).toEqual([])
  }, 120000)

  it('is what the provider module hands the workers, with its own getProvider', () => {
    expect(Object.keys(provider).sort()).toEqual(['getProvider', 'startCoverage', 'stopCoverage', 'takeCoverage'])
  })
})

describe('a real coverage run (scripts/fixtures/coverage-two-forms)', () => {
  const FIXTURE = 'scripts/fixtures/coverage-two-forms'
  const byLine = (map, hits, lineOf) => {
    const lines = {}
    for (const [key, item] of Object.entries(map)) (lines[lineOf(item)] ??= []).push(hits[key])
    return lines
  }
  const byName = (file) => Object.fromEntries(Object.entries(file.fnMap).map(([key, fn]) => [fn.name, file.f[key]]))
  let reports
  let run
  let said
  let final
  beforeAll(() => {
    reports = mkdtempSync(join(tmpdir(), 'coverage-two-forms-'))
    run = spawnSync(process.execPath, [
      resolve(process.cwd(), 'node_modules/vitest/vitest.mjs'), 'run', '--config', `${FIXTURE}/vitest.config.mjs`,
      '--coverage', `--coverage.reportsDirectory=${reports}`,
    ], { cwd: process.cwd(), encoding: 'utf8', timeout: 240000, env: { PATH: process.env.PATH, HOME: process.env.HOME } })
    said = `${REREAD}The run of ${FIXTURE} said:\n${run.stdout}\n${run.stderr}`
    try {
      final = Object.fromEntries(Object.entries(JSON.parse(readFileSync(join(reports, 'coverage-final.json'), 'utf8')))
        .map(([file, data]) => [relative(process.cwd(), file), data]))
    } catch {
      final = {}
    }
  }, 240000)
  afterAll(() => rmSync(reports, { recursive: true, force: true }))

  it('passes, says nothing of its own, and reports the two modules the cases load', () => {
    expect(run.status, said).toBe(0)
    expect(run.stdout + run.stderr, said).not.toContain(ERROR_PREFIX)
    expect(Object.keys(final).sort(), said).toEqual([`${FIXTURE}/forms.js`, `${FIXTURE}/late.mjs`])
  })

  it('reads a module loaded through vite, by Node, and both ways in one worker call for call', () => {
    // forms.js is imported by one case, required by another, and both by a third; the calls each case makes are
    // in the cases. The stock provider reads the same run as throughVite 0, byNode 0, with an arm at -3.
    const forms = final[`${FIXTURE}/forms.js`]
    expect(byName(forms), said).toEqual({ throughVite: 4, byNode: 3, bothWays: 2, never: 0 })
    expect(byLine(forms.branchMap, forms.b, (branch) => branch.loc.start.line), said)
      .toEqual({ 8: [[3, 1]], 13: [[1, 2]], 18: [[1, 1]] })
    // Nine statements, not eighteen: the two conversions merged item for item. Line 25 is module.exports, run
    // once by each of the four loads.
    expect(byLine(forms.statementMap, forms.s, (statement) => statement.start.line), said)
      .toEqual({ 8: [4, 3], 9: [1], 13: [3, 1], 14: [2], 18: [2], 22: [0], 25: [4] })
  })

  it('reads a module one worker left half loaded as the one finished load it had', () => {
    // late.mjs is loaded to the end by imported.case.mjs and left at its first import by pending.case.mjs, whose
    // script of it has no start offset. Read as Node's, at 0 against the file, that script adds a hit to every
    // line here: early 2, late 3.
    const late = final[`${FIXTURE}/late.mjs`]
    expect(byName(late), said).toEqual({ early: 1, late: 2 })
    expect(byLine(late.statementMap, late.s, (statement) => statement.start.line), said).toEqual({ 5: [1], 9: [2], 12: [1] })
  })
})

describe('where it is switched on (vitest.config.ts)', () => {
  const config = readFileSync(resolve(process.cwd(), 'vitest.config.ts'), 'utf8')

  it('is the one coverage provider, named as a custom module', () => {
    expect(config.match(/^\s*provider: .*$/gm)).toEqual(["      provider: 'custom',"])
    expect(config.match(/^\s*customProviderModule: .*$/gm))
      .toEqual(["      customProviderModule: './scripts/ci-telemetry/coverage-v8-two-forms.mjs',"])
  })

  it('is the config the fixture run builds on', () => {
    const fixture = readFileSync(resolve(process.cwd(), 'scripts/fixtures/coverage-two-forms/vitest.config.mjs'), 'utf8')
    const code = fixture.split('\n').filter((line) => !line.startsWith('//')).join('\n')
    expect(code).toMatch(/^import base from '\.\.\/\.\.\/\.\.\/vitest\.config\.ts'$/m)
    expect(code).toMatch(/\.\.\.test\.coverage,/)
    expect(code).not.toMatch(/provider/i)
  })
})
