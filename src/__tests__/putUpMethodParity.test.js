// V4-PUTUPTAXONOMY-001 (BD-034) — parity across the SEVEN hand-maintained enumerations of the
// put-up method vocabulary. The design brief identified this test as missing; this is it.
//
// WHY IT IS NEEDED: A WIDENING IS WRITE-SAFE BUT NOT READ-SAFE.
// ------------------------------------------------------------
// The brief's core safety argument is that every Phase-1 constraint change is a widening, so it
// cannot break an old writer. That verifies as TRUE and INCOMPLETE, and the incompleteness is the
// whole reason this file exists. Widening the CHECK is safe for WRITERS — every value a stale
// bundle can send still passes. It is not safe for READERS, because five surfaces enumerate this
// vocabulary by hand and NOT ONE OF THEM ERRORS on a value it has never seen. Each degrades
// silently, in a different direction:
//
//   1. lambda/preservation/index.js :: VALID_METHODS
//      Not a reader — the WRITE gate. Rejects an unlisted method with a 400 before the DB ever sees
//      it. Consequence of omission: the DB CHECK permits the value and the API refuses it, so the
//      migration appears to have done nothing and the picker option is a dead control.
//
//   2. lambda/preservation/index.js :: SHELF_LIFE_MONTHS
//      THE DANGEROUS ONE. shelfLifeMonths() returns null for an unlisted method (:76-81), so
//      defaultUseByTarget() returns null, so use_by_target is never set, so BOTH the use-soon route
//      and the use_soon_count on every whats-put-up group skip the row forever. The jar becomes
//      invisible to the only surface that tells Dave to eat it. Not hypothetical: the single
//      method='other' row in prod ('Vinegar dill pickles') is the only one of five with
//      use_by_target IS NULL, for exactly this reason.
//
//   3. src/pages/PutUp.jsx :: METHOD_GROUPS  — worst FAILURE MODE of the three client maps.
//      It builds the <Select> in BOTH the create form and the row editor. A stored row whose method
//      is not an option gives the <select> a value matching no <option>: the control renders showing
//      the FIRST option instead, and saving that row — for any unrelated edit, including the
//      one-tap "Mark used" path through buildFullPayload — silently REWRITES the method to whatever
//      was displayed. Omission here does not hide data; it destroys it.
//
//   4. src/components/PutUpUseSoonBand.jsx :: METHOD_LABELS
//      itemDetail() does `const m = METHOD_LABELS[it.method]; if (m) parts.push(m)` — an unmapped
//      method is DROPPED from the detail line entirely. The jar renders as though no method were
//      ever recorded, with no slug and no placeholder to hint that something is missing.
//
//   5. src/components/planting/PutUpFromPlanting.jsx :: METHOD_LABELS
//      `METHOD_LABELS[r.method] || r.method` — the mildest: falls back to the raw slug, so the
//      planting page reads "ferment_mash" at the user. Ugly rather than wrong, and still a defect.
//
// And two surfaces that are not readers but must not drift out of step with the vocabulary:
//   6. migrations/v4-putupmethod-001/0a-additive-ddl.sql — the DB CHECK itself, the source of truth.
//   7. migrations/v4-putupmethod-001/0r-rollback.sql — the NARROWING. It must be exactly the
//      fourteen pre-existing values: narrower and the rollback destroys a value that was never
//      added by this migration; wider and it fails to roll anything back.
//
// STATIC SOURCE INSPECTION, deliberately. index.js imports neon/clerk/aws and cannot be imported
// under the unit run, and none of the three client maps is exported. Same technique and precedent as
// preservationColumnParity.test.js and harvestAttributesSync.test.js.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (p) => readFileSync(resolve(root, p), 'utf8')

const migrationSql = read('migrations/v4-putupmethod-001/0a-additive-ddl.sql')
const rollbackSql = read('migrations/v4-putupmethod-001/0r-rollback.sql')
const gatesYml = read('migrations/v4-putupmethod-001/gates.yml')
const lambdaSrc = read('lambda/preservation/index.js')
const pageSrc = read('src/pages/PutUp.jsx')
const bandSrc = read('src/components/PutUpUseSoonBand.jsx')
const plantingSrc = read('src/components/planting/PutUpFromPlanting.jsx')

