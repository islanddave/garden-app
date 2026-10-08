// The unit run's coverage provider (vitest.config.ts, `coverage.customProviderModule`): the installed
// @vitest/coverage-v8 provider with one thing changed, how a source file that reached V8 in TWO FORMS is converted.
// Ledger BUG-ENGINECOVERAGETWOREADINGS-001.
//
// THE DEFECT. A module under lambda/daily-plan/ is compiled twice under one URL. A test file that imports it gets
// vite's text of it (plugin-react reprints .js files, so not the file's text) behind vitest's wrapper; a module
// that reaches it by `require` (line 6 of lambda/daily-plan/handler.js requires engine.js), or a test that loads it
// with createRequire, gets the file's own text, compiled by Node. The stock provider merges every script of a URL
// into one, keeps ONE start offset for it (that of whichever per-test-file coverage file it read last, and it reads
// them up to twenty at a time, in the order the disk answers) and converts the merged ranges against vite's text.
// So one tree read engine.js as 1,214 or 1,257 covered items by draw where 1,325 were covered (the 59 test files
// that load it), read handler.js `run()` as never entered where the tests enter it hundreds of times, and left
// negative hit counts in every reading.
//
// WHAT THIS DOES, all of it in the main process when the run ends:
//   1. each per-test-file result is split into the scripts vite compiled and the scripts Node compiled
//      (splitForms, formOf). A script is Node's when its outermost range ends at the file's own length. The start
//      offset vitest gives it does not say: a file loaded both ways in ONE worker gets vite's offset on both
//      scripts, because vitest looks the offset up by path, and a module still being evaluated when the worker's
//      coverage is taken gets none though it is vite's (src/lib/harvestWindows.js, in two test files of the suite);
//   2. vite's scripts go through the stock provider, one project and environment at a time, untouched but for
//      those offset-less ones, which take the offset of the other modules of their worker. Left at 0 they would
//      decide the offset of the whole file whenever their result happened to be read last;
//   3. Node's scripts are then converted on their own, at offset 0, against the file as it is on disk;
//   4. a file converted both ways holds two lists of the same statements, functions and branches whose end columns
//      differ by a character here and there (one list is read through vite's source map, the other parsed), and
//      istanbul merges by exact position: left alone, engine.js came out as 2,281 items for 1,374. So the Node
//      conversion takes the item maps of the vite one before the two merge (adoptMaps), which it may only when
//      the two lists hold the same number of statements, functions and branches, every function under the same
//      name and every branch of the same kind with the same number of arms (whyNotSameItems). A file that fails
//      that is named and the run fails: nothing is merged on a guess;
//   5. no hit count in the finished map may be negative (negativeHits). A count below zero is what ranges read
//      against a text they were not counted in look like: every mixed reading of the stock provider had some, no
//      conversion per form has had one. It is the tripwire for whatever this file does not foresee, and it sits
//      here so that it runs wherever coverage does, with no workflow step of its own.
// A failure of 4 or 5 is reported the way vitest reports a coverage threshold: an ERROR line and exit code 1, after
// the reports are written, with the test summary intact.
//
// The worker side is the stock one. The class keeps the stock `name`, 'v8', and vitest hands the workers the
// provider's resolved options, so they load @vitest/coverage-v8 themselves; were they ever to load this module
// instead, its default export carries the stock startCoverage / takeCoverage / stopCoverage unchanged.
//
// WHAT IT LEANS ON INSIDE VITEST (read in 4.1.11). None of it is public API, so coverage-v8-two-forms.test.js holds
// it to the installed package twice: it asks the package for each member and each call named here, and it puts a
// module loaded both ways through a real `vitest run --coverage` and reads every hit count back.
//   - `@vitest/coverage-v8/dist/provider.js` can be imported and exports the class `V8CoverageProvider`;
//   - its generateCoverage() calls this.readCoverageFiles({ onFileRead, onFinished, onDebug }), folds every
//     onFileRead(coverage) into one merged list and converts that list with this.convertCoverage(merged, project,
//     environment) on each onFinished(project, environment), then starts a new list;
//   - readCoverageFiles() (BaseCoverageProvider, in vitest/node) calls onFileRead once per per-test-file result and
//     onFinished once per project and environment;
//   - convertCoverage() asks this.getSources(url, onTransform, functions) for the text of each script, reads the
//     script at its `startOffset`, and returns an istanbul coverage map (files(), fileCoverageFor(file).data);
//   - getSources() returns the file's own text, and no source map, when the transform it is handed resolves null;
//   - a script entry is { url, startOffset, functions: [{ ranges: [{ startOffset, endOffset, count }] }] } with the
//     script's outermost range first. `startOffset` is looked up by PATH among the modules the worker has finished
//     evaluating: the wrapper's length, the same for every module of a worker, and 0 when the path is not there
//     (@vitest/coverage-v8/dist/index.js takeCoverage, vitest/dist/module-evaluator.js);
//   - Node compiles a file it loads from the file's own text, so that script's outermost range ends at the file's
//     length in characters (Node 26.4.0; the fixture run would fail on a Node where it did not);
//   - generateReports(coverageMap, allTestsRun) writes the reports and checks the thresholds, and this.ctx.logger
//     prints.
// Re-read this file against those on any vitest or @vitest/coverage-v8 upgrade.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import stock from '@vitest/coverage-v8'

