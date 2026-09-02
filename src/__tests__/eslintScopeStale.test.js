// V4-DESIGNSYS-001 follow-up — the frozen-primitives lint guard's SCOPE is itself a thing that can
// silently stop guarding, so it gets its own test.
//
// THE ORIGINAL DEFECT SHAPE (fixed 2026-08-26). `eslint.config.js` applied the rule to nine NAMED
// files. Rename or delete one and ESLint does not complain — a `files:` glob that matches nothing is
// not an error, it is a block that lints nothing. The rule keeps reporting success over a shrinking
// set and nothing says so. Worse, the list could only go stale in the quiet direction: five shipped
// primitives (PhotoUpload + the four tag primitives) were never added to it, which is how an
// off-palette #b14a3c reached production invisible to CI.
//
// WHAT CHANGED. The scope is now a GLOB over components/forms/** plus a short explicit list for the
// non-form primitives, so a new primitive is guarded by default. The hardcoded-list hazard did not
// disappear, it MOVED: the per-class deferral blocks (the debt register) are a hardcoded list of 16
// paths, and a rename there silently makes the register describe files that no longer exist.
//
// So this file now asserts three things, in ascending order of what they would have caught:
//   1. the glob is still there and still matches real files (a glob matching nothing is the same
//      silent no-op in different clothes);
//   2. every explicitly-named path, in the scope block AND in the register blocks, still exists;
//   3. the blocks actually attach the rule, and hex is not deferrable on any of them.
//
// BUG-SCOPESTALEVACUOUS-001 (fixed 2026-09-02). Assertion 3 was VACUOUS in the direction that
// mattered most. It read `SRC.slice(SRC.indexOf(block))` — from a block's start to the END OF THE
// FILE — so a LATER block's `'error'` satisfied the assertion for an EARLIER one. Setting the
// full-strength scope block to `'off'` therefore left all 28 assertions green: the one test
// protecting the guard could not detect the guard being disabled, and `eslint .` exits 0 with the
// rule off, so nothing else caught it either. Each block is now bounded at the next `files: [`,
// and `regions hold exactly one rule attachment each` is the assertion that keeps the bounding
// honest — if the slice ever runs to EOF again, the first region holds four and that test reds.
//
// Read as text rather than imported. Importing eslint.config.js would execute it and pull in
// @eslint/js — resolvable here and in CI, but the value of this test is a statement about the FILE,
// and parsing the literal blocks keeps it honest about what a reader of that file would see.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SRC = readFileSync(resolve(ROOT, 'eslint.config.js'), 'utf8')

const FORMS_GLOB = 'src/components/forms/**/*.{js,jsx}'

const RULE = "'designsys/no-raw-design-tokens'"

// Comments are stripped before any severity assertion. A block's region necessarily swallows the
// prose that introduces the NEXT block, and this file's register is heavily commented — without
// this, writing the rule name and `'error'` inside a comment would satisfy the assertion for a
// block that no longer attaches it.
const stripComments = (s) => s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

// Every block that attaches the designsys rule — the full-strength scope AND all three deferral
// blocks. Anchored on the rule name rather than on position, so reordering the config cannot
// silently retarget this test at the permissive base block, which would make every assertion
// below pass while checking nothing.
//
// `region` is bounded at the NEXT `files: [` (or EOF for the last one), so a block's assertions
// can only ever be satisfied by that block's OWN text. That bound is the whole of the fix for
// BUG-SCOPESTALEVACUOUS-001 described in the header.
function designsysBlocks(src) {
  const starts = []
  for (let i = src.indexOf('files: ['); i >= 0; i = src.indexOf('files: [', i + 1)) starts.push(i)
  const out = []
  let from = 0
  for (;;) {
    const ruleAt = src.indexOf(RULE, from)
    if (ruleAt < 0) break
    from = ruleAt + 1
    const start = starts.filter(s => s < ruleAt).pop()
    if (start === undefined) continue
    const end = starts.find(s => s > start) ?? src.length
    const close = src.indexOf(']', start)
    out.push({ files: close > start ? src.slice(start, close) : '', region: src.slice(start, end) })
  }
  return out
}

