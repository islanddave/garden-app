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
//      function under the same name, every branch of the same kind with as many arms, and every item in order
//      and over its opposite number's own place in the file. A file that fails that is named, the run fails, and
//      what Node ran of the file is left out of the report: nothing is merged on a guess. (What that check still
//      cannot tell from one list is written above it);
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
// lists, in the file's order, with a source map that sends each back over its own place in the file (how far off a
// start and an end may be read is written above that function, with the shapes it was measured on).
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
// Where an item is: its start and its end. A statement is its own extent; a function and a branch carry one.
const extentOf = (item) => item.loc || item
const said = (at) => (at ? `${at.line}:${at.column}` : 'none')
// A place in a file: a line, and a column that is a number or Infinity, which is how the converter writes "the end
// of this line" (the end of an item with no token after it on its last line that the source map has an entry for).
const placed = (at) => Number.isInteger(at?.line) && (Number.isInteger(at.column) || at.column === Infinity)
// Where `a` is against `b` in the file: below zero before it, zero at it, above zero after it. Both are placed.
const order = (a, b) => (a.line !== b.line ? a.line - b.line : a.column === b.column ? 0 : a.column - b.column)
// Whether the extent `inner` lies inside the extent `outer`, their edges included.
const holds = (outer, inner) => order(outer.start, inner.start) <= 0 && order(inner.end, outer.end) <= 0
// The item maps of one converted file, and `b` for the number of arms each branch has.
const itemMapsOf = ({ statementMap, fnMap, branchMap, b }) => ({ statementMap, fnMap, branchMap, b })

