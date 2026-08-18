import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// V4-HARVATTR-001 sync gate. `src/data/harvest-attributes-v1.json` self-describes as the AUTHORING
// source of record for `migrations/v4-harvattr-001/0b-data.sql`, which is "MECHANICALLY GENERATED"
// from it — but until this file existed NOTHING bound the two, the JSON had zero code consumers, and
// they could drift silently in either direction. `0r-rollback.sql` explicitly relies on the JSON to
// regenerate lost data, so an unverified file was guaranteeing a recovery path.
//
// Same intent as lambda/crop-derive-copies-sync.test.js (byte-identity between per-Lambda copies),
// adapted to a JSON→SQL projection: parse the seed VALUES tuples back out of the SQL and assert
// set-equality of slugs plus field-for-field equality of all six attributes. NULL↔JSON-null must
// agree exactly, because NULL is load-bearing here (NULL = UNKNOWN, no predicate may fire).

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const JSON_PATH = join(repoRoot, 'src', 'data', 'harvest-attributes-v1.json')
const SQL_PATH = join(repoRoot, 'migrations', 'v4-harvattr-001', '0b-data.sql')

const SCHEMA_ID = 'garden.harvest_attributes.v1'
const SCHEMA_VERSION = '1.0.0'

// Column order is fixed by the `WITH seed(...) AS (VALUES` declaration in 0b-data.sql.
const COLUMNS = [
  'harvest_habit',
  'repeat_interval_days',
  'loss_horizon_hours',
  'set_to_first_pick_days',
  'harvest_season_start_doy',
  'harvest_season_end_doy',
]

// One VALUES tuple per line: ('slug','habit',7,48,NULL,NULL,NULL),  -- confidence | notes
// Trailing comments are stripped by anchoring the match to the parenthesised tuple only.
const ROW_RE = /^\s*\('([a-z0-9_]+)'\s*,\s*(.+?)\)\s*,?\s*(?:--.*)?$/

function parseScalar(raw) {
  const t = raw.trim()
  if (t === 'NULL') return null
  if (/^'.*'$/.test(t)) return t.slice(1, -1)
  const n = Number(t)
  if (!Number.isFinite(n)) throw new Error(`unparseable seed scalar: ${raw}`)
  return n
}

// Split on commas that are not inside single quotes. The seed values are scalars and bare NULLs,
// so a simple quote-state scan is sufficient and avoids pulling in a SQL parser.
function splitTuple(body) {
  const out = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === "'") inQuote = !inQuote
    if (ch === ',' && !inQuote) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out
}

function parseSeedRows(sql) {
  const rows = new Map()
  // Narrow to the VALUES block so an unrelated parenthesised line elsewhere in the file can never
  // be mistaken for a seed row.
  const start = sql.indexOf('AS (\n  VALUES')
  const from = start >= 0 ? start : sql.indexOf('VALUES')
  expect(from, '0b-data.sql must contain a seed VALUES block').toBeGreaterThan(-1)
  const block = sql.slice(from)
  for (const line of block.split('\n')) {
    const m = line.match(ROW_RE)
    if (!m) continue
    const [, slug, rest] = m
    const parts = splitTuple(rest).map(parseScalar)
    expect(parts, `seed row '${slug}' must have ${COLUMNS.length} attribute columns`)
      .toHaveLength(COLUMNS.length)
    rows.set(slug, Object.fromEntries(COLUMNS.map((c, i) => [c, parts[i]])))
  }
  return rows
}

