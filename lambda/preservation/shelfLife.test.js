// Put-Up release 1a (V4 §3.3) — the shelf-life engine, pinned as a LITERAL matrix of what it computes.
//
// WHY A LITERAL AND NOT A RULE. shelf-life-default-floor.test.js asserts rules over the table (a default
// never outlasts the shortest declared route); putUpMethodParity.test.js asserts every method HAS a row.
// Neither can see a cell move. Release 1a moves the engine out of index.js and then changes named cells
// (V4 §3.3 "Which release changes which cells"), and the only way to prove "the move changed nothing"
// and "the rule change changed exactly the disclosed cells" is to hold every cell as data: every method
// in the write gate × every storage-location kind × unrecorded, as months or null (no date).
//
// GENERATED, NOT HAND-TYPED. BEFORE_1A was produced by running the engine code as it stood at
// garden-app dev 45fa81417425febcad5f12ad4b88014c0ae944fc and pasting its output, and it stays as the
// record of what shipped. AFTER_1A is the engine after release 1a's rule change, and the test below
// that diffs the two is the disclosure list Dave was shown (V4 decisions list, item 6, the 1a bullet).
// If this file and the engine disagree, the engine changed — find out which cell and why before
// touching a literal.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// The engine under test, imported: it moved out of index.js into its own modules in the commit
// after the one that pinned it, and the literal below did not change by one byte across that move.
import { shelfLifeMonths, defaultUseByTarget, resolveShelfLife } from './shelfLife.js'
import { VALID_METHODS } from './jarRules.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../..')

// Every storage_location kind the database admits, plus the unrecorded case (a jar with no place, or
// no kind resolved). Checked against the DDL below so a new kind cannot quietly escape the matrix.
const KINDS = ['deep_freezer', 'fridge_freezer', 'fridge', 'pantry', 'cold_storage', 'other']
const COLUMNS = [...KINDS, 'unrecorded']

const matrixOf = (months) => Object.fromEntries(VALID_METHODS.map((m) => [
  m, Object.fromEntries(COLUMNS.map((k) => [k, months(m, k === 'unrecorded' ? null : k)])),
]))

// ── TODAY'S ENGINE (generated at 45fa81417425febcad5f12ad4b88014c0ae944fc) ─────────────────────────
//                         deep_freezer  fridge_freezer  fridge  pantry  cold_storage  other  unrecorded
const BEFORE_1A = {
  roast_freeze:        { deep_freezer: 12, fridge_freezer: 4, fridge: 10, pantry: 10, cold_storage: 10, other: 10, unrecorded: 10 },
  whole_freeze:        { deep_freezer: 12, fridge_freezer: 4, fridge: 10, pantry: 10, cold_storage: 10, other: 10, unrecorded: 10 },
  blanch_freeze:       { deep_freezer: 12, fridge_freezer: 4, fridge: 10, pantry: 10, cold_storage: 10, other: 10, unrecorded: 10 },
  dehydrate:           { deep_freezer: 4, fridge_freezer: 4, fridge: 4, pantry: 4, cold_storage: 6, other: 4, unrecorded: 4 },
  powder:              { deep_freezer: 4, fridge_freezer: 4, fridge: 4, pantry: 4, cold_storage: 6, other: 4, unrecorded: 4 },
  passata:             { deep_freezer: 12, fridge_freezer: 12, fridge: 12, pantry: 12, cold_storage: 18, other: 12, unrecorded: 12 },
  can_water_bath:      { deep_freezer: 12, fridge_freezer: 12, fridge: 12, pantry: 12, cold_storage: 18, other: 12, unrecorded: 12 },
  can_pressure:        { deep_freezer: 12, fridge_freezer: 12, fridge: 12, pantry: 12, cold_storage: 12, other: 12, unrecorded: 12 },
  jam_preserve:        { deep_freezer: 12, fridge_freezer: 12, fridge: 12, pantry: 12, cold_storage: 18, other: 12, unrecorded: 12 },
  ferment:             { deep_freezer: 6, fridge_freezer: 6, fridge: 6, pantry: 6, cold_storage: 8, other: 6, unrecorded: 6 },
  cure_store:          { deep_freezer: 3, fridge_freezer: 3, fridge: 3, pantry: 3, cold_storage: 4, other: 3, unrecorded: 3 },
  cold_store:          { deep_freezer: 4, fridge_freezer: 4, fridge: 4, pantry: 4, cold_storage: 6, other: 4, unrecorded: 4 },
  purchased_preserved: { deep_freezer: null, fridge_freezer: null, fridge: null, pantry: null, cold_storage: null, other: null, unrecorded: null },
  quick_pickle:        { deep_freezer: 12, fridge_freezer: 4, fridge: 2, pantry: 12, cold_storage: 12, other: 2, unrecorded: 2 },
  pesto:               { deep_freezer: 12, fridge_freezer: 4, fridge: 10, pantry: 10, cold_storage: 10, other: 10, unrecorded: 10 },
  hot_sauce:           { deep_freezer: 6, fridge_freezer: 6, fridge: 6, pantry: 12, cold_storage: 18, other: 6, unrecorded: 6 },
  ferment_mash:        { deep_freezer: 6, fridge_freezer: 6, fridge: 6, pantry: 6, cold_storage: 8, other: 6, unrecorded: 6 },
  candy:               { deep_freezer: 6, fridge_freezer: 4, fridge: 1, pantry: 1, cold_storage: 1, other: 1, unrecorded: 1 },
  other:               { deep_freezer: null, fridge_freezer: null, fridge: null, pantry: null, cold_storage: null, other: null, unrecorded: null },
}