// Why the Node conversion of a file cannot take the vite conversion's item maps, or null when it can. Both lists
// are one walk of the same program, and they are held to being one list:
//   - as many statements, functions and branches, under the same numbers;
//   - every function with its opposite number's name, every branch with its opposite number's kind and number of
//     arms;
//   - every item in order, and over its opposite number's own place in the file.
// Two of those hold less than they read. A function without a name is named `(anonymous_N)` by its number (105 of
// the 278 real functions), so for those the name check cannot fail. And a branch's arms are counted, their places
// never read: a branch whose arms are elsewhere, or exchanged, is taken. Neither can differ while both lists are one
// walk of one syntax tree.
// THE PLACES. Vite's place for an item is not the file's. The converter reads a start at the source map's entry at
// or before the item's first character (when its line of vite's text has none there, at the next) and an end on
// the line of the entry at or before its last character, at the next entry on that line or at the line's end; the
// reprint keeps some brackets, which have no entry, and drops others. Measured on the thirteen files of
// lambda/daily-plan converted both ways (4,298 items), and on a scratch module of shapes they do not have, put
// through the same run (152 items, not in the repo). All of them are CommonJS modules, and the three lines below are
// measured on that kind only; what an ES module does to an end is under WHAT IT REFUSES THAT IS RIGHT:
//   starts  4,136 at the file's. 83 up to 21 columns early and four a line early: an item behind a bracket the
//           reprint kept starts at the token before it (the name in `const x =\n  (value)`, handler.js:20-21; three
//           lines early with blank lines in between). 75 one column late, behind a bracket the reprint dropped; a
//           line late when the line breaks after that bracket, and seven columns late for a statement
//           `(() => 2)()`, read at the first entry inside it. Never at or past the item's own end;
//   ends    4,290 on the item's last line, at its end or past it. Eight at the END of an earlier line of the item:
//           statements of handler.js that end in a template literal of several lines (205-290 reads as ending on
//           205); so too before a closing bracket the reprint dropped and before a `;` on the next line. Never
//           before the item's first line, never short of its end on its last line, never on a later line;
//   shared  110 times, all branches, vite's start of an item is not after the file's start of the item before it or
//           not before the file's start of the item after it. Vite then starts the two at one place, and in the
//           file the later of the two lies inside the earlier (an `if` and the `(a || b) && c` it tests,
//           handler.js:29; they are on two lines when the test is on the line after its `if`).
// THE RULE, with no distance in it, in two passes over the three maps. ORDER: vite's start of an item lies AFTER the
// file's start of the item before it and BEFORE the file's start of the item after it, or exactly where vite starts
// that neighbour too, which it may only where the later of the two lies inside the earlier in the file. PLACE:
// vite's start of an item is after the file's start of the SAME item only inside that item, and vite's end of it is
// on its last line at or past its end, or at the end of an earlier line of it. A place without a line and a column
// is refused.
// WHAT THE ORDER ALONE TOOK. It was the whole rule until OPS-COVPROVIDERMAPADOPT-001, without the condition on a
// shared start. A list that has lost one item and gained another has the same counts, and Node's hits then land on
// other items. Made in the thirteen real lists:
//   - one item exchanged for another that is after it on its line, on the next line, or on the line of the item
//     before: 8,164 of 8,652 taken. PLACE refuses all 8,652;
//   - a shift, the items between the lost and the gained one each under a neighbour's number. Of one item (the
//     gained one being its neighbour twice, the kindest case) 8,411 of 8,520 taken, now 1,405; of two 278 of 8,446,
//     now five; of three or more 56, now none. By the script the order rule's own figures came from (forty random
//     shifts a list, one seed), refused at one item: 2.0% then, 87.2% now; at two: 97.1% then, all now;
//   - any shift through items vite starts early (a run of `const x =\n  (value)`, 33 moved) and any list whose
//     starts the map sends to one place (in any order). PLACE refuses the first, ORDER the second.
// WHAT IT STILL TAKES, each because the tie that closes it refuses correct lists (the tests name them `a known
// limit`):
//   - an item exchanged for one over its own place: one that starts after the start of the item before it and
//     before its own end, and ends at or past its end. That is a start inside it (so vite reads 75 real items, in
//     eight of the thirteen files) and, the wider case, a start BEFORE it at any distance (so vite reads the early
//     starts above): of 4,260 such exchanges made in the thirteen lists, each ending at the line end of the lost
//     item's last line, 4,179 are taken, as many as by the order alone. No distance closes it, a start being read
//     at the token before a kept bracket any number of comment lines back. Or, for an item of several lines, one
//     that ends with an earlier line of it (eight real items, handler.js);
//   - one item under its neighbour's number where one of the two lies inside the other and ends with it, on its
//     last line or with an earlier line of it: the 1,405. In 745 the outer one stands for the inner, which is how
//     vite reads 110 real pairs, at one start (nine of the thirteen files); in 660 the inner stands for the outer,
//     which is a start late inside its item, as above. The 1,405 is an upper bound, not the exposure: 1,026 of
//     them are statement lists that hold one extent twice, and the converter keys a statement by its extent and
//     lists each once (no extent is twice among the 4,298 real items, in either form). With a gained statement that
//     is not a double (the same start, another end) 105 of 1,324 are taken; held to that for functions and branches
//     too, which the converter keys by other places, so there it is an assumption, 189 of 8,520.
// Two tighter ties were measured and NOT taken. Neither refuses any of the thirteen files; both refuse correct
// lists of the scratch module. "A start at most one column late" refuses the statement `(() => 2)()` and a dropped
// bracket with a line break after it (it would leave 757 of the 1,405, and 98 of the 189). "A start shared only by
// two items the file starts on one line" refuses an `if` whose test is on the next line.
// WHAT IT REFUSES THAT IS RIGHT. Both are loud, the ERROR line and exit 1 and never a wrong count, and neither is in
// a file converted both ways today. When the ERROR names one of these the file is right and the rule is short: it
// is not two forms that have come apart, and whether the rule should take the shape is its owner's decision.
//   - PLACE's end, new with OPS-COVPROVIDERMAPADOPT-001 (the order alone took it, and merged it right): an ES
//     module with an item that ends in a call of an imported binding, `const { a } = useThing()`. Vitest rewrites
//     that call in vite's text and the map then ends the item AT its closing bracket, a column short of its end on
//     its last line: `statementMap item 0 is at 7:16 to 7:Infinity read from the file and ends at 7:25 read from
//     vite's text`, in a real run of a scratch ES module imported through vite and loaded by Node with
//     `createRequire` (Node 26.4.0 and 20.19.0). Of the 290 plain-JS files under coverage.include, read both ways
//     by the stock provider's own methods, 34 have the shape (51 items; src/hooks 21, src/components 9, src/lib 4;
//     all ES modules, src/lib/api.js:351 for one). None is loaded both ways: lambda/daily-plan is the only CommonJS
//     directory and the six test files that use `createRequire` load its modules only. The first test to load one
//     of the 34 that way reds the unit step. The tests pin the refusal (`a known limit`), so that taking the shape
//     is a deliberate edit;
//   - ORDER, as it always did, before that change and after it. Not one shape but at least three, each seen in a
//     real run of a CommonJS scratch module: (a) a class with a field that has a value, after a method, a plain
//     `count = 0` and a `static X = 7` included (the converter lists that value before the methods' statements in
//     both forms, so the file's own list is not in order there); (b) a class with no method, a field whose value
//     is a function with a body and then another field with a value; (c) a destructuring declaration or a
//     parameter pattern with a default that is a function, `const { sql, query = {}, now = () => Date.now() } =
//     ctx`. (c) is this repo's own idiom: lambda/harvests/season-stats.js:150, src/hooks/useAppUpdate.js:40,
//     src/lib/registerSW.js:39, src/lib/voiceResults.js:46. None of the four is converted both ways, and none of
//     the sixteen files of lambda/daily-plan has (a), (b) or (c); the first of them to take an injectable clock
//     that way reds the unit step.
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
  const lists = ITEM_MAPS.map((map) => {
    const keys = Object.keys(node[map])
    const [inFile, inVite] = [node, vite].map((read) => keys.map((key) => extentOf(read[map][key])))
    return { map, keys, inFile, inVite }
  })
  for (const { map, keys, inFile, inVite } of lists) {
    for (let at = 0; at < keys.length; at++) {
      const edge = ['start', 'end'].find((side) => !placed(inFile[at][side]) || !placed(inVite[at][side]))
      if (edge) {
        return `${map} item ${keys[at]} ${edge}s at ${said(inFile[at][edge])} read from the file and at ` +
          `${said(inVite[at][edge])} read from vite's text, and one of the two is no place in a file`
      }
    }
    for (let at = 0; at < keys.length; at++) {
      const start = inVite[at].start
      const after = at === 0 || order(start, inFile[at - 1].start) > 0 ||
        (order(start, inVite[at - 1].start) === 0 && holds(inFile[at - 1], inFile[at]))
      const before = at === keys.length - 1 || order(start, inFile[at + 1].start) < 0 ||
        (order(start, inVite[at + 1].start) === 0 && holds(inFile[at], inFile[at + 1]))
      if (!after || !before) {
        return `${map} item ${keys[at]} starts at ${said(inFile[at].start)} read from the file and at ${said(start)} ` +
          `read from vite's text, which is not between the items before and after it in the file ` +
          `(${said(inFile[at - 1]?.start)} and ${said(inFile[at + 1]?.start)})`
      }
    }
  }
  for (const { map, keys, inFile, inVite } of lists) {
    for (let at = 0; at < keys.length; at++) {
      const [file, read] = [inFile[at], inVite[at]]
      if (order(read.start, file.start) > 0 && order(read.start, file.end) >= 0) {
        return `${map} item ${keys[at]} is at ${said(file.start)} to ${said(file.end)} read from the file and ` +
          `starts at ${said(read.start)} read from vite's text, which is past that item's own end in the file`
      }
      const ended = read.end.line === file.end.line
        ? order(read.end, file.end) >= 0
        : read.end.line >= file.start.line && read.end.line < file.end.line && read.end.column === Infinity
      if (!ended) {
        return `${map} item ${keys[at]} is at ${said(file.start)} to ${said(file.end)} read from the file and ` +
          `ends at ${said(read.end)} read from vite's text, which is neither on that item's last line at or past ` +
          'its end nor the end of an earlier line of it'
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
