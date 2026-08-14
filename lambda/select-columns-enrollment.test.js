// OPS-L081COLS-001 — the L-081 schema audit's Phase 1 enrollment ratchet.
//
// THE PROBLEM, in the ledger's own words: "a vacuous gate is worse than an absent one because it
// gets cited as evidence. It was, in this ledger."
//
// scripts/dev-main-schema-audit.py Phase 1 audits SELECT columns by reading
// lambda/**/select-columns.test.js. It audits NOTHING for a Lambda that has no such file — and it
// reports success either way. So `L-081 Schema Audit (dev)` goes green on a commit whose entire
// delta was columns added to an unenrolled Lambda's SELECT, and that green check then gets cited as
// coverage. That already happened once (commit 89df744f; see lambda/harvests/select-columns.test.js,
// which was written to close that specific hole).
//
// WHAT THIS FILE DOES. It cannot conjure the missing coverage — enrolling a Lambda means reading its
// real SELECTs and pinning real columns, which is per-Lambda work. What it CAN do is make the gap
// impossible to mistake for coverage:
//
//   1. Every Lambda is ENROLLED, NAMED in UNENROLLED, or PROVEN read-free. Silence is not an option.
//   2. UNENROLLED cannot GROW. A newly added Lambda fails this test until someone either enrols it
//      or deliberately adds it to the list — a new Lambda can never be born silently uncovered.
//   3. UNENROLLED cannot go STALE. Enrolling a Lambda without removing it from this list fails, so
//      the list can never overstate the debt and quietly re-hide a covered Lambda.
//
// The ratchet only tightens: the correct edit to this file is always to DELETE a line from
// UNENROLLED and lower MAX_UNENROLLED. Phases 2 and 3 of the audit (INSERT column lists, soft-delete
// deleted_at) read index.js directly and are NOT vacuous — this gap is Phase 1 only, which is why
// the list below is about SELECT coverage specifically.
import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const LAMBDA_DIR = resolve(process.cwd(), 'lambda')

// Lambdas with NO select-columns.test.js as of 2026-08-14. Their SELECT columns are UNAUDITED
// against prod's information_schema — an L-081 incident (column exists in staging, not prod, every
// endpoint 500s on deploy) would not be caught for these.
// 2026-08-14: 22 -> 0. Every Lambda that reads a row is now enrolled, `events` included. The list is
// kept (empty) rather than deleted because its job now is to stay empty: a new Lambda lands here or
// gets enrolled, and either way it cannot be born silently uncovered.
const UNENROLLED = []

// STRUCTURALLY EXEMPT, not debt. Phase 1 audits SELECT columns; a Lambda that never reads a row has
// no SELECT columns to contract, so counting it as "unenrolled" overstates the gap — and an
// overstated gap is the same species of misleading number as the vacuous green this row is about.
// Verified below rather than trusted — and that verification EARNED ITS KEEP on 2026-08-14: an
// earlier version of it scanned only index.js, and only sql`` templates, and on that basis wrongly
// exempted `members`, which reads locations and inventory_items from a SIBLING module. The check now
// walks the whole Lambda and understands node-postgres .query() too. A guard that only inspects the
// obvious file in the obvious dialect is the same vacuous gate this row is about.
const NO_SQL_READS = [
  'app-events', // sql`` present but INSERT-only (rate_limit_buckets upsert). No FROM, so no SELECT contract.
]

// Ceiling, not a target. Lower it with every enrolment; never raise it without a ledger row saying
// why a new Lambda shipped uncovered.
const MAX_UNENROLLED = UNENROLLED.length

const lambdas = readdirSync(LAMBDA_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== 'node_modules')
  .map((e) => e.name)
  .filter((n) => existsSync(join(LAMBDA_DIR, n, 'index.js')))
  .sort()

const isEnrolled = (n) => existsSync(join(LAMBDA_DIR, n, 'select-columns.test.js'))

// Every non-test .js in the Lambda, in BOTH query dialects. See the NO_SQL_READS note above for why
// anything narrower than this is not good enough to base an exemption on.
function lambdaSql(dir) {
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name)
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full) }
      else if (/\.js$/.test(e.name) && !/\.test\.js$/.test(e.name)) {
        const src = readFileSync(full, 'utf8')
          .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n')
        out.push(...(src.match(/sql`[\s\S]*?`/g) ?? []))
        out.push(...(src.match(/\.query\(\s*[`'"][\s\S]*?[`'"]/g) ?? []))
      }
    }
  }
  walk(dir)
  return out.join('\n')
}

describe('L-081 Phase 1 enrollment ratchet (OPS-L081COLS-001)', () => {
  it('discovers the Lambda set — guards against this ratchet itself going vacuous', () => {
    // Same floor rationale as the list it guards: if the walk breaks, every assertion below would
    // pass over an empty set and this file would become the thing it exists to prevent.
    expect(lambdas.length).toBeGreaterThanOrEqual(20)
    expect(lambdas).toContain('harvests')
  })

  it('accounts for EVERY Lambda — enrolled, named as unaudited, or proven read-free', () => {
    const unaccounted = lambdas.filter((n) => !isEnrolled(n)
      && !UNENROLLED.includes(n) && !NO_SQL_READS.includes(n))
    expect(unaccounted).toEqual([])
  })

  it('proves each exempt Lambda really has no SQL read — an exemption must not rot', () => {
    // The exemption is only honest while it is true. If one of these grows a SELECT, it becomes real
    // Phase 1 debt and has to move to UNENROLLED (or get enrolled) — this is what forces that.
    const nowReads = NO_SQL_READS.filter((n) => /\bFROM\s+/i.test(lambdaSql(join(LAMBDA_DIR, n))))
    expect(nowReads).toEqual([])
  })

  it('keeps the two lists disjoint — a Lambda cannot be both exempt and owed', () => {
    expect(UNENROLLED.filter((n) => NO_SQL_READS.includes(n))).toEqual([])
  })

  it('never lets UNENROLLED grow — a new Lambda cannot be born silently uncovered', () => {
    expect(UNENROLLED.length).toBeLessThanOrEqual(MAX_UNENROLLED)
    // Exempt Lambdas are excluded: they are unenrolled by nature, not by debt, and the previous test
    // proves that claim rather than taking it on trust. Counting them here would make the ceiling
    // track a number that cannot be paid down.
    const stillOwed = lambdas.filter((n) => !isEnrolled(n) && !NO_SQL_READS.includes(n))
    expect(stillOwed.length).toBeLessThanOrEqual(MAX_UNENROLLED)
  })

  it('never lets UNENROLLED go stale — an enrolled Lambda must leave the list', () => {
    // Without this, enrolling a Lambda and forgetting the list would leave it listed as unaudited
    // forever, understating real coverage and inviting someone to "re-enrol" what is already done.
    const wrongly = UNENROLLED.filter((n) => isEnrolled(n))
    expect(wrongly).toEqual([])
  })

  it('lists no Lambda that does not exist — a rename must not silently drop coverage', () => {
    const ghosts = [...UNENROLLED, ...NO_SQL_READS].filter((n) => !lambdas.includes(n))
    expect(ghosts).toEqual([])
  })
})