export const STOCK_PROVIDER = '@vitest/coverage-v8/dist/provider.js'
export const STOCK_CLASS = 'V8CoverageProvider'
// The stock methods this replaces. Each replacement calls the one it replaces, and they are every member of the
// stock class this file touches; CALLS is which of them the stock class must still call from which.
export const OVERRIDES = ['generateCoverage', 'generateReports', 'readCoverageFiles', 'convertCoverage', 'getSources']
export const CALLS = [
  ['generateCoverage', 'this.readCoverageFiles('],
  ['generateCoverage', 'this.convertCoverage('],
  ['convertCoverage', 'this.getSources('],
  ['convertCoverage', 'startOffset'],
]
export const ERROR_PREFIX = 'ERROR: coverage-v8-two-forms: '

const ITEM_MAPS = ['statementMap', 'fnMap', 'branchMap']
const HERE = 'scripts/ci-telemetry/coverage-v8-two-forms.mjs'

// The length, in the characters V8 counts, of the file a script URL names; -1 when it cannot be read.
export function fileLength(url) {
  try {
    return readFileSync(fileURLToPath(url), 'utf8').length
  } catch {
    return -1
  }
}

// Which form a script is in:
//   'node'     Node compiled the file's own text: its outermost range ends at the file's own length, whatever start
//              offset it carries. (vite's text of a file behind the wrapper is always longer than the file.)
//   'vite'     vitest compiled vite's text behind its wrapper and recorded the wrapper's length as the start offset;
//   'pending'  vite's text too, with no offset recorded. vitest records a module's offset when the module has
//              finished evaluating, and this one had not when the worker's coverage was taken: a lazy import()
//              nobody waited for, stopped at one of its own imports.
export function formOf(script, lengthOf) {
  if (script.functions[0]?.ranges[0]?.endOffset === lengthOf(script.url)) return 'node'
  return script.startOffset ? 'vite' : 'pending'
}

// One per-test-file result as two: the scripts Node compiled, at offset 0, and the scripts vitest compiled, as they
// are but for a pending one, which takes the offset of the other modules of its worker (one wrapper, one length).
export function splitForms(coverage, lengthOf) {
  const vite = []
  const node = []
  const wrapper = coverage.result.find((script) => script.startOffset)?.startOffset
  for (const script of coverage.result) {
    const form = formOf(script, lengthOf)
    if (form === 'node') node.push({ ...script, startOffset: 0 })
    else if (form === 'pending' && wrapper) vite.push({ ...script, startOffset: wrapper })
    else vite.push(script)
  }
  return { vite: { ...coverage, result: vite }, node: { ...coverage, result: node } }
}

const lineOf = (item) => (item.loc || item).start.line
// The item maps of one converted file, and `b` for the number of arms each branch has.
const itemMapsOf = ({ statementMap, fnMap, branchMap, b }) => ({ statementMap, fnMap, branchMap, b })

// Why the Node conversion of a file cannot take the vite conversion's item maps, or null when it can. Both lists
// are one walk of the same program in source order, so they are held to what a reprint leaves alone: the same
// number of statements, functions and branches, every function with its opposite number's name, every branch with
// its opposite number's kind and number of arms. Positions are NOT compared: measured on the eleven files of
// lambda/daily-plan converted both ways, vite's source map moves the start of 2 to 33 items a file by a few
// columns, one of them (a `const x =` whose value starts on the next line) by a line, and leaves most end columns
// empty.
export function whyNotSameItems(node, vite) {
  for (const map of ITEM_MAPS) {
    const [inFile, inVite] = [Object.keys(node[map]).length, Object.keys(vite[map]).length]
    if (inFile !== inVite) return `${map} has ${inFile} items read from the file and ${inVite} read from vite's text`
  }
  for (const [key, fn] of Object.entries(node.fnMap)) {
    const other = vite.fnMap[key]
    if (!other || fn.name !== other.name) {
      return `function ${key} (line ${lineOf(fn)}) is ${fn.name} read from the file and ${other?.name} read from ` +
        'vite\'s text'
    }
  }
  for (const [key, branch] of Object.entries(node.branchMap)) {
    const other = vite.branchMap[key]
    if (!other || branch.type !== other.type || node.b[key].length !== vite.b[key]?.length) {
      return `branch ${key} (line ${lineOf(branch)}) is ${branch.type} with ${node.b[key].length} arms read from ` +
        `the file and ${other?.type} with ${vite.b[key]?.length} read from vite's text`
    }
  }
  return null
}