const parsed = designsysBlocks(SRC)
const blocks = parsed.map(b => b.files)
// Quoted paths that look like real files. The forms glob ends in `}` and is deliberately excluded
// here — it is asserted separately, because "does this path exist" is the wrong question for a glob.
const listed = [...new Set(
  blocks.flatMap(b => [...b.matchAll(/'([^']+\.(?:jsx?|mjs|cjs))'/g)].map(m => m[1])),
)]

describe('eslint frozen-primitives scope does not silently go stale', () => {
  // VACUITY FLOOR. Every assertion below iterates `listed` or `blocks`; if the parse broke, they
  // would all pass having checked nothing. This is the exact shape that let a guard elsewhere in
  // this repo report "PASS (0 glyphs)".
  it('the designsys blocks parse and are non-empty', () => {
    expect(blocks.length, 'could not locate any designsys-scoped files block').toBeGreaterThanOrEqual(3)
    expect(listed.length).toBeGreaterThanOrEqual(5)
  })

  // MUTATION: quietly revert the scope to a hand-maintained list -> RED. The list is the defect;
  // reintroducing it must not be a silent edit.
  it('the primitive barrel is scoped by GLOB, not by a hand-maintained list', () => {
    expect(SRC).toContain(`'${FORMS_GLOB}'`)
  })

  // MUTATION: a glob that matches nothing lints nothing and reports success. Assert it still has
  // subjects — this is the check the original file could not make, because it had no glob.
  it('the forms glob actually matches primitives', () => {
    const files = readdirSync(resolve(ROOT, 'src/components/forms'))
      .filter(f => /\.(jsx?|mjs|cjs)$/.test(f))
    expect(files.length, 'the forms glob matches nothing — the scope is vacuous').toBeGreaterThanOrEqual(20)
  })

  // MUTATION: rename or delete any named primitive, or any debt-register entry, without updating
  // the config -> RED. Without this, a rename makes the rule lint one fewer file (or the register
  // describe a file that does not exist) forever, silently.
  it.each(listed)('%s still exists', (rel) => {
    expect(existsSync(resolve(ROOT, rel)), `${rel} is named in eslint.config.js for the frozen-primitives lint rule but does not exist — either restore it or update eslint.config.js`).toBe(true)
  })

  // VACUITY FLOOR for the bounding itself. Each region must hold EXACTLY ONE rule attachment.
  // If the region ever runs past its own block again — the BUG-SCOPESTALEVACUOUS-001 defect —
  // the first region holds all four and this reds immediately, before any severity assertion has
  // a chance to be answered by a neighbour's text.
  it('block regions are disjoint — one rule attachment each', () => {
    expect(parsed.length).toBeGreaterThanOrEqual(3)
    for (const { region } of parsed) {
      const n = region.split(RULE).length - 1
      expect(n, `a block region holds ${n} rule attachments — the region bound has regressed and every severity assertion below is answerable by a NEIGHBOURING block`).toBe(1)
    }
  })

  // MUTATION: set any block's rule to 'off' (or 'warn', which does not fail `eslint .`) -> RED.
  // MUTATION: drop the plugin registration while leaving the files list -> RED.
  // A files list with no rule attached is the same silent no-op wearing different clothes, and
  // until 2026-09-02 the first of those two mutations was undetectable here.
  it('every block attaches the rule at error severity, not just a file list', () => {
    for (const { files, region } of parsed) {
      const code = stripComments(region)
      const first = files.split('\n')[1]?.trim() ?? files.slice(0, 60)
      expect(code, `block starting ${first} registers no designsys plugin`).toMatch(/plugins:\s*\{\s*designsys:/)
      expect(code, `block starting ${first} does not attach designsys/no-raw-design-tokens at 'error' — 'off' and 'warn' both leave \`eslint .\` exiting 0, which is the guard silently not guarding`)
        .toMatch(/'designsys\/no-raw-design-tokens':\s*(?:'error'|\['error')/)
    }
  })

  // MUTATION: drop `caps: DEFER_CAPS` from a deferral block -> RED here, and rawUncapped at lint
  // time. A deferral with no ceiling is the unbounded one OPS-DEFERCEILING-001 exists to stop.
  it('every deferring block passes the recorded ceilings', () => {
    const deferring = parsed.filter(({ region }) => /defer:\s*\[/.test(stripComments(region)))
    expect(deferring.length, 'no deferral block found — the register parse has broken').toBeGreaterThanOrEqual(1)
    for (const { region } of deferring) {
      expect(stripComments(region)).toMatch(/caps:\s*DEFER_CAPS/)
    }
  })

  // MUTATION: add 'hex' to a defer list -> RED. An off-palette colour is the class that actually
  // reached production unseen, so no file gets to opt out of it. The rule's own schema rejects
  // 'hex' as an enum value; this asserts the intent at the config level too, where a reader looks.
  it('no block defers the hex class', () => {
    expect(SRC).not.toMatch(/defer:\s*\[[^\]]*['"]hex['"]/)
  })
})
