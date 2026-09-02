// V4-SEEDHISTORY-001 — the drift guard for the seed-stage vocabulary.
//
// src/components/seed/seedStages.js is the FOURTH declaration of the same three values. The other
// three are the DB CHECKs (two of them, on inventory_items and on seed_lot_stage_log), the Lambda
// (twice — the /seed-stage route and the wide PUT), and SavedSeeds.jsx's module-local STAGES. None
// of them can import from any other, so the only thing standing between them is a test that reads
// all four and fails when one moves.
//
// This is the shape preservationProvenance.test.js uses for its own three-place vocabulary
// (VALID_SOURCE_KINDS / the DB constraint / PUTUP_SOURCE_OPTIONS), and it is here for the same
// reason: a value added in one place and not the others is a 500 from a constraint violation on a
// surface that looked fine in review.
//
// EVERY SCRAPE ASSERTS ITS OWN MATCH FIRST. A regex that stops matching because a declaration was
// renamed would otherwise pass vacuously, which is the failure mode a source-text guard is most
// prone to — it would report agreement between this file and nothing at all.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { SEED_STAGES, SEED_STAGE_LABELS, SEED_STAGE_OPTIONS, seedStageLabel } from '../components/seed/seedStages.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8')

// Pull the quoted strings out of a `const NAME = [ ... ]` literal.
function jsArrayLiteral(src, declName, where) {
  const m = src.match(new RegExp(`\\b${declName}\\s*=\\s*\\[([^\\]]*)\\]`))
  expect(m, `${declName} not found in ${where} — renamed, moved, or reformatted across lines`).toBeTruthy()
  return [...m[1].matchAll(/'([^']*)'/g)].map(x => x[1])
}

// Pull the quoted strings out of a SQL `IN ('a', 'b')` list following a named column. The leading
// \b is load-bearing: without it, `stage` matches inside `seed_stage`, both scrapes land on the
// FIRST constraint in the file, and the log-table CHECK below is never actually read. `_` is a word
// character, so the boundary is what keeps the two columns distinct.
function sqlInList(src, column, where) {
  const m = src.match(new RegExp(`\\b${column}\\s+IN\\s*\\(([^)]*)\\)`))
  expect(m, `${column} IN (...) not found in ${where}`).toBeTruthy()
  return [...m[1].matchAll(/'([^']*)'/g)].map(x => x[1])
}

describe('seed-stage vocabulary — one set, four declarations', () => {
  it('is the exact three-value set, in process order', () => {
    // A literal pin, not a length check: `stored` is terminal and `fermenting` is the wet entry
    // point, so the ORDER is meaning here and not presentation. It is also what the option list
    // below inherits.
    expect(SEED_STAGES).toEqual(['fermenting', 'drying', 'stored'])
  })

  it('matches inventory_items_seed_stage_check in the migration that created it', () => {
    const ddl = read('migrations/v4-seedsaveflow-001/0a-ddl.sql')
    expect(sqlInList(ddl, 'seed_stage', '0a-ddl.sql')).toEqual(SEED_STAGES)
  })

  it('matches seed_lot_stage_log_stage_check — the column the history panel renders', () => {
    // The second CHECK, on the LOG table. A value legal on the lot but not in the log would 500 the
    // /seed-stage POST rather than fail validation, so the two constraints are pinned separately.
    const ddl = read('migrations/v4-seedsaveflow-001/0a-ddl.sql')
    expect(sqlInList(ddl, 'stage', '0a-ddl.sql')).toEqual(SEED_STAGES)
  })

  it('matches BOTH Lambda declarations — the /seed-stage route and the wide PUT', () => {
    const handler = read('lambda/inventory-items/index.js')
    // The route's own copy, which validates the POST body's `stage`.
    expect(jsArrayLiteral(handler, 'STAGES', 'lambda/inventory-items/index.js')).toEqual(SEED_STAGES)
    // The wide PUT's copy, which validates `seed_stage` — the key the control on InventoryDetail
    // sends, and the one whose null-to-clear path this feature made reachable.
    expect(jsArrayLiteral(handler, 'SEED_STAGES', 'lambda/inventory-items/index.js')).toEqual(SEED_STAGES)
  })

  it('matches SavedSeeds.jsx, which cannot export its copy', () => {
    const page = read('src/pages/SavedSeeds.jsx')
    expect(jsArrayLiteral(page, 'STAGES', 'src/pages/SavedSeeds.jsx')).toEqual(SEED_STAGES)
  })

  it('labels every stage, and the option list keeps process order', () => {
    // A missing label would render a raw enum value at the user; a re-ordered option list would
    // teach the wrong sequence on the one control where the sequence IS the information.
    for (const s of SEED_STAGES) expect(typeof SEED_STAGE_LABELS[s]).toBe('string')
    expect(SEED_STAGE_OPTIONS.map(o => o.value)).toEqual(SEED_STAGES)
    expect(SEED_STAGE_OPTIONS.map(o => o.label)).toEqual(['Fermenting', 'Drying', 'Stored'])
  })

  it('renders an unknown stored value as itself rather than hiding it', () => {
    // Select's withStoredValue argument: a value this file does not know about is data, and a
    // blank in its place is how a real value gets silently replaced by whoever "fills in" the box.
    expect(seedStageLabel('sprouting')).toBe('sprouting')
    expect(seedStageLabel(null)).toBe('')
  })
})