describe('harvest-attributes JSON is in sync with the generated 0b-data.sql seed', () => {
  const doc = JSON.parse(readFileSync(JSON_PATH, 'utf8'))
  const seed = parseSeedRows(readFileSync(SQL_PATH, 'utf8'))
  const authored = doc.by_crop_type

  it('the JSON declares the schema id and version this gate was written against', () => {
    // A version field with no failing path is decoration. If either changes, this test fails and the
    // author must re-confirm the projection below still holds before bumping these constants.
    expect(doc.schema).toBe(SCHEMA_ID)
    expect(doc.version).toBe(SCHEMA_VERSION)
  })

  it('parses a non-trivial number of seed rows (guards a silently-broken regex)', () => {
    // Without this, a regex that matched nothing would make every set/field assertion below
    // vacuously pass — the classic pass-but-meaningless failure.
    expect(seed.size).toBeGreaterThan(40)
  })

  it('slug sets are exactly equal in both directions', () => {
    const jsonSlugs = Object.keys(authored).sort()
    const sqlSlugs = [...seed.keys()].sort()
    // Reported as two directed diffs so a failure names the specific drifted slugs rather than
    // dumping two 51-element arrays.
    expect(jsonSlugs.filter(s => !seed.has(s)), 'authored in JSON but missing from 0b-data.sql').toEqual([])
    expect(sqlSlugs.filter(s => !(s in authored)), 'seeded in 0b-data.sql but absent from the JSON').toEqual([])
  })

  it('every attribute matches field-for-field, with NULL treated as significant', () => {
    for (const [slug, want] of Object.entries(authored)) {
      const got = seed.get(slug)
      if (!got) continue // covered by the set-equality test above
      for (const col of COLUMNS) {
        // JSON omits a field or sets it null; SQL writes NULL. Both normalize to null.
        const expected = want[col] ?? null
        expect(got[col], `${slug}.${col}`).toBe(expected)
      }
    }
  })

  it('the seed honors the crop_types CHECK constraints it will be inserted under', () => {
    // chk_crop_types_repeat_interval forbids a 'single' row carrying an interval, and
    // chk_crop_types_harvest_season_doy requires the DOY bounds to be null together. Asserting them
    // HERE means a bad authored value fails in CI rather than mid-apply against prod.
    for (const [slug, row] of seed) {
      expect(['single', 'repeat', 'cut_and_come_again'], `${slug}.harvest_habit`)
        .toContain(row.harvest_habit)
      if (row.harvest_habit === 'single') {
        expect(row.repeat_interval_days, `${slug}: 'single' must not carry an interval`).toBeNull()
      }
      expect(
        row.harvest_season_start_doy === null,
        `${slug}: DOY start/end must be NULL together`,
      ).toBe(row.harvest_season_end_doy === null)
      for (const col of ['repeat_interval_days', 'set_to_first_pick_days']) {
        if (row[col] !== null) {
          expect(row[col], `${slug}.${col} range`).toBeGreaterThanOrEqual(1)
          expect(row[col], `${slug}.${col} range`).toBeLessThanOrEqual(365)
        }
      }
      for (const col of ['harvest_season_start_doy', 'harvest_season_end_doy']) {
        if (row[col] !== null) {
          expect(row[col], `${slug}.${col} range`).toBeGreaterThanOrEqual(1)
          expect(row[col], `${slug}.${col} range`).toBeLessThanOrEqual(366)
        }
      }
    }
  })

  // The two deliberate-NULL lists are the only record that a NULL harvest_habit was DECIDED rather
  // than missed — the column itself cannot tell the two apart, which is the whole reason they exist.
  // Nothing bound them before, so a slug could drift off one and start reading as an unfilled gap.
  it('no slug is both seeded and recorded as a deliberate NULL', () => {
    // A slug on both sides is a contradiction the DB cannot express: 0b-data.sql would write a value
    // into a column the exclusion list says is deliberately NULL. This is the failure mode of adding
    // to either list without checking the other.
    // Three lists now, not two: establishing_not_yet_harvestable joined them on 2026-08-17. It is in
    // this union for the same reason the other two are — it records a deliberate NULL — and leaving
    // it out would let a slug be both "not yet harvestable" and seeded with a live habit.
    const decided = [
      ...doc.not_harvest_tracked.slugs,
      ...doc.unseeded_vocabulary.slugs,
      ...Object.keys(doc.establishing_not_yet_harvestable.entries),
    ]
    const both = decided.filter(s => s in authored).sort()
    expect(both, 'seeded in by_crop_type AND listed as a deliberate NULL').toEqual([])
    expect(new Set(decided).size, 'a slug is listed twice across the two NULL lists').toBe(decided.length)
  })

  it('the ornamental/succulent NULLs added 2026-08-17 are recorded', () => {
    // aloe, calibrachoa and lantana each carry one live planting and zero picks and had drifted out
    // of the list, so their NULL habit read as a coverage gap. ginger is deliberately NOT here — but
    // no longer because it is an open question. V4-GINGERCOLD-001: the decision IS recorded, in
    // establishing_not_yet_harvestable, and the reason ginger stays out of THIS list is that the list
    // means ornamental / will-not-fruit-here, which ginger is not. Asserting the positive home as
    // well as the negative one is what stops the exclusion from decaying back into a bare gap.
    // (bee_balm is already listed, with its own `contested` note.)
    const listed = new Set(doc.not_harvest_tracked.slugs)
    for (const slug of ['aloe', 'calibrachoa', 'lantana']) expect(listed.has(slug), slug).toBe(true)
    expect(listed.has('ginger'), 'ginger is edible and intended to be eaten — not an ornamental NULL').toBe(false)
    expect('ginger' in doc.establishing_not_yet_harvestable.entries,
      'excluded from not_harvest_tracked ONLY because it is recorded as establishing').toBe(true)
  })

  it("ginger's habit is recorded as ESTABLISHING, and never as not_harvest_tracked", () => {
    // V4-TROPICALCOLD-001. Ginger stopped being "an open question" on 2026-08-17 — the answer is
    // known (Dave will harvest it, but not this year) and is now written down. What must NOT happen
    // is it landing in not_harvest_tracked: that list means ornamental / will-not-fruit-here, and
    // recording it there would assert a decision Dave never made about an edible plant he intends to
    // eat. The habit stays NULL so no readiness predicate fires this season.
    const g = doc.establishing_not_yet_harvestable.entries.ginger
    expect(g, 'ginger must carry an explicit establishing record').toBeTruthy()
    expect(g.harvest_this_season, 'no harvest this season').toBe(false)
    expect(g.intended_harvest_habit, 'the eventual habit, documented not seeded').toBe('single')
    expect(g.release_condition && g.release_condition.length, 'a release condition is required').toBeGreaterThan(20)
    expect(new Set(doc.not_harvest_tracked.slugs).has('ginger')).toBe(false)
    expect('ginger' in authored, 'seeding it would let a readiness predicate fire').toBe(false)
  })

  it('DOY windows are set only where being outside the window is actively harmful', () => {
    // The window is a SUPPRESSOR, not a trigger. Asparagus (cutting after ~Jun 15 damages the crown)
    // and garlic (lift outside the window and the bulb will not store) are the only two crops that
    // clear that bar. A merely-typical season window would suppress true signals, so a new entry
    // here is a design decision that must be made deliberately — not a value someone adds in passing.
    const windowed = [...seed.entries()]
      .filter(([, r]) => r.harvest_season_start_doy !== null)
      .map(([s]) => s)
      .sort()
    expect(windowed).toEqual(['asparagus', 'garlic'])
  })
})