// ── AFTER RELEASE 1a ────────────────────────────────────────────────────────────────────────────────
// Rule (a) on the fridge: a recorded fridge with no figure for the method gets NO DATE instead of
// borrowing `default`. The freezer legs of rule (b) and candy's four explicit legs change no cell.
//                         deep_freezer  fridge_freezer  fridge  pantry  cold_storage  other  unrecorded
const AFTER_1A = {
  roast_freeze:        { deep_freezer: 12, fridge_freezer: 4, fridge: null, pantry: 10, cold_storage: 10, other: 10, unrecorded: 10 },
  whole_freeze:        { deep_freezer: 12, fridge_freezer: 4, fridge: null, pantry: 10, cold_storage: 10, other: 10, unrecorded: 10 },
  blanch_freeze:       { deep_freezer: 12, fridge_freezer: 4, fridge: null, pantry: 10, cold_storage: 10, other: 10, unrecorded: 10 },
  dehydrate:           { deep_freezer: 4, fridge_freezer: 4, fridge: null, pantry: 4, cold_storage: 6, other: 4, unrecorded: 4 },
  powder:              { deep_freezer: 4, fridge_freezer: 4, fridge: null, pantry: 4, cold_storage: 6, other: 4, unrecorded: 4 },
  passata:             { deep_freezer: 12, fridge_freezer: 12, fridge: null, pantry: 12, cold_storage: 18, other: 12, unrecorded: 12 },
  can_water_bath:      { deep_freezer: 12, fridge_freezer: 12, fridge: null, pantry: 12, cold_storage: 18, other: 12, unrecorded: 12 },
  can_pressure:        { deep_freezer: 12, fridge_freezer: 12, fridge: null, pantry: 12, cold_storage: 12, other: 12, unrecorded: 12 },
  jam_preserve:        { deep_freezer: 12, fridge_freezer: 12, fridge: null, pantry: 12, cold_storage: 18, other: 12, unrecorded: 12 },
  ferment:             { deep_freezer: 6, fridge_freezer: 6, fridge: 6, pantry: 6, cold_storage: 8, other: 6, unrecorded: 6 },
  cure_store:          { deep_freezer: 3, fridge_freezer: 3, fridge: null, pantry: 3, cold_storage: 4, other: 3, unrecorded: 3 },
  cold_store:          { deep_freezer: 4, fridge_freezer: 4, fridge: 4, pantry: 4, cold_storage: 6, other: 4, unrecorded: 4 },
  purchased_preserved: { deep_freezer: null, fridge_freezer: null, fridge: null, pantry: null, cold_storage: null, other: null, unrecorded: null },
  quick_pickle:        { deep_freezer: 12, fridge_freezer: 4, fridge: 2, pantry: 12, cold_storage: 12, other: 2, unrecorded: 2 },
  pesto:               { deep_freezer: 12, fridge_freezer: 4, fridge: null, pantry: 10, cold_storage: 10, other: 10, unrecorded: 10 },
  hot_sauce:           { deep_freezer: 6, fridge_freezer: 6, fridge: 6, pantry: 12, cold_storage: 18, other: 6, unrecorded: 6 },
  ferment_mash:        { deep_freezer: 6, fridge_freezer: 6, fridge: 6, pantry: 6, cold_storage: 8, other: 6, unrecorded: 6 },
  candy:               { deep_freezer: 6, fridge_freezer: 4, fridge: 1, pantry: 1, cold_storage: 1, other: 1, unrecorded: 1 },
  other:               { deep_freezer: null, fridge_freezer: null, fridge: null, pantry: null, cold_storage: null, other: null, unrecorded: null },
}