// Comments in every one of these files legitimately quote method values while DISCUSSING them —
// this file's own subject matter guarantees it. Stripping them first is what stops a prose mention
// of 'other' or 'quick_pickle' from being counted as a vocabulary entry, which would make every
// assertion below pass for the wrong reason.
const stripSql = (s) => s.replace(/--[^\n]*/g, '')
const stripJs = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

function between(src, startMarker, endMarker, label) {
  const from = src.indexOf(startMarker)
  expect(from, `${label}: start marker not found — this file has been restructured`).toBeGreaterThan(-1)
  const to = src.indexOf(endMarker, from + startMarker.length)
  expect(to, `${label}: end marker not found — this file has been restructured`).toBeGreaterThan(from)
  return src.slice(from, to)
}

// ── The vocabulary, as each surface spells it ────────────────────────────────────────────────────

function checkConstraintValues(sql, label) {
  const block = stripSql(between(sql, 'ADD CONSTRAINT chk_preservation_log_method', '));', label))
  return new Set([...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]))
}

const DB_VOCAB = checkConstraintValues(migrationSql, '0a CHECK')
const ROLLBACK_VOCAB = checkConstraintValues(rollbackSql, '0r CHECK')

const VALID_METHODS = new Set(
  [...stripJs(between(lambdaSrc, 'const VALID_METHODS = [', '];', 'VALID_METHODS'))
    .matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
)

// Top-level keys only: two-space indent then `{`. The nested storage-kind keys (deep_freezer: 12)
// are further indented and never followed by a brace, so they cannot be mistaken for methods.
const shelfBlock = stripJs(between(lambdaSrc, 'const SHELF_LIFE_MONTHS = {', '\n};', 'SHELF_LIFE_MONTHS'))
const SHELF_ENTRIES = new Map(
  [...shelfBlock.matchAll(/^ {2}(\w+):\s*\{([^}]*)\}/gm)].map((m) => [m[1], m[2]]),
)
const SHELF_METHODS = new Set(SHELF_ENTRIES.keys())

const METHOD_GROUPS = new Set(
  [...stripJs(between(pageSrc, 'const METHOD_GROUPS = [', 'const METHOD_LABELS', 'METHOD_GROUPS'))
    .matchAll(/value: '([a-z_]+)'/g)].map((m) => m[1]),
)

const labelKeys = (src, label) => new Set(
  [...stripJs(between(src, 'const METHOD_LABELS = {', '\n}', label)).matchAll(/(\w+):/g)].map((m) => m[1]),
)
const BAND_LABELS = labelKeys(bandSrc, 'PutUpUseSoonBand METHOD_LABELS')
const PLANTING_LABELS = labelKeys(plantingSrc, 'PutUpFromPlanting METHOD_LABELS')

// The fourteen that existed before BD-034. Pinned rather than derived, because "the rollback equals
// the forward list minus the four new values" is the claim under test — deriving it from the same
// source it is being compared against would assert nothing.
const PRE_BD034 = [
  'roast_freeze', 'whole_freeze', 'blanch_freeze', 'dehydrate', 'powder', 'passata',
  'can_water_bath', 'can_pressure', 'jam_preserve', 'ferment', 'cure_store', 'cold_store',
  'purchased_preserved', 'other',
]
const ADDED_BY_BD034 = ['quick_pickle', 'pesto', 'hot_sauce', 'ferment_mash']

const sorted = (s) => [...s].sort()