// Give the Node conversion of a file the vite conversion's item maps, so that istanbul's merge adds the two hit
// lists item for item. Returns null when done, or why it was not.
export function adoptMaps(node, vite) {
  const why = whyNotSameItems(node, vite)
  if (why) return why
  for (const map of ITEM_MAPS) node[map] = vite[map]
  return null
}

// [[file, how many of its hit counts are below zero]] for every file of an istanbul coverage map that has any.
export function negativeHits(coverageMap) {
  const found = []
  for (const file of coverageMap.files()) {
    const { s, f, b } = coverageMap.fileCoverageFor(file).data
    const hits = [...Object.values(s), ...Object.values(f), ...Object.values(b).flat()]
    const negative = hits.filter((count) => count < 0).length
    if (negative > 0) found.push([file, negative])
  }
  return found
}

// The stock provider class, converting each source form on its own. A function of the class so that the tests can
// hand it a stand-in.
export function twoForms(StockProvider) {
  return class TwoFormsCoverageProvider extends StockProvider {
    twoFormsProblems = []
    #nodePass = false
    #viteMaps = new Map()
    #lengths = new Map()

    #lengthOf = (url) => {
      if (!this.#lengths.has(url)) this.#lengths.set(url, fileLength(url))
      return this.#lengths.get(url)
    }

    #report() {
      if (this.twoFormsProblems.length === 0) return
      for (const problem of this.twoFormsProblems) this.ctx.logger.error(ERROR_PREFIX + problem)
      process.exitCode = 1
    }

    async generateCoverage(options) {
      this.twoFormsProblems = []
      this.#viteMaps = new Map()
      this.#lengths = new Map()
      const coverageMap = await super.generateCoverage(options)
      for (const [file, negative] of negativeHits(coverageMap)) {
        this.twoFormsProblems.push(`${negative} hit count(s) below zero in ${file}. V8's ranges for it were read ` +
          `against a text they were not counted in, so its figures are wrong. See ${HERE}.`)
      }
      this.#report()
      return coverageMap
    }

    // Said again after the coverage table, where vitest prints a missed threshold.
    async generateReports(coverageMap, allTestsRun) {
      await super.generateReports(coverageMap, allTestsRun)
      this.#report()
    }

    async readCoverageFiles({ onFileRead, onFinished, onDebug }) {
      const nodePasses = []
      let nodeParts = []
      await super.readCoverageFiles({
        onDebug,
        onFileRead: (coverage) => {
          const { vite, node } = splitForms(coverage, this.#lengthOf)
          onFileRead(vite)
          if (node.result.length > 0) nodeParts.push(node)
        },
        onFinished: async (project, environment) => {
          await onFinished(project, environment)
          if (nodeParts.length > 0) nodePasses.push({ project, environment, nodeParts })
          nodeParts = []
        },
      })
      // Node's scripts go last, after every project and environment's vite scripts, so that a file one project
      // imports and another requires finds its vite item maps whichever project was read first.
      this.#nodePass = true
      try {
        for (const pass of nodePasses) {
          for (const part of pass.nodeParts) onFileRead(part)
          await onFinished(pass.project, pass.environment)
        }
      } finally {
        this.#nodePass = false
      }
    }

    async convertCoverage(coverage, project, environment) {
      const converted = await super.convertCoverage(coverage, project, environment)
      for (const file of converted.files()) {
        const data = converted.fileCoverageFor(file).data
        if (!this.#nodePass) {
          // The first vite conversion of a file is the one kept: its maps are the ones the merged map starts from.
          if (!this.#viteMaps.has(file)) this.#viteMaps.set(file, itemMapsOf(data))
          continue
        }
        const vite = this.#viteMaps.get(file)
        const why = vite ? adoptMaps(data, vite) : null
        if (why) {
          this.twoFormsProblems.push(`${file} was loaded both through vite and by Node, and its two conversions ` +
            `do not list the same items: ${why}. Its figures are wrong. See ${HERE}.`)
        }
      }
      return converted
    }

    // Node compiled the file's own text: with no transform the stock method returns the file as it is on disk.
    async getSources(url, onTransform, functions) {
      return super.getSources(url, this.#nodePass ? async () => null : onTransform, functions)
    }
  }
}

export default {
  ...stock,
  async getProvider() {
    const { [STOCK_CLASS]: StockProvider } = await import(/* @vite-ignore */ STOCK_PROVIDER)
    return new (twoForms(StockProvider))()
  },
}
