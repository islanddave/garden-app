// V3-ARCHIVE-001 completion: the daily-plan engine query must exclude soft-archived
// plantings (p.archived_at) AND plantings under an archived project (pj.archived_at),
// not just status='archived'. Static source guard (the query is a template literal;
// a live-DB assertion lives in the integration suite). Mirrors events/archive-award.test.js.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RAW = readFileSync(resolve(__dirname, 'handler.js'), 'utf8')

// Line comments stripped (same helper + rationale as blank-name-guard.test.js) so a clause
// DESCRIBED in prose cannot stand in for a clause that actually executes. Both assertions
// below used to run against the raw file, which made them satisfiable by a comment: mutation
// — delete `and p.archived_at is null` from the WHERE at handler.js:252 and leave
// `-- p.archived_at is null` on the line above, same for `pj.archived_at` at :255 — left BOTH
// tests GREEN with every soft-archived planting back in the nightly plan. This file is only
// two assertions, so that mutation reduced its coverage to zero.
const strip = src => src.split('\n').map(l => l.replace(/--.*$/, '').replace(/\/\/.*$/, '')).join('\n')
const SRC = strip(RAW)

// Scope to the plantings query. A bare whole-file match would still pass if the clause moved
// to some unrelated statement, which is the wxcoverloc-class looseness.
const WHERE = (() => {
  const i = SRC.indexOf('where p.deleted_at is null')
  return i > -1 ? SRC.slice(i, i + 600) : ''
})()

describe('daily-plan engine excludes archived (V3-ARCHIVE-001)', () => {
  it('the guard is reading a real WHERE clause (vacuity floor)', () => {
    // Without this, a renamed anchor collapses WHERE to '' and BOTH assertions below become
    // straightforwardly false rather than silently unscoped — but the floor names the cause.
    expect(SRC.length, 'stripped handler.js is implausibly small').toBeGreaterThan(5000)
    expect(WHERE, 'plantings-query WHERE clause not found — extractor anchor moved').not.toBe('')
    expect(WHERE).toMatch(/p\.status not in/)
  })
  it('filters archived plantings (p.archived_at is null)', () => {
    expect(WHERE).toMatch(/\bp\.archived_at is null/)
  })
  it('filters plantings under an archived project (pj.archived_at is null)', () => {
    expect(WHERE).toMatch(/\bpj\.archived_at is null/)
  })
})
