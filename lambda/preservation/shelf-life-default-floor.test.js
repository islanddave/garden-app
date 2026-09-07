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

  // ── BUG-DEHYDRATESHELF-001. The dried-food rows, pinned by VALUE. ───────────────────────────────
  //
  // WHY BY VALUE, when almost nothing else here is. These two rows shipped wrong for weeks and no
  // test could see it: the fridge rule above skips every shelf-stable-only method (`continue` on a
  // missing fridge leg), and putUpMethodParity binds method NAMES, not figures. `dehydrate` read
  // {12,12,12} — NCHFP's FRUIT figure at 60F applied to every dried food including peppers, which are
  // a vegetable — with `pantry` equal to `cold_storage` though the published figure is explicitly
  // temperature-dependent. `powder` read {18,18,18} citing "(NCHFP dehydrate)" for a number 1.5x that
  // source's own ONE-YEAR ceiling; `git log -S` dates that line seven weeks BEFORE the evidence base
  // it cites existed. A corrected number with no guard regresses the same silent way, so: pinned.
  //
  // Derivation, so a future editor can check the numbers rather than trust them — NCHFP via
  // foodsafety-research.md §6.2: fruit 12mo @60F / 6mo @80F, "vegetables about half", envelope floor
  // 4 months. pantry = warm anchor (6/2 = 3, raised to the printed 4-month floor rather than let this
  // file's arithmetic undercut its own source); cold_storage = cool anchor (12/2 = 6); default = the
  // shorter leg, per the rule the fridge block above states. Full ruling with the interpolation stress
  // test: project-state/_build-batchclose-20260904/ruling-dehydrate-shelf.md (gardening-docs).
  it.each([['dehydrate'], ['powder']])(
    '%s carries the vegetable figures, not the fruit best case',
    (method) => {
      const row = rows[method]
      expect(row, `${method} is missing from SHELF_LIFE_MONTHS`).toBeTruthy()
      expect(row.pantry, `${method}.pantry must be the 80F vegetable leg at the printed 4-month floor`).toBe(4)
      expect(row.cold_storage, `${method}.cold_storage must be the 60F vegetable leg (12/2)`).toBe(6)
      expect(row.default, `${method}.default must be the SHORTER leg, not the cold one`).toBe(4)
    },
  )

  it('powder inherits dehydrate exactly — grinding is not a preservation step', () => {
    // A powder has more surface area than the slices it came from, is more hygroscopic, and CAKES as
    // it reabsorbs moisture — NCHFP's named dried-food failure. So powder LONGER than dehydrate is
    // backwards in mechanism as well as unsourced. Equal is already the generous reading.
    expect(rows.powder).toEqual(rows.dehydrate)
  })

  // The two honest-blank rows, asserted so a future "helpful" default cannot quietly appear. This is
  // the shipped pattern for a method with no defensible published figure, and it is the pattern a
  // house-sourced shelf life should take rather than a number with a disclaimer in a migration header.
  it.each(['purchased_preserved', 'other'])('%s still has no invented default', (method) => {
    expect(rows[method].default).toBeNull()
  })
})
