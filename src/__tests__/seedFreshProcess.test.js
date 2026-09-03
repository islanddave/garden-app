/**
 * V4-SEEDFRESHPROCESS-001 — `fresh` is a real third process, in every home that must agree.
 *
 * Dave, 2026-09-03: "wet / dry don't give any option for peppers, which just goes from fresh plant
 * to drying for a few days then saved. None of these two options works here."
 *
 * The vocabulary lives in FIVE places and every one of them had to move together:
 *   1. the DB CHECK inventory_items_seed_process_check   (migrations/v4-seedfreshprocess-001)
 *   2. lambda/inventory-items/index.js SEED_PROCESSES    — the create arm
 *   3. lambda/inventory-items/index.js SEED_PROCESSES    — a SECOND copy in the same file
 *   4. src/pages/SavedSeeds.jsx PROCESS_ENTRY
 *   5. src/components/planting/SaveSeedSheet.jsx PROCESS_ENTRY  (deliberate mirror, not an import)
 *
 * Two copies of one list inside a single file is the shape that drifts silently, and a client that
 * ships ahead of the Lambda gets a 400 on a value the UI is actively offering. This file reads the
 * SOURCE TEXT of each home and asserts they agree — the same technique
 * seedStageVocabulary.test.js already uses for the stage list, for the same reason.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p) => readFileSync(resolve(process.cwd(), p), 'utf8')

const LAMBDA = read('lambda/inventory-items/index.js')
const PAGE = read('src/pages/SavedSeeds.jsx')
const SHEET = read('src/components/planting/SaveSeedSheet.jsx')
const DDL = read('migrations/v4-seedfreshprocess-001/0a-additive-ddl.sql')

// Keys of a PROCESS_ENTRY object literal, in source order.
function processKeys(src) {
  const block = src.match(/const PROCESS_ENTRY = \{([\s\S]*?)\n\}/)
  expect(block, 'PROCESS_ENTRY not found — renamed?').toBeTruthy()
  return [...block[1].matchAll(/^ {2}([a-z_]+):\s*\{/gm)].map((m) => m[1])
}

describe('V4-SEEDFRESHPROCESS-001 — the vocabulary agrees across all five homes', () => {
  it('both Lambda copies accept fresh — and there really are two', () => {
    // The count assertion is the point. If someone "tidies" one array away, or adds a third arm with
    // a stale list, this catches it. Two copies is the current truth, not an aspiration.
    const arrays = [...LAMBDA.matchAll(/const SEED_PROCESSES = \[([^\]]*)\]/g)].map((m) => m[1])
    expect(arrays).toHaveLength(2)
    for (const a of arrays) {
      expect(a).toContain("'wet'")
      expect(a).toContain("'dry'")
      expect(a).toContain("'fresh'")
    }
  })

  it('the migration widens the CHECK to exactly the same three values', () => {
    expect(DDL).toContain("'wet'")
    expect(DDL).toContain("'dry'")
    expect(DDL).toContain("'fresh'")
    // A widen, never a narrow: the apply must keep the two originals. A DDL that dropped one would
    // orphan live rows, and the single lot in prod today is 'dry'.
    expect(DDL).toMatch(/ADD CONSTRAINT inventory_items_seed_process_check/)
  })

  it('the page and the sheet offer the same three, in the same order', () => {
    // Order matters to the user, not just the set: the chooser reads wet -> fresh -> dry, which is
    // wettest to driest. Two mirrors drifting in ORDER would be invisible to a set comparison.
    expect(processKeys(PAGE)).toEqual(['wet', 'fresh', 'dry'])
    expect(processKeys(SHEET)).toEqual(['wet', 'fresh', 'dry'])
  })

  it('fresh enters at drying, not fermenting — the whole point of the value', () => {
    // A pepper must never land in the ferment queue. The /seed-stage POST writes a permanent
    // seed_lot_stage_log row, so a wrong entry stage is not a display bug — it is a false record
    // that cannot be un-said. This is the assertion that would have caught the original defect.
    for (const [label, src] of [['page', PAGE], ['sheet', SHEET]]) {
      const fresh = src.match(/fresh:\s*\{([\s\S]*?)\},/)
      expect(fresh, `${label}: fresh entry missing`).toBeTruthy()
      expect(fresh[1], `${label}: fresh must enter at drying`).toContain("stage: 'drying'")
      expect(fresh[1]).not.toContain("stage: 'fermenting'")
    }
  })

  it('the wet option no longer advertises "washed"', () => {
    // The original trap, and it is worth pinning because the wording looks harmless. `wet` routes to
    // `fermenting`; while its copy said "seed WASHED or fermented out of wet pulp", a user saving
    // peppers could reasonably read "washed", pick it, and have the lot filed as fermenting. The
    // word belongs to `fresh` now, and must not drift back.
    for (const [label, src] of [['page', PAGE], ['sheet', SHEET]]) {
      const wet = src.match(/wet:\s*\{([\s\S]*?)\},/)
      expect(wet, `${label}: wet entry missing`).toBeTruthy()
      expect(wet[1].toLowerCase(), `${label}: "washed" must not appear on the wet option`)
        .not.toContain('washed')
    }
  })
})
