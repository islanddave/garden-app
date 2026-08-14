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
//   1. Every Lambda is either ENROLLED or NAMED in UNENROLLED below. Silence is no longer an option.
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
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const LAMBDA_DIR = resolve(process.cwd(), 'lambda')

// Lambdas with NO select-columns.test.js as of 2026-08-14. Their SELECT columns are UNAUDITED
// against prod's information_schema — an L-081 incident (column exists in staging, not prod, every
// endpoint 500s on deploy) would not be caught for these.
// 2026-08-14: 22 -> 21. `locations` enrolled (lambda/locations/select-columns.test.js).
const UNENROLLED = [
  'achievements', 'app-events', 'critter', 'daily-plan', 'daily-plan-read', 'dashboard',
  'events', 'evidence-ingest', 'facebook-share', 'favorites', 'findings', 'inventory-items',
  'members', 'photos', 'preservation', 'shared-state', 'storage-location',
  'tags', 'ux-events', 'xp-reconcile',
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

describe('L-081 Phase 1 enrollment ratchet (OPS-L081COLS-001)', () => {
  it('discovers the Lambda set — guards against this ratchet itself going vacuous', () => {
    // Same floor rationale as the list it guards: if the walk breaks, every assertion below would
    // pass over an empty set and this file would become the thing it exists to prevent.
    expect(lambdas.length).toBeGreaterThanOrEqual(20)
    expect(lambdas).toContain('harvests')
  })

  it('accounts for EVERY Lambda — enrolled, or explicitly named as unaudited', () => {
    const unaccounted = lambdas.filter((n) => !isEnrolled(n) && !UNENROLLED.includes(n))
    expect(unaccounted).toEqual([])
  })

  it('never lets UNENROLLED grow — a new Lambda cannot be born silently uncovered', () => {
    expect(UNENROLLED.length).toBeLessThanOrEqual(MAX_UNENROLLED)
    const stillMissing = lambdas.filter((n) => !isEnrolled(n))
    expect(stillMissing.length).toBeLessThanOrEqual(MAX_UNENROLLED)
  })

  it('never lets UNENROLLED go stale — an enrolled Lambda must leave the list', () => {
    // Without this, enrolling a Lambda and forgetting the list would leave it listed as unaudited
    // forever, understating real coverage and inviting someone to "re-enrol" what is already done.
    const wrongly = UNENROLLED.filter((n) => isEnrolled(n))
    expect(wrongly).toEqual([])
  })

  it('lists no Lambda that does not exist — a rename must not silently drop coverage', () => {
    const ghosts = UNENROLLED.filter((n) => !lambdas.includes(n))
    expect(ghosts).toEqual([])
  })
})
