// Put-Up release 1a (V4 §3.3) — the shelf-life engine, pinned as a LITERAL matrix of what it computes.
//
// WHY A LITERAL AND NOT A RULE. shelf-life-default-floor.test.js asserts rules over the table (a default
// never outlasts the shortest declared route); putUpMethodParity.test.js asserts every method HAS a row.
// Neither can see a cell move. Release 1a moves the engine out of index.js and then changes named cells
// (V4 §3.3 "Which release changes which cells"), and the only way to prove "the move changed nothing"
// and "the rule change changed exactly the disclosed cells" is to hold every cell as data: every method
// in the write gate × every storage-location kind × unrecorded, as months or null (no date).
//
// GENERATED, NOT HAND-TYPED. The literal below was produced by running the engine code as it stood at
// garden-app dev 45fa81417425febcad5f12ad4b88014c0ae944fc and pasting its output. If this file and the
// engine disagree, the engine changed — find out which cell and why before touching the literal.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../..')

// ── The engine under test ─────────────────────────────────────────────────────────────────────────
// TEMPORARY LOADER, for the one commit before the move: the engine still lives inside index.js, where
// shelfLifeMonths and VALID_METHODS are module-private. So the exact source text of the engine is
// sliced out and executed — today's code, not a re-implementation of it. The move commit replaces
// this block with plain imports and leaves every literal below byte-identical.
function loadEngineFromIndexSource() {
  const src = readFileSync(resolve(__dirname, 'index.js'), 'utf8')
  const vmAt = src.indexOf('const VALID_METHODS = [')
  const vm = src.slice(vmAt, src.indexOf('];', vmAt) + 2)
  const start = src.indexOf('export const HOUSE_SOURCED_SHELF_LIFE')
  const fnAt = src.indexOf('export function defaultUseByTarget')
  const end = src.indexOf('\n}\n', fnAt) + 3
  expect(vmAt, 'VALID_METHODS not found in index.js').toBeGreaterThan(-1)
  expect(start, 'HOUSE_SOURCED_SHELF_LIFE not found in index.js').toBeGreaterThan(-1)
  expect(fnAt, 'defaultUseByTarget not found in index.js').toBeGreaterThan(start)
  const engine = src.slice(start, end).replace(/^export /gm, '')
  // eslint-disable-next-line no-new-func
  return new Function(`${vm}\n${engine}\nreturn { VALID_METHODS, shelfLifeMonths, defaultUseByTarget };`)()
}
const { VALID_METHODS, shelfLifeMonths, defaultUseByTarget } = loadEngineFromIndexSource()

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
    expect(Object.keys(BEFORE_1A).sort()).toEqual([...VALID_METHODS].sort())
    for (const row of Object.values(BEFORE_1A)) expect(Object.keys(row)).toEqual(COLUMNS)
  })
})

describe('the engine computes exactly the pinned matrix', () => {
  it('every method × kind × unrecorded → months (null = no date)', () => {
    expect(matrixOf(shelfLifeMonths)).toEqual(BEFORE_1A)
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
    expect(matrixOf(monthsWritten)).toEqual(BEFORE_1A)
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
