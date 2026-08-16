// anchor-supersede-parity.test.js — V4-ANCHORSUPERSEDE-001, cross-site drift guard.
//
// The supersede rule is now written in FOUR places, and it has to be: each Lambda is zipped from its
// own directory, so a shared module would not be packaged and the handler would 502 at module load.
// The copies are therefore deliberate, and this file is what stops them diverging:
//
//   1. migrations/v4-anchorbase-001/0b-backfill.sql — the canonical statement (second transaction).
//   2. lambda/plants/index.js       — PUT, the single place every client's anchor write converges.
//   3. lambda/plants/merge.js       — the merge cutover, which can hand the WINNER a real date.
//   4. lambda/daily-plan/handler.js — the nightly sweep, backstop for non-app writers and the only
//                                     healer for rows that went stale before the write path shipped.
//
// The set of OBSERVED columns is owned by lambda/harvests/anchorDerive.js (OBSERVED_ANCHOR_FIELDS,
// layer 2 of the marking rule). It is IMPORTED here rather than restated, so adding a fourth observed
// column to the derivation logic and forgetting the SQL fails this test instead of silently leaving
// derivations live beside a date the app already treats as real.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OBSERVED_ANCHOR_FIELDS } from './harvests/anchorDerive.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (...p) => readFileSync(resolve(__dirname, ...p), 'utf8')

const SITES = {
  '0b-backfill.sql': read('..', 'migrations', 'v4-anchorbase-001', '0b-backfill.sql'),
  'plants/index.js': read('plants', 'index.js'),
  'plants/merge.js': read('plants', 'merge.js'),
  'daily-plan/handler.js': read('daily-plan', 'handler.js'),
}

// The retiring statement from one site, from the UPDATE keyword to the end of its predicate. Each
// site writes it in its own dialect (schema-qualified or not, neon placeholders or none), so the
// slice is bounded by the statement terminator each dialect actually uses.
function retireBlock(src) {
  const i = src.search(/update\s+(public\.)?plant_anchor_derivation\s+d\b/i)
  if (i === -1) return null
  const rest = src.slice(i)
  const end = rest.search(/(;|`\)|`,|`;)/)
  return end === -1 ? rest : rest.slice(0, end)
}

describe('the supersede rule is identical at every site that writes it', () => {
  it('found the statement at all four sites — an empty slice would pass everything below', () => {
    for (const [name, src] of Object.entries(SITES)) {
      expect(retireBlock(src), `no supersede statement found in ${name}`).toBeTruthy()
    }
    expect(Object.keys(SITES)).toHaveLength(4)
  })

  it.each(Object.keys(SITES))('%s gates on every OBSERVED_ANCHOR_FIELD', (name) => {
    const block = retireBlock(SITES[name])
    expect(OBSERVED_ANCHOR_FIELDS.length).toBeGreaterThanOrEqual(3)
    for (const field of OBSERVED_ANCHOR_FIELDS) {
      expect(new RegExp(`\\.${field}\\s+is\\s+not\\s+null`, 'i').test(block),
        `${name} does not test ${field} — a derivation would stay live beside a real date`).toBe(true)
    }
  })

  it.each(Object.keys(SITES))('%s is idempotent and names the reason', (name) => {
    const block = retireBlock(SITES[name])
    expect(/superseded_at\s+is\s+null/i.test(block), `${name} lost its re-run guard`).toBe(true)
    expect(/superseded_by\s*=\s*'observed_anchor'/i.test(block),
      `${name} retires without recording why — the calibration extract cannot tell this apart ` +
      'from a merge retirement').toBe(true)
  })

  it('no site ever DELETEs a derivation', () => {
    // The (guess, later truth) pair is the ONLY ground truth the add-date baseline tier will ever
    // get. Deleting a contradicted row throws away the measurement the backfill exists to create.
    for (const [name, src] of Object.entries(SITES)) {
      expect(new RegExp('delete\\s+from\\s+(public\\.)?plant_anchor_derivation', 'i').test(src),
        `${name} deletes from plant_anchor_derivation — retire, never erase`).toBe(false)
    }
  })
})