describe('V4-PUTUPTAXONOMY-001 — the parse is looking at something real', () => {
  // Without this, a restructured file that made every slice empty would satisfy every set-equality
  // below by comparing two empty sets — a green test asserting nothing, which is the exact failure
  // class this file exists to prevent elsewhere.
  it.each([
    ['0a CHECK', DB_VOCAB], ['VALID_METHODS', VALID_METHODS], ['SHELF_LIFE_MONTHS', SHELF_METHODS],
    ['METHOD_GROUPS', METHOD_GROUPS], ['use-soon labels', BAND_LABELS], ['planting labels', PLANTING_LABELS],
  ])('%s parsed to a populated vocabulary', (_label, set) => {
    expect(set.size).toBe(18)
  })

  it('the rollback parsed to the fourteen-value vocabulary', () => {
    expect(ROLLBACK_VOCAB.size).toBe(14)
  })

  it('the migration widens rather than replaces', () => {
    for (const v of PRE_BD034) expect(DB_VOCAB.has(v), `${v} was dropped by the widening`).toBe(true)
    for (const v of ADDED_BY_BD034) expect(DB_VOCAB.has(v), `${v} was never added`).toBe(true)
  })

  // The canning safety split is the one distinction in this vocabulary that decides whether a jar
  // is safe to eat, not merely how it is labelled. A DROP + ADD that collapsed the two into a bare
  // `can` would pass every set-equality above if the other surfaces were collapsed to match.
  it('never introduces a bare `can` value', () => {
    for (const set of [DB_VOCAB, ROLLBACK_VOCAB, VALID_METHODS, METHOD_GROUPS]) {
      expect(set.has('can')).toBe(false)
    }
    expect(DB_VOCAB.has('can_water_bath') && DB_VOCAB.has('can_pressure')).toBe(true)
  })
})

describe('every surface spells the same vocabulary', () => {
  it.each([
    ['lambda VALID_METHODS (the write gate)', () => VALID_METHODS],
    ['lambda SHELF_LIFE_MONTHS (use-by, or silence)', () => SHELF_METHODS],
    ['PutUp.jsx METHOD_GROUPS (the picker, and the row editor that rewrites on save)', () => METHOD_GROUPS],
    ['PutUpUseSoonBand METHOD_LABELS (drops an unmapped method silently)', () => BAND_LABELS],
    ['PutUpFromPlanting METHOD_LABELS (falls back to the raw slug)', () => PLANTING_LABELS],
  ])('%s matches the DB CHECK exactly', (_label, get) => {
    expect(sorted(get())).toEqual(sorted(DB_VOCAB))
  })

  it('the rollback narrows to exactly the pre-BD-034 fourteen', () => {
    expect(sorted(ROLLBACK_VOCAB)).toEqual([...PRE_BD034].sort())
  })
})

describe('a new method cannot ship without a shelf life', () => {
  // The crucible's hard precondition, encoded. `purchased_preserved` and `other` are the only two
  // values with an honest reason to have no shelf life — acquisition age is unknown for one and the
  // method is literally undescribed for the other. Any THIRD entry here is a new use-soon blind
  // spot, which is the half-ship trap that already swallowed one of five live prod rows.
  it('only purchased_preserved and other resolve to a null default', () => {
    const nullDefault = [...SHELF_ENTRIES.entries()]
      .filter(([, body]) => /default:\s*null/.test(body))
      .map(([m]) => m)
      .sort()
    expect(nullDefault).toEqual(['other', 'purchased_preserved'])
  })

  it.each(ADDED_BY_BD034)('%s has a usable default shelf life', (m) => {
    const body = SHELF_ENTRIES.get(m)
    expect(body, `${m} is absent from SHELF_LIFE_MONTHS`).toBeTruthy()
    const match = /default:\s*(\d+)/.exec(body)
    expect(match, `${m} has no numeric default — use-soon will never surface it`).toBeTruthy()
    expect(Number(match[1])).toBeGreaterThan(0)
  })
})

describe('the apply-time gates assert the same vocabulary the code does', () => {
  // The gates are what actually runs against staging and prod. A gate file listing sixteen of
  // eighteen values would let a lost value through the one check that happens on the real database.
  it.each([...PRE_BD034, ...ADDED_BY_BD034])('gates.yml names %s', (v) => {
    // Twice: once in the L-058 sweep (every live row satisfies the new vocabulary) and once in
    // post_all_eighteen_values_present. A single occurrence means one of the two lists is short.
    const hits = gatesYml.split(`'${v}'`).length - 1
    expect(hits, `expected ${v} in both the sweep list and the post ARRAY`).toBeGreaterThanOrEqual(2)
  })
})
