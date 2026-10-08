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
// negative hit counts in every reading. A module ONLY Node loads is misread too, the same way every time: its
// ranges are read against vite's text of it (rainLog.js in those 59 files read 103 covered items, 23 of them items
// that never ran, with 13 that ran left out: the QA review's hand count).
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
//   4. a file converted both ways holds two lists of the same statements, functions and branches whose positions
//      differ here and there (one list is read through vite's source map, the other parsed), and istanbul merges
//      by exact position: left alone, engine.js came out as 2,281 items for 1,374. So the Node conversion takes
//      the item maps of the vite one before the two merge (adoptMaps), which it may only when the two lists are
//      one list (whyNotSameItems): as many statements, functions and branches under the same numbers, every
//      function under the same name, every branch of the same kind with as many arms, and every item where its
//      opposite number is, in order. A file that fails that is named, the run fails, and what Node ran of the file
//      is left out of the report: nothing is merged on a guess;
//   5. no hit count in the finished map may be negative (negativeHits), in any file, however it was loaded and
//      whether or not every test file ran.
// A failure of 4 or 5 is reported the way vitest reports a coverage threshold: an ERROR line and exit code 1, after
// the reports are written, with the test summary intact; on a GitHub runner one ::error annotation as well.
//
// WHAT 5 IS, AND IS NOT. It is a tripwire for ONE symptom of a gross misreading. A count can only come out below
// zero in the else that an `if` does not have: ast-v8-to-istanbul gives that arm the `if`'s count less the
// consequent's (the one subtraction in it; every other count is V8's own, painted on). Ranges read against a text
// they were not counted in, or at the wrong start offset by a wrapper's length, put some consequent above its `if`:
// every mixed reading of the stock provider had some (74 in the full suite at v4.175.0), no conversion per form
// has had one. It does NOT show that a conversion is right. The QA review measured it on the 59 files: every Node
// script read ONE character off gives 16 more covered items and no negative count; every zero count turned into a
// hit gives 198 more and none; and a file with no else-less `if` (ledgerParams.js has no branch) can never trip
// it. So "0 negative counts" is never, alone, evidence that the figures are true. What holds the counts is the
// test file: every count of the fixture run, per form, against the calls its cases make, and V8's own record of a
// module only Node loaded.
//
// THREE CONDITIONS THE SPLIT STANDS ON, none of them checked at run time:
//   - vite's text of a file is longer than the file. It is because vitest appends an inline source map that carries
//     the file's text (the nearest of 62,627 vite scripts in the suite was 2,141 characters longer). A setup
//     without inline source maps would take that away;
//   - Node compiles the text the file holds, to the character. Node 26.4.0 does so even for a file that starts with
//     a byte-order mark (measured: the script ends at the length with the mark in it). A Node that strips the mark
//     before compiling would end such a script one short, and it would be taken for a vite script still loading;
//     Node 20.19.0, CI's, is not measured for it. No file under lambda/ or src/ starts with one;
//   - one coverage window a worker. With workers reused across test files (`isolate: false`; the suite gives every
//     test file its own) an `if (await x)` left unawaited by one file could have its consequent counted in the
//     next file's window, a negative count on a correct conversion.
//
// THE WORKER SIDE is the stock one, by two routes. The class keeps the stock `name`, 'v8', and in the one-project
// shape (no trial key: every local run and ci.yml) vitest hands its workers the provider's resolved options, so
// they load @vitest/coverage-v8 themselves and this module is evaluated once, in the main process. When the run
// has projects (the trial key's two, in vitest.config.ts; ci-next.yml's unit legs) every worker evaluates THIS
// module too, twice (measured on three test files: one evaluation without the key, seven in four processes with
// it), a jsdom worker through vite's module runner. By reading vitest's cli-api, each project's config is built
// from the root's coverage block before the provider's options replace it, so it keeps `provider: 'custom'`. That
// is why the default export carries the stock startCoverage / takeCoverage / stopCoverage themselves: whichever
// copy of this module a worker calls, the state is the stock module's, one per process. Nothing else may run when
// this file is evaluated. (For a port to vitest 5: the regression review read @vitest/coverage-v8 5.0.3 as keeping
// its session on `this`, where the spread below would have to become calls on the one stock object.)
//
// WHAT IT LEANS ON INSIDE VITEST (read in 4.1.11, READ_AT below). None of it is public API, so
// coverage-v8-two-forms.test.js holds it to the installed package twice: it asks the package for its version and
// for each member and each call named here, and it puts modules loaded through vite, by Node and both ways through
// a real `vitest run --coverage`, as one project and as two, and reads every hit count back.
//   - `@vitest/coverage-v8/dist/provider.js` can be imported and exports the class `V8CoverageProvider`;
//   - its generateCoverage() calls this.readCoverageFiles({ onFileRead, onFinished, onDebug }), folds every
//     onFileRead(coverage) into one merged list and converts that list with this.convertCoverage(merged, project,
//     environment) on each onFinished(project, environment), merges what that returns into the run's map, then
//     starts a new list;
//   - readCoverageFiles() (BaseCoverageProvider, in vitest/node) calls onFileRead once per per-test-file result and
//     onFinished once per project and environment;
//   - convertCoverage() asks this.getSources(url, onTransform, functions) for the text of each script, reads the
//     script at its `startOffset`, and returns an istanbul coverage map (files(), fileCoverageFor(file).data,
//     filter(keep));
//   - getSources() returns the file's own text, and no source map, when the transform it is handed resolves null;
//   - a script entry is { url, startOffset, functions: [{ ranges: [{ startOffset, endOffset, count }] }] } with the
//     script's outermost range first. `startOffset` is looked up by PATH among the modules the worker has finished
//     evaluating: the wrapper's length, the same for every module of a worker, and 0 when the path is not there
//     (@vitest/coverage-v8/dist/index.js takeCoverage, vitest/dist/module-evaluator.js);
//   - Node compiles a file it loads from the file's own text, so that script's outermost range ends at the file's
//     length in characters (Node 26.4.0 and 20.19.0; the fixture run fails on a Node where it does not);
//   - generateReports(coverageMap, allTestsRun) writes the reports and checks the thresholds, and this.ctx.logger
//     prints.
// And outside vitest, on what vite hands it: whyNotSameItems needs vite's text of a file to list the items the file
// lists, in the file's order, with a source map that sends each back to where it is or to the token before it.
// Re-read this file against all of that on any vitest or @vitest/coverage-v8 upgrade (the test's version pin makes
// that one deliberate edit), and after a vite, @vitejs/plugin-react or Node (.nvmrc) upgrade when the fixture run
// goes red or a full run names a file in an ERROR line: a reprint that changes can fail whyNotSameItems on a real
// module while the small fixture stays green.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import stock from '@vitest/coverage-v8'

