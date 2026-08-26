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

// Every block that attaches the designsys rule — the full-strength scope AND both deferral blocks.
// Anchored on the rule name rather than on position, so reordering the config cannot silently
// retarget this test at the permissive base block, which would make every assertion below pass
// while checking nothing.
function designsysBlocks(src) {
  const out = []
  let from = 0
  for (;;) {
    const ruleAt = src.indexOf("'designsys/no-raw-design-tokens'", from)
    if (ruleAt < 0) break
    from = ruleAt + 1
    const start = src.lastIndexOf('files: [', ruleAt)
    if (start < 0) continue
    const close = src.indexOf(']', start)
    if (close > start) out.push(src.slice(start, close))
  }
  return out
}

const blocks = designsysBlocks(SRC)
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

  // MUTATION: drop the plugin registration while leaving the files list -> RED.
  // A files list with no rule attached is the same silent no-op wearing different clothes.
  it('every block attaches the rule, not just a file list', () => {
    for (const b of blocks) {
      const after = SRC.slice(SRC.indexOf(b))
      expect(after).toMatch(/plugins:\s*\{\s*designsys:/)
      expect(after).toMatch(/'designsys\/no-raw-design-tokens':\s*(?:'error'|\['error')/)
    }
  })

  // MUTATION: add 'hex' to a defer list -> RED. An off-palette colour is the class that actually
  // reached production unseen, so no file gets to opt out of it. The rule's own schema rejects
  // 'hex' as an enum value; this asserts the intent at the config level too, where a reader looks.
  it('no block defers the hex class', () => {
    expect(SRC).not.toMatch(/defer:\s*\[[^\]]*['"]hex['"]/)
  })
})
