// V4-DESIGNSYS-001 follow-up — the frozen-primitives lint guard is scoped to a HARDCODED file list,
// and a hardcoded list of paths is a guard that can silently stop guarding.
//
// THE DEFECT SHAPE. `eslint.config.js` applies `designsys/no-raw-design-tokens` to nine named files.
// Rename or delete any one of them and ESLint does not complain — a `files:` glob that matches
// nothing is not an error, it is simply a block that lints nothing. The rule keeps reporting success
// over a shrinking set, and nothing anywhere says so. This is the same family as the guards the
// vacuity audit confirmed: coverage that lies, and a subject list that can go quietly empty.
//
// It is honestly DOCUMENTED as scoped ("Out of scope for Pass A: the rest of the app"), so the scope
// is deliberate and this file does not argue with it. What it asserts is narrower and is the part
// nobody wrote down: every path in that deliberate scope must still EXIST.
//
// Read as text rather than imported. Importing eslint.config.js would execute it and pull in
// @eslint/js — resolvable here and in CI, but the value of this test is a statement about the FILE,
// and parsing the literal block keeps it honest about what a reader of that file would see.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SRC = readFileSync(resolve(ROOT, 'eslint.config.js'), 'utf8')

// The scoped block is the one that attaches the designsys rule. Anchored on the rule name rather
// than on position, so reordering the config does not silently retarget this test at the permissive
// base block — which would make every assertion below pass while testing nothing.
function scopedBlock(src) {
  const ruleAt = src.indexOf("'designsys/no-raw-design-tokens'")
  if (ruleAt < 0) return null
  const blockStart = src.lastIndexOf('files: [', ruleAt)
  if (blockStart < 0) return null
  const close = src.indexOf(']', blockStart)
  return close > blockStart ? src.slice(blockStart, close) : null
}

const block = scopedBlock(SRC)
const listed = block
  ? [...block.matchAll(/'([^']+\.(?:jsx?|mjs|cjs))'/g)].map((m) => m[1])
  : []

describe('eslint frozen-primitives scope does not silently go stale', () => {
  // VACUITY FLOOR. Every assertion below iterates `listed`; if the parse broke or the block were
  // emptied, they would all pass having checked nothing. This is the exact shape that let a guard
  // report "PASS (0 glyphs)" elsewhere in this repo.
  it('the scoped block parses and is non-empty', () => {
    expect(block, 'could not locate the designsys-scoped files block').toBeTruthy()
    expect(listed.length).toBeGreaterThanOrEqual(5)
  })

  // MUTATION: rename or delete any listed primitive without updating the config -> RED here.
  // Without this, that rename makes the rule lint one fewer file, forever, silently.
  it.each(listed)('%s still exists', (rel) => {
    expect(existsSync(resolve(ROOT, rel)), `${rel} is scoped for the frozen-primitives lint rule but does not exist — either restore it or update eslint.config.js`).toBe(true)
  })

  // MUTATION: drop the plugin registration while leaving the files list -> RED.
  // A files list with no rule attached is the same silent no-op wearing different clothes.
  it('the block actually attaches the rule, not just the file list', () => {
    const after = SRC.slice(SRC.indexOf(block))
    expect(after).toMatch(/plugins:\s*\{\s*designsys:/)
    expect(after).toMatch(/'designsys\/no-raw-design-tokens':\s*'error'/)
  })
})