export const STOCK_PROVIDER = '@vitest/coverage-v8/dist/provider.js'
export const STOCK_CLASS = 'V8CoverageProvider'
// The @vitest/coverage-v8 this file was last read against, line for line. The test holds the installed one to it.
export const READ_AT = '4.1.11'
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
export const ANNOTATION = '::error title=coverage-v8-two-forms::'

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

const startOf = (item) => (item.loc || item).start
const said = (start) => (start ? `${start.line}:${start.column}` : 'none')
// Where `a` is against `b` in the file: below zero before it, zero at it, above zero after it. Not a number when
// either has no line or column, and then no comparison below holds, so the item is refused.
const order = (a, b) => (a.line === b.line ? a.column - b.column : a.line - b.line)
// The item maps of one converted file, and `b` for the number of arms each branch has.
const itemMapsOf = ({ statementMap, fnMap, branchMap, b }) => ({ statementMap, fnMap, branchMap, b })

// Why the Node conversion of a file cannot take the vite conversion's item maps, or null when it can. Both lists
// are one walk of the same program in source order, and they are held to being one list:
//   - as many statements, functions and branches, under the same numbers;
//   - every function with its opposite number's name, every branch with its opposite number's kind and number of
//     arms;
//   - every item where its opposite number is, in order. Vite's start of an item is not the file's: its source map
//     sends a start back to the token it has an entry for, which is the item's own first token or one before it.
//     Measured on the thirteen files of lambda/daily-plan converted both ways (4,298 items): 83 starts are up to
//     21 columns early, 75 that sit behind an opening bracket the reprint dropped are one column late, and four (a
//     value on the line after its `const x =`, handler.js:20-21) are a line early. What holds for all 4,298 is
//     that vite's start of an item lies AFTER the file's start of the item before it and BEFORE the file's start
//     of the item after it, or exactly where vite starts that neighbour too (two items that begin at one token:
//     an `if` and the `(a || b) && c` it tests). So that is the rule, with no distance in it. A list that has lost
//     one item and gained another has the same count and every item between the two under its neighbour's number:
//     counts alone adopted it and gave each of those items a neighbour's hits. Of such shifts made in the real
//     lists, the rule refuses 97% of those two items long, 99.8% of three, and every one of ten or more.
// What it can miss: a shift so short and so placed that each moved start still falls between its neighbours, and
// one item exchanged for another that starts where a neighbour starts.
export function whyNotSameItems(node, vite) {
  for (const map of ITEM_MAPS) {
    const [inFile, inVite] = [Object.keys(node[map]), Object.keys(vite[map])]
    if (inFile.length !== inVite.length) {
      return `${map} has ${inFile.length} items read from the file and ${inVite.length} read from vite's text`
    }
    const odd = inFile.findIndex((key, index) => key !== inVite[index])
    if (odd !== -1) return `${map} item ${inFile[odd]} read from the file is item ${inVite[odd]} read from vite's text`
  }
  for (const [key, fn] of Object.entries(node.fnMap)) {
    const other = vite.fnMap[key]
    if (fn.name !== other.name) {
      return `function ${key} (line ${startOf(fn).line}) is ${fn.name} read from the file and ${other.name} read ` +
        'from vite\'s text'
    }
  }
  for (const [key, branch] of Object.entries(node.branchMap)) {
    const other = vite.branchMap[key]
    if (branch.type !== other.type || node.b[key].length !== vite.b[key]?.length) {
      return `branch ${key} (line ${startOf(branch).line}) is ${branch.type} with ${node.b[key].length} arms read ` +
        `from the file and ${other.type} with ${vite.b[key]?.length} read from vite's text`
    }
  }
  for (const map of ITEM_MAPS) {
    const keys = Object.keys(node[map])
    const inFile = keys.map((key) => startOf(node[map][key]))
    const inVite = keys.map((key) => startOf(vite[map][key]))
    for (let at = 0; at < keys.length; at++) {
      const after = at === 0 || order(inVite[at], inFile[at - 1]) > 0 || order(inVite[at], inVite[at - 1]) === 0
      const before = at === keys.length - 1 || order(inVite[at], inFile[at + 1]) < 0 ||
        order(inVite[at], inVite[at + 1]) === 0
      if (!after || !before) {
        return `${map} item ${keys[at]} starts at ${said(inFile[at])} read from the file and at ${said(inVite[at])} ` +
          `read from vite's text, which is not between the items before and after it in the file (${said(inFile[at - 1])} ` +
          `and ${said(inFile[at + 1])})`
      }
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
    #annotated = false
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
      // On a runner the lines above are the last of a long step log under a job whose tests all passed: one
      // annotation a problem, once, puts the reason on the run's summary page.
      if (process.env.GITHUB_ACTIONS === 'true' && !this.#annotated) {
        for (const problem of this.twoFormsProblems) {
          this.ctx.logger.log(ANNOTATION + problem.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A'))
        }
        this.#annotated = true
      }
      process.exitCode = 1
    }

    async generateCoverage(options) {
      this.twoFormsProblems = []
      this.#annotated = false
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
      const refused = new Set()
      for (const file of converted.files()) {
        const data = converted.fileCoverageFor(file).data
        if (!this.#nodePass) {
          // The first vite conversion of a file is the one kept: its maps are the ones the merged map starts from.
          if (!this.#viteMaps.has(file)) this.#viteMaps.set(file, itemMapsOf(data))
          continue
        }
        // A file only Node loaded has no vite maps to take: its own are the only ones in the report.
        const vite = this.#viteMaps.get(file)
        const why = vite ? adoptMaps(data, vite) : null
        if (why) {
          refused.add(file)
          this.twoFormsProblems.push(`${file} was loaded both through vite and by Node, and its two conversions ` +
            `do not list the same items: ${why}. What Node ran of it is left out of the report, so its figures are ` +
            `too low. See ${HERE}.`)
        }
      }
      // Merged as it is, a refused file would come out with every item twice.
      if (refused.size > 0) converted.filter((file) => !refused.has(file))
      return converted
    }

    // Node compiled the file's own text: with no transform the stock method returns the file as it is on disk.
    async getSources(url, onTransform, functions) {
      return super.getSources(url, this.#nodePass ? async () => null : onTransform, functions)
    }
  }
}

// What vitest imports: in the main process always, for getProvider; in every worker too when the run has projects
// (THE WORKER SIDE, above), for the three stock functions. Evaluating this file must do nothing else.
export default {
  ...stock,
  async getProvider() {
    const { [STOCK_CLASS]: StockProvider } = await import(/* @vite-ignore */ STOCK_PROVIDER)
    return new (twoForms(StockProvider))()
  },
}
