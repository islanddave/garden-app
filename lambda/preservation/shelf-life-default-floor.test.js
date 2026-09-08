// SHELF_LIFE_MONTHS — the default must never outlast the shortest storage route the row declares.
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
// AMENDED 2026-09-08 rather than left to read false (BUG-SHELFDEFAULTGUARDGAP-001). This block used
// to say "default is the minimum of all legs" was deliberately NOT asserted, because it is false by
// design for the freeze family (deep_freezer 12, fridge_freezer 4, default 10). That reasoning holds
// for the freeze family and ONLY for it, and declining to assert the rule anywhere is what let the
// guard skip every shelf-stable-only row. The minimum rule IS now asserted, with the freeze family
// carved out STRUCTURALLY — a row is exempt only while every leg it declares is a freezer kind, so
// naming a freeze method still tells you the thing is frozen somewhere, and a freeze row that later
// grows a pantry leg loses the exemption without anyone remembering to edit this file.
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

  // ── The general form. STRENGTHENED 2026-09-08, BUG-SHELFDEFAULTGUARDGAP-001. ────────────────────
  //
  // This rule used to read `default <= fridge`, gated by `if (typeof legs.fridge !== 'number')
  // continue`. That `continue` skipped every SHELF-STABLE-ONLY method — which is exactly the class the
  // rule exists to catch. Twelve of the nineteen rows declare no fridge leg at all, so the guard bound
  // five rows and was structurally blind to the other twelve. The comment block below already knew
  // this and said so in as many words; the note outlived the two bugs it described without ever being
  // acted on, so the same gap then let `cure_store` ship with `default: 4` against a declared `pantry:
  // 3` — an unrecorded storage kind reading a month LONGER than the shortest route the row itself
  // declares, on food.
  //
  // Mutation-proved rather than assumed (2026-09-08): with `cure_store.default` forced to 99 against
  // that pantry leg of 3, the OLD rule passed 13/13 GREEN. A 96-month overstatement on a food-safety
  // figure was invisible to the guard written to catch overstatements. The rule below reds on that,
  // and reds on the shipped `4` as well.
  const FREEZER_KINDS = ['deep_freezer', 'fridge_freezer']
  const storageLegs = (legs) =>
    Object.entries(legs).filter(([kind, v]) => kind !== 'default' && typeof v === 'number')
  // The freeze-family carve-out, by CONSTRUCTION and not by name list: a row is exempt only while
  // every leg it declares is a freezer kind. A freeze method that later grows a pantry or fridge leg
  // stops being exempt on its own, with nobody needing to remember this file exists.
  //
  // WHY THE EXEMPTION IS CORRECT HERE, settled by Dave 2026-09-08 and recorded because the code
  // previously asserted it without a reason, which is what got it re-raised. The four freeze rows
  // default to 10 months while declaring a `fridge_freezer` leg of 4 — read cold, that is the same
  // overstatement `cure_store` was just fixed for, and a reviewer SHOULD flag it. It is not, because
  // of a fact about this garden that is not in the table: **nothing is stored in a fridge freezer.
  // Every store goes to a deep freezer at -15 to -30F.** So the default IS the route actually used,
  // and flooring these to 4 would understate real shelf life on every jar Dave owns.
  //
  // The `fridge_freezer` leg stays in the table as a documented figure for a route he does not use —
  // do not delete it to "resolve" this, and do not floor the defaults to it. If the storage setup
  // ever changes, this exemption is the thing to revisit first.
  const frozenOnly = (legs) => {
    const s = storageLegs(legs)
    return s.length > 0 && s.every(([kind]) => FREEZER_KINDS.includes(kind))
  }

  // Extracted as a PREDICATE rather than written inline, so the positive control below can feed it a
  // row that does not exist in the table. An inline loop can only ever be as good as the data it runs
  // over: once every real row is fixed, an inline rule passes whether or not it still detects
  // anything, which is precisely how the fridge version sat here looking healthy while blind. The
  // control binds this function, so reverting it to a fridge gate reds immediately.
  // Returns null when the row is fine or out of scope, else the offending {shortestKind, shortest}.
  const floorViolation = (legs) => {
    const s = storageLegs(legs)
    if (typeof legs.default !== 'number' || s.length === 0 || frozenOnly(legs)) return null
    const [shortestKind, shortest] = s.reduce((a, b) => (b[1] < a[1] ? b : a))
    return legs.default > shortest ? { shortestKind, shortest } : null
  }

  it('no method defaults to longer than the shortest storage route it declares', () => {
    for (const [method, legs] of Object.entries(rows)) {
      const v = floorViolation(legs)
      expect(
        v && `${method} defaults to ${legs.default} months while its shortest declared route is ` +
          `${v.shortestKind} at ${v.shortest} — an unrecorded storage kind must not be read as ` +
          '"somebody put this somewhere better than the worst route on offer"',
      ).toBeFalsy()
    }
  })

  // POSITIVE CONTROL. The rule above passes when the table is clean, which is indistinguishable from
  // the rule above passing because it cannot see. These synthetic rows make the difference visible:
  // the first is the shipped cure_store shape, the exact class the old guard skipped.
  it('the floor rule detects a shelf-stable violation that is not in the table', () => {
    expect(floorViolation({ pantry: 3, cold_storage: 4, default: 4 })).toMatchObject({
      shortestKind: 'pantry',
      shortest: 3,
    })
    // A dried-goods shape with no fridge leg anywhere — the old rule's `continue` case.
    expect(floorViolation({ pantry: 4, cold_storage: 6, default: 6 })).toBeTruthy()
    // ...and it does not cry wolf on the compliant forms.
    expect(floorViolation({ pantry: 3, cold_storage: 4, default: 3 })).toBeNull()
    expect(floorViolation({ deep_freezer: 12, fridge_freezer: 4, default: 10 })).toBeNull()
  })

  // The freeze family is exempt from the FLOOR, not from scrutiny: a default longer than every leg it
  // declares is wrong there too, and this is what stops the carve-out from being a hole.
  it('even the frozen-only rows do not default past their longest leg', () => {
    for (const [method, legs] of Object.entries(rows)) {
      if (typeof legs.default !== 'number' || !frozenOnly(legs)) continue
      const longest = Math.max(...storageLegs(legs).map(([, v]) => v))
      expect(
        legs.default,
        `${method} defaults to ${legs.default} months, longer than any leg it declares (${longest})`,
      ).toBeLessThanOrEqual(longest)
    }
  })

  // INSTRUMENT CHECK for the strengthening itself. The floor rule must BIND on rows that declare no
  // fridge figure — the population the old `continue` waved through. Without this, re-introducing any
  // fridge-shaped gate, or widening the frozen-only carve-out, would silently restore the blind spot
  // while every assertion above still passed. A floor, not an inventory: adding a method does not red
  // this, but shrinking the bound population below the class it exists to cover does.
  it('the floor rule binds on the shelf-stable rows the old fridge gate skipped', () => {
    const bound = Object.keys(rows).filter(
      (k) =>
        typeof rows[k].default === 'number' &&
        typeof rows[k].fridge !== 'number' &&
        storageLegs(rows[k]).length > 0 &&
        !frozenOnly(rows[k]),
    )
    expect(bound.length).toBeGreaterThanOrEqual(7)
    expect(bound).toEqual(expect.arrayContaining(['cure_store', 'dehydrate', 'powder']))
  })

  // Guards FREEZER_KINDS itself. The carve-out is only defensible while it covers appliance choice;
  // the moment a shelf-stable or fridge kind is admitted to that list, a row spanning real storage
  // classes could claim the exemption and the floor would stop applying to it.
  it('the frozen-only carve-out cannot swallow a row with a pantry, cold_storage or fridge leg', () => {
    // SYNTHETIC ROWS FIRST, and they are not belt-and-braces. Asserting this over the live table
    // alone SURVIVED the mutation that adds 'pantry' to FREEZER_KINDS (17/17 green, measured
    // 2026-09-08): no row in the table declares pantry ALONE — every pantry row also carries
    // cold_storage — so widening the list flips nothing today and a table-only check sees a
    // clean bill. It would start mattering the first time someone adds a pantry-only method, which
    // is exactly when nobody is looking. These bind the constant instead of the corpus.
    expect(frozenOnly({ pantry: 3, default: 3 }), 'a pantry-only row must never be exempt').toBe(false)
    expect(frozenOnly({ cold_storage: 4, default: 4 }), 'cold_storage is not a freezer').toBe(false)
    expect(frozenOnly({ fridge: 2, default: 2 }), 'a fridge is not a freezer').toBe(false)
    expect(frozenOnly({ deep_freezer: 12, fridge_freezer: 4, default: 10 })).toBe(true)

    const exempt = Object.keys(rows).filter((k) => frozenOnly(rows[k]))
    expect(exempt.length).toBeGreaterThanOrEqual(4)
    for (const method of exempt) {
      for (const kind of ['pantry', 'cold_storage', 'fridge']) {
        expect(
          rows[method][kind],
          `${method} is exempt from the floor yet declares a ${kind} leg — FREEZER_KINDS has been widened`,
        ).toBeUndefined()
      }
    }
  })

  // ── BUG-DEHYDRATESHELF-001. The dried-food rows, pinned by VALUE. ───────────────────────────────
  //
  // WHY BY VALUE, when almost nothing else here is. These two rows shipped wrong for weeks and no
  // test could see it: the fridge rule above skipped every shelf-stable-only method (`continue` on a
  // missing fridge leg), and putUpMethodParity binds method NAMES, not figures. That `continue` is
  // GONE as of 2026-09-08 (BUG-SHELFDEFAULTGUARDGAP-001) and the floor rule now covers both of these
  // rows generally — but this diagnosis sat here, correct and unactioned, while the same gap shipped
  // `cure_store` wrong. Naming a hole is not closing one. These pins STAY: the floor rule would accept
  // {4,6,4} scaled anywhere, and the specific numbers below are the sourced ones. `dehydrate` read
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
