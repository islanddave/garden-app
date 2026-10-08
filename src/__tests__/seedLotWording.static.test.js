// V5-SEEDLOTADDITION-001 (seed release 3) — two rules of this release that no rendered test can hold
// (contract T28), read from the source files themselves.
//
// 1. THE WORD. Dave, 2026-10-07: he does not think of saved seed as jars. On the two screens this
//    release touches (Save seed and the lot page) every sentence says "lot" or "seed lot". The rendered
//    tests can only see the states they reach; this reads every string and every line of JSX text in the
//    five files that draw those screens. Comments are not on screen and are left alone.
//
// 2. THE TEST FILES STAND STILL UNDER A FLAG FLIP. The forward undo of this release is a build with the
//    flag line false, rehearsed by serving that line to the unchanged test files. A test that re-mocks a
//    module mid-file, resets the module registry, or imports the code under test dynamically can read
//    the flag at a moment the rehearsal does not control, so none of this release's test files may.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (file) => readFileSync(resolve(process.cwd(), file), 'utf8')

// Source with its comments blanked out: // to the end of the line and /* ... */ (which covers JSX's
// {/* ... */}), told apart from the same characters inside a string or a template. A quote left open
// at the end of a line (an apostrophe in JSX text) is closed there, so it cannot swallow the lines after
// it. What follows it on its OWN line is kept, comment or not: that can only add a finding, never hide one.
export function stripComments(src) {
  let out = ''
  let quote = null
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]
    const next = src[i + 1]
    if (quote) {
      out += c
      if (c === '\\') { out += next ?? ''; i += 1 } else if (c === quote || (c === '\n' && quote !== '`')) quote = null
      continue
    }
    if (c === '/' && next === '/' && src[i - 1] !== ':') {
      while (i < src.length && src[i] !== '\n') i += 1
      out += '\n'
      continue
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? src.length : end + 2
      out += src.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop - 1
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    out += c
  }
  return out
}

const SCREEN_FILES = [
  'src/components/planting/AddToLot.jsx',
  'src/components/seed/seedAdditions.js',
  'src/components/planting/SaveSeedSheet.jsx',
  'src/components/seed/SavedFromCard.jsx',
  'src/components/seed/seedParents.js',
]
const OLD_WORD = /\bjars?\b/i

describe('the comment stripper this file relies on', () => {
  it('keeps strings and JSX text, drops both kinds of comment, and leaves a URL whole', () => {
    const src = [
      "const a = 'kept one' // dropped one",
      '/* dropped two */ const b = "kept // two"',
      '<p>{/* dropped three */}kept three</p>',
      'const u = `http://kept.four/${x}`',
      "<p>it's kept five</p>",
      '// dropped five',
    ].join('\n')
    const out = stripComments(src)
    for (const kept of ['kept one', 'kept // two', 'kept three', 'http://kept.four/', 'kept five']) expect(out).toContain(kept)
    expect(out).not.toMatch(/dropped/)
  })
  it('would see the old word in a string, in JSX text and in a template', () => {
    for (const src of ["const s = 'this jar'", '<p>Two jars here</p>', 'const t = `the ${n} Jar`']) {
      expect(OLD_WORD.test(stripComments(src))).toBe(true)
    }
    expect(OLD_WORD.test(stripComments('// one jar\n/* two jars */ const ajar = 1'))).toBe(false)
  })
})

describe('"seed lot" / "lot", never the old word, on Save seed and the lot page (D5)', () => {
  it.each(SCREEN_FILES)('%s', (file) => {
    const lines = stripComments(read(file)).split('\n')
    const hits = lines.map((text, i) => ({ line: i + 1, text: text.trim() })).filter((l) => OLD_WORD.test(l.text))
    expect(hits).toEqual([])
    // Not vacuous: the file is real source that says "lot" somewhere outside a comment.
    expect(lines.length).toBeGreaterThan(100)
    expect(/\blots?\b/i.test(lines.join('\n'))).toBe(true)
  })
})

// The test files this release adds or edits, client and server. Lane S's are listed so the rule is
// held for the whole release from one place; a file not on disk is a failure, not a skip.
const RELEASE_TEST_FILES = [
  'src/__tests__/SaveSeedSheet.addToLot.test.jsx',
  'src/__tests__/SaveSeedSheet.addToLot.flagOff.test.jsx',
  'src/__tests__/seedAdditions.test.js',
  'src/__tests__/PlantingDetail.addToLot.test.jsx',
  'src/__tests__/InventoryDetail.stillSays.test.jsx',
  'src/__tests__/InventoryDetail.parents.flagOff.test.jsx',
  'src/__tests__/seedLotWording.static.test.js',
  'src/__tests__/EventNew.seedSaveDoor.test.jsx',
  'src/__tests__/EventDetail.metadataKeys.test.js',
  'src/__tests__/featureFlags.test.js',
  'src/__tests__/SavedSeeds.storedCount.test.jsx',
  'src/__tests__/InventoryDetail.measureWire.test.jsx',
  'lambda/inventory-items/seed-lot-additions.test.js',
  'tests/integration/seed-lot-additions.int.test.js',
  'tests/integration/seed-lots-open.int.test.js',
]
// Spelled in pieces so this file does not contain what it forbids.
const FORBIDDEN_CALLS = [['vi', 'doMock'].join('.'), ['vi', 'resetModules'].join('.')]
// A dynamic import of app code: `import('../…')`. A node built-in, or a stub beside the test
// (`./helpers/…`, which is how a mock factory loads its stand-in), is not the module under test.
const DYNAMIC_APP_IMPORT = /\bimport\(\s*['"`]\.\.\//

describe('this release\'s test files read the flags once, at load', () => {
  it.each(RELEASE_TEST_FILES)('%s', (file) => {
    expect(existsSync(resolve(process.cwd(), file)), `${file} is not on disk`).toBe(true)
    const src = stripComments(read(file))
    for (const call of FORBIDDEN_CALLS) expect(src.includes(call), `${file} calls ${call}`).toBe(false)
    expect(DYNAMIC_APP_IMPORT.test(src), `${file} imports app code dynamically`).toBe(false)
  })
})