// THE 1a DISCLOSURE, as data: "a jar in the fridge no longer borrows a figure meant for elsewhere:
// pesto 10 months, the freeze family 10, jam, passata and canned 12, dried 4, cure & store 3". Every
// cell that moved, and the only cells that may move. [method, kind, before, after]
const DISCLOSED_1A = [
  ['pesto', 'fridge', 10, null],
  ['roast_freeze', 'fridge', 10, null], ['whole_freeze', 'fridge', 10, null], ['blanch_freeze', 'fridge', 10, null],
  ['jam_preserve', 'fridge', 12, null], ['passata', 'fridge', 12, null],
  ['can_water_bath', 'fridge', 12, null], ['can_pressure', 'fridge', 12, null],
  ['dehydrate', 'fridge', 4, null], ['powder', 'fridge', 4, null],
  ['cure_store', 'fridge', 3, null],
]

// Where each cell's date comes from, per the engine: table (a general figure), house (candy, the one
// house-sourced row) or none. Written nowhere in 1a; release 1b's use_by_basis persists it.
const T = 'table', H = 'house', N = 'none'
//                         deep_freezer  fridge_freezer  fridge  pantry  cold_storage  other  unrecorded
const BASIS_1A = {
  roast_freeze:        [T, T, N, T, T, T, T],
  whole_freeze:        [T, T, N, T, T, T, T],
  blanch_freeze:       [T, T, N, T, T, T, T],
  dehydrate:           [T, T, N, T, T, T, T],
  powder:              [T, T, N, T, T, T, T],
  passata:             [T, T, N, T, T, T, T],
  can_water_bath:      [T, T, N, T, T, T, T],
  can_pressure:        [T, T, N, T, T, T, T],
  jam_preserve:        [T, T, N, T, T, T, T],
  ferment:             [T, T, T, T, T, T, T],
  cure_store:          [T, T, N, T, T, T, T],
  cold_store:          [T, T, T, T, T, T, T],
  purchased_preserved: [N, N, N, N, N, N, N],
  quick_pickle:        [T, T, T, T, T, T, T],
  pesto:               [T, T, N, T, T, T, T],
  hot_sauce:           [T, T, T, T, T, T, T],
  ferment_mash:        [T, T, T, T, T, T, T],
  candy:               [H, H, H, H, H, H, H],
  other:               [N, N, N, N, N, N, N],
}

describe('the matrix covers every cell there is', () => {
  // INSTRUMENT CHECKS, first: a matrix over a short list of kinds or methods would pass while pinning
  // nothing about the cells it forgot.
  it('KINDS is exactly the storage_location kind CHECK', () => {
    const ddl = readFileSync(resolve(root, 'migrations/v4-putup-001/0a-additive-ddl.sql'), 'utf8')
    const at = ddl.indexOf('CONSTRAINT chk_storage_location_kind')
    expect(at).toBeGreaterThan(-1)
    const body = ddl.slice(at, ddl.indexOf(')', ddl.indexOf('IN (', at)))
    const inDdl = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    expect([...inDdl].sort()).toEqual([...KINDS].sort())
  })

  it('pins every method in the write gate, and nothing else', () => {
    expect(VALID_METHODS.length).toBeGreaterThanOrEqual(19)
    for (const pinned of [BEFORE_1A, AFTER_1A, BASIS_1A]) {
      expect(Object.keys(pinned).sort()).toEqual([...VALID_METHODS].sort())
    }
    for (const row of [...Object.values(BEFORE_1A), ...Object.values(AFTER_1A)]) {
      expect(Object.keys(row)).toEqual(COLUMNS)
    }
    for (const row of Object.values(BASIS_1A)) expect(row).toHaveLength(COLUMNS.length)
  })
})

