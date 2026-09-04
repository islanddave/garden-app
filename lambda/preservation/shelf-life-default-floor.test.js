// SHELF_LIFE_MONTHS — the default must never be the shelf-stable figure when a fridge figure exists.
//
// WHY THIS FILE EXISTS. `hot_sauce` shipped to production as
//   { pantry: 12, cold_storage: 18, fridge: 6, default: 12 }
// — a DEFAULT of twelve months, which is the PANTRY number. `default` is what fires when the user
// recorded no storage kind, so a fermented or vinegar-finished hot sauce logged without a location
// was handed a twelve-month ROOM-TEMPERATURE use-by that nobody chose.
//
// It is a defect rather than a judgement call, and the proof is eleven lines above it in the same
// constant, on quick_pickle: "The DEFAULT is the fridge number, because an unrecorded storage kind
// must not be read as 'somebody processed this'." Identical reasoning, opposite outcome, adjacent
// lines. Corrected to 6 on 2026-09-04.
//
// Independently: a 2026-09-04 search of NCHFP, Penn State, UMN, USU, OSU, UGA and NC State found no
// tested home recipe for a fermented pepper-mash hot sauce and no home path to making one
// shelf-stable, and BC CDC's stated default for an unverified ferment is refrigeration. So the
// twelve-month figure was not merely inconsistent with the house rule — it was the one direction the
// published corpus refuses.
//
// WHY THE ASSERTION IS THE RULE AND NOT THE VALUE. Pinning `hot_sauce.default === 6` would guard one
// row and teach nothing. The invariant below is the house's own sentence, and it holds for every
// method that declares a fridge figure — ferment, cold_store, quick_pickle, hot_sauce, ferment_mash —
// so it is exercised five times, not once. It caught nothing when written only because the fix landed
// first; mutate any of those five `default` values upward and this reds.
//
// Deliberately NOT asserted: "default is the minimum of all legs". That is false by design for the
// freeze family (deep_freezer 12, fridge_freezer 4, default 10), where naming a freeze method already
// tells you the thing is frozen somewhere. The narrow rule is the one the house actually states.
//
// TEXT ASSERTION, because lambda/preservation/index.js cannot be imported by vitest — Neon, Clerk and
// AWS all run at module scope. Same constraint that let the classifyUseBy day-boundary bug ship
// untested, and the same workaround every other test in this directory uses.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// resolve() against a dirname, matching the sibling guards in this directory. `new URL('./x',
// import.meta.url)` does NOT work here — vitest hands this module a non-file scheme.
const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(resolve(__dirname, 'index.js'), 'utf8')

function shelfLifeRows() {
  // The ` = {` is load-bearing, not tidiness. `indexOf('const SHELF_LIFE_MONTHS')` PREFIX-matches
  // `const SHELF_LIFE_MONTHS_RENAMED`, so renaming the constant left this whole file green — caught
  // by mutating the anchor, not by reading it.
  const start = SRC.indexOf('const SHELF_LIFE_MONTHS = {')
  expect(start, 'SHELF_LIFE_MONTHS not found — has the constant been renamed?').toBeGreaterThan(-1)
  // The constant ends at the first line that is exactly a closing brace + semicolon.
  const end = SRC.indexOf('\n};', start)
  expect(end, 'could not find the end of SHELF_LIFE_MONTHS').toBeGreaterThan(start)
  const block = SRC.slice(start, end)

  const rows = {}
  for (const m of block.matchAll(/^\s*([a-z_]+):\s*\{([^}]*)\}/gm)) {
    const legs = {}
    for (const leg of m[2].matchAll(/([a-z_]+):\s*(null|\d+)/g)) {
      legs[leg[1]] = leg[2] === 'null' ? null : Number(leg[2])
    }
    rows[m[1]] = legs
  }
  return rows
}

describe('SHELF_LIFE_MONTHS — an unrecorded storage kind must not be read as "somebody processed this"', () => {
  const rows = shelfLifeRows()

  // INSTRUMENT CHECK, first. Without it every assertion below is satisfied by a parse that returned
  // nothing — an empty object passes any for-loop, which is the exact vacuity this directory's other
  // guards were bitten by. Numbers are floors, not inventories, so adding a method does not red this.
  it('parsed a populated constant', () => {
    expect(Object.keys(rows).length).toBeGreaterThanOrEqual(18)
    expect(rows.quick_pickle).toBeTruthy()
    expect(rows.hot_sauce).toBeTruthy()
  })

  // The instrument check for the rule itself: if `fridge` ever stopped parsing, the rule below would
  // iterate an empty list and pass forever while asserting nothing.
  it('at least five methods declare a fridge figure, so the rule below is exercised', () => {
    const withFridge = Object.keys(rows).filter((k) => typeof rows[k].fridge === 'number')
    expect(withFridge.length).toBeGreaterThanOrEqual(5)
    expect(withFridge).toContain('hot_sauce')
  })

  it.each(['ferment', 'ferment_mash', 'cold_store', 'quick_pickle', 'hot_sauce'])(
    '%s defaults to its own fridge figure',
    (method) => {
      const row = rows[method]
      expect(row, `${method} is missing from SHELF_LIFE_MONTHS`).toBeTruthy()
      expect(typeof row.fridge, `${method} no longer declares a fridge figure`).toBe('number')
      expect(row.default).toBe(row.fridge)
    },
  )

  // The general form, so a NEW method with a fridge leg is covered without editing the list above.
  it('no method with a fridge figure defaults to anything longer', () => {
    for (const [method, legs] of Object.entries(rows)) {
      if (typeof legs.fridge !== 'number' || typeof legs.default !== 'number') continue
      expect(
        legs.default,
        `${method} defaults to ${legs.default} months while its fridge figure is ${legs.fridge} — ` +
          'an unrecorded storage kind must not be read as "somebody processed this"',
      ).toBeLessThanOrEqual(legs.fridge)
    }
  })

  // The two honest-blank rows, asserted so a future "helpful" default cannot quietly appear. This is
  // the shipped pattern for a method with no defensible published figure, and it is the pattern a
  // house-sourced shelf life should take rather than a number with a disclaimer in a migration header.
  it.each(['purchased_preserved', 'other'])('%s still has no invented default', (method) => {
    expect(rows[method].default).toBeNull()
  })
})