describe('the engine computes exactly the pinned matrix', () => {
  // Amended in the rule-change commit, as V4 requires of a characterization test: BEFORE_1A was the
  // engine's matrix until release 1a (pinned in 2450428, unchanged through the move in 086ce07).
  it('every method × kind × unrecorded → months (null = no date)', () => {
    expect(matrixOf(shelfLifeMonths)).toEqual(AFTER_1A)
  })

  // The same cells through the function the POST actually calls, from a put-up date on the 1st (so no
  // month-end clamp can blur a month count): the writer adds exactly the pinned months, or writes null.
  it('defaultUseByTarget writes the pinned months forward from the put-up date', () => {
    const monthsWritten = (m, k) => {
      const d = defaultUseByTarget(m, k, '2026-01-01')
      if (d == null) return null
      const [y, mo, day] = d.split('-').map(Number)
      expect(day).toBe(1)
      return (y - 2026) * 12 + (mo - 1)
    }
    expect(matrixOf(monthsWritten)).toEqual(AFTER_1A)
  })

  it('the basis of every cell is pinned: table, house (candy) or none', () => {
    const basisOf = Object.fromEntries(VALID_METHODS.map((m) => [
      m, COLUMNS.map((k) => resolveShelfLife(m, k === 'unrecorded' ? null : k).basis),
    ]))
    expect(basisOf).toEqual(BASIS_1A)
    // …and the months it reports are the matrix's, so the two can never tell different stories.
    expect(matrixOf((m, k) => resolveShelfLife(m, k).months)).toEqual(AFTER_1A)
  })
})

describe('release 1a changes exactly the disclosed cells, and nothing else', () => {
  const diff = () => {
    const out = []
    for (const m of Object.keys(BEFORE_1A)) {
      for (const k of COLUMNS) {
        if (BEFORE_1A[m][k] !== AFTER_1A[m][k]) out.push([m, k, BEFORE_1A[m][k], AFTER_1A[m][k]])
      }
    }
    return out
  }
  const key = (c) => `${c[0]}/${c[1]}`

  it('the before→after diff is the 1a disclosure list, cell for cell', () => {
    expect(diff().map(key).sort()).toEqual(DISCLOSED_1A.map(key).sort())
    expect(diff().sort()).toEqual([...DISCLOSED_1A].sort())
  })

  it('every disclosed cell is a fridge losing a borrowed figure, and no freezer cell moves', () => {
    for (const [, kind, before, after] of DISCLOSED_1A) {
      expect(kind).toBe('fridge')
      expect(before).toBeGreaterThan(0)
      expect(after).toBeNull()
    }
    for (const m of Object.keys(AFTER_1A)) {
      for (const k of ['deep_freezer', 'fridge_freezer']) expect(AFTER_1A[m][k]).toBe(BEFORE_1A[m][k])
    }
  })

  it('an unrecorded kind still answers with the default, and candy keeps its floor everywhere', () => {
    for (const m of Object.keys(AFTER_1A)) expect(AFTER_1A[m].unrecorded).toBe(BEFORE_1A[m].unrecorded)
    expect(AFTER_1A.candy).toEqual(BEFORE_1A.candy)
  })
})

describe('the date arithmetic the writer uses', () => {
  it.each([
    ['clamps to the last day of a short month', 'cure_store', null, '2026-11-30', '2027-02-28'],
    ['lands on Feb 29 in a leap year', 'quick_pickle', 'fridge', '2027-12-31', '2028-02-29'],
    ['keeps the day when the target month has it', 'roast_freeze', 'deep_freezer', '2026-01-31', '2027-01-31'],
    ['reads only the calendar date of an ISO timestamp', 'ferment', 'fridge', '2026-03-15T23:30:00.000Z', '2026-09-15'],
  ])('%s', (_label, method, kind, from, want) => {
    expect(defaultUseByTarget(method, kind, from)).toBe(want)
  })

  it('a Date input is read by its UTC calendar day (the driver hands DATE columns back as UTC-midnight Dates in the Lambda)', () => {
    expect(defaultUseByTarget('dehydrate', 'pantry', new Date(Date.UTC(2026, 4, 31)))).toBe('2026-09-30')
  })

  it('no put-up date, an unknown method, or a no-figure method writes no date', () => {
    expect(defaultUseByTarget('whole_freeze', 'deep_freezer', null)).toBeNull()
    expect(defaultUseByTarget('not_a_method', 'fridge', '2026-01-01')).toBeNull()
    expect(defaultUseByTarget('other', null, '2026-01-01')).toBeNull()
  })
})
