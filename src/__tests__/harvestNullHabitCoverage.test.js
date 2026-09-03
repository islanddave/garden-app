import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import yaml from 'js-yaml'

// V4-HARVHABITGAP-001 coverage gate. Sibling of harvestAttributesSync.test.js: that one binds
// `by_crop_type` to the generated 0b-data.sql seed, and deliberately never looks at the three
// DELIBERATE-NULL lists (`not_harvest_tracked`, `unseeded_vocabulary`,
// `establishing_not_yet_harvestable`). Those three are the whole record of WHY a crop_types row has
// no harvest_habit, and until this file existed they had zero binding of any kind — which is how the
// same omission happened three times: aloe/calibrachoa/lantana (caught 2026-08-17), dogwood (caught
// 2026-08-20, minted by v4-croptypedogwood-001 the same week), and twelve never-grown perennial fruit
// slugs that were on no list at all since the vocabulary was minted.
//
// The invariant that actually catches a NEW unexplained NULL has to see live crop_types, so it is a
// SQL gate: `post_every_null_habit_is_a_recorded_decision` in
// migrations/v4-harvhabitgap-001/gates.yml, run continuously against prod and staging by
// gate-invariants.yml. That gate carries the slug list inline, so it can drift from the JSON it is
// supposed to enforce. THIS file is the binding that stops it — same JSON->SQL projection shape
// harvestAttributesSync.test.js applies to the seed, pointed at the gate instead.

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')

const JSON_PATH = join(repoRoot, 'src', 'data', 'harvest-attributes-v1.json')
const GATES_PATH = join(repoRoot, 'migrations', 'v4-harvhabitgap-001', 'gates.yml')

const GATE_NAME = 'post_every_null_habit_is_a_recorded_decision'

// The handback gate, added 2026-09-03 (OPS-FROZENALLOWLISTGATES-001). unseeded_vocabulary parks a
// slug with the promise "seed them when something is actually planted", and until that gate existed
// nothing watched for the moment the promise came due. It carries unseeded_vocabulary.slugs inline
// and so needs the same anti-drift binding this file already gives the gate above — an inline list
// nothing binds is exactly how the original three omissions happened.
const UNSEEDED_GATE_NAME = 'post_no_unseeded_slug_has_a_live_planting'

// Version string is byte-identical to the INSERT in 0a-data.sql. The gate is self-arming on it —
// inert until this migration is applied, a real invariant the instant it is — so a typo here or
// there silently disarms the gate forever.
const SCHEMA_VERSION_TAG = '4.35.0-harvhabitgap-001'

// Pulls the quoted slugs out of the gate's `NOT IN (...)` clause. Anchored to NOT IN so the
// self-arm subquery's own literal (the schema_version tag) cannot be mistaken for a slug.
function gateSlugs(sql) {
  const from = sql.indexOf('NOT IN')
  expect(from, `${GATE_NAME} must scope its slugs with NOT IN`).toBeGreaterThan(-1)
  const close = sql.indexOf(')', from)
  expect(close, `${GATE_NAME}'s NOT IN list must be closed`).toBeGreaterThan(from)
  return sql.slice(from, close).match(/'([a-z0-9_]+)'/g).map(s => s.slice(1, -1))
}

describe('every deliberately-NULL harvest_habit is a recorded decision', () => {
  const doc = JSON.parse(readFileSync(JSON_PATH, 'utf8'))
  const gates = yaml.load(readFileSync(GATES_PATH, 'utf8'))

  const lists = {
    not_harvest_tracked: doc.not_harvest_tracked.slugs,
    unseeded_vocabulary: doc.unseeded_vocabulary.slugs,
    establishing_not_yet_harvestable: Object.keys(doc.establishing_not_yet_harvestable.entries),
  }
  const seeded = Object.keys(doc.by_crop_type)
  const recorded = [...lists.not_harvest_tracked, ...lists.unseeded_vocabulary,
                    ...lists.establishing_not_yet_harvestable]

  const gate = (gates.post || []).find(g => g.name === GATE_NAME)

  it('the coverage gate is still present in gates.yml under the name this test binds', () => {
    // Without this, deleting or renaming the gate would make every assertion below vacuous — the
    // guard would disappear and the suite would stay green.
    expect(gate, `${GATE_NAME} must exist in ${GATES_PATH}`).toBeDefined()
    expect(gate.expect).toBe('scalar_eq')
    expect(gate.value).toBe(0)
    // `continuous` defaults to TRUE in gate_runner.py. Setting it false here would demote the gate
    // to an apply-window check and leave the invariant unenforced forever after, so assert it was
    // not set at all.
    expect(gate.continuous, `${GATE_NAME} must stay continuous`).toBeUndefined()
    expect(gate.sql).toContain(SCHEMA_VERSION_TAG)
  })

  it('parses a non-trivial number of slugs out of the gate (guards a silently-broken match)', () => {
    expect(gateSlugs(gate.sql).length).toBeGreaterThan(60)
  })

  it('the gate list is exactly the union of the three deliberate-NULL lists', () => {
    // The projection. A slug added to a list but not the gate leaves a real NULL unguarded; a slug
    // added to the gate but not a list lets an unexplained NULL through with no written reason.
    const inGate = [...new Set(gateSlugs(gate.sql))].sort()
    const inJson = [...new Set(recorded)].sort()
    expect(inJson.filter(s => !inGate.includes(s)), 'recorded in the JSON but not excused by the gate').toEqual([])
    expect(inGate.filter(s => !inJson.includes(s)), 'excused by the gate but recorded on no JSON list').toEqual([])
  })

  it('no slug is recorded twice across the three deliberate-NULL lists', () => {
    // Two lists give two different reasons for the same NULL, and only one of them can be true.
    const dupes = recorded.filter((s, i) => recorded.indexOf(s) !== i)
    expect([...new Set(dupes)].sort()).toEqual([])
  })

  it('no slug is both seeded and deliberately NULL', () => {
    // The bee_balm failure mode: promoting a slug into by_crop_type without removing it from
    // not_harvest_tracked would have the file assert a habit and assert no-habit at once. That
    // removal was done by hand on 2026-08-18; nothing checked it.
    expect(recorded.filter(s => seeded.includes(s)).sort()).toEqual([])
  })

  it('every contested slug is resolved onto exactly one side', () => {
    // `contested` records arguments, including for slugs deliberately NOT on the list (bee_balm,
    // nasturtium). Each still has to land somewhere: seeded, or recorded as NULL. Neither is a slug
    // whose status was debated and then dropped.
    for (const slug of Object.keys(doc.not_harvest_tracked.contested)) {
      const isSeeded = seeded.includes(slug)
      const isRecorded = recorded.includes(slug)
      expect(isSeeded || isRecorded, `contested '${slug}' is on no list and in no seed`).toBe(true)
      expect(isSeeded && isRecorded, `contested '${slug}' is both seeded and recorded NULL`).toBe(false)
    }
  })
})

// Pulls the quoted slugs out of a positive `slug IN (...)` clause. Anchored to `c.slug IN` rather
// than a bare `IN` so the self-arm subquery cannot contribute its schema_version literal, mirroring
// why gateSlugs above anchors to NOT IN.
function positiveGateSlugs(sql, gateName) {
  const from = sql.indexOf('c.slug IN')
  expect(from, `${gateName} must scope its slugs with c.slug IN`).toBeGreaterThan(-1)
  const close = sql.indexOf(')', from)
  expect(close, `${gateName}'s IN list must be closed`).toBeGreaterThan(from)
  return sql.slice(from, close).match(/'([a-z0-9_]+)'/g).map(s => s.slice(1, -1))
}

describe('a parked (unseeded) slug hands itself back when it is actually planted', () => {
  const doc = JSON.parse(readFileSync(JSON_PATH, 'utf8'))
  const gates = yaml.load(readFileSync(GATES_PATH, 'utf8'))
  const gate = (gates.post || []).find(g => g.name === UNSEEDED_GATE_NAME)

  it('the handback gate is present under the name this test binds', () => {
    // Same anti-vacuity guard as the sibling above: without this, deleting the gate would silently
    // remove the only mechanism that ends a deferral, and the suite would stay green.
    expect(gate, `${UNSEEDED_GATE_NAME} must exist in ${GATES_PATH}`).toBeDefined()
    expect(gate.expect).toBe('scalar_eq')
    expect(gate.value).toBe(0)
    // The whole point is that it runs forever. continuous: false would demote it to an apply-window
    // check, which is precisely the rot this ledger item was opened to clean up.
    expect(gate.continuous, `${UNSEEDED_GATE_NAME} must stay continuous`).toBeUndefined()
    expect(gate.sql).toContain(SCHEMA_VERSION_TAG)
  })

  it('it still requires BOTH a live planting and a NULL habit', () => {
    // Either arm alone makes the gate meaningless: without the planting clause it duplicates the
    // coverage gate and is red on every parked slug; without the habit clause it fires on carrot,
    // luffa and spinach, which are planted AND already seeded. Measured on prod 2026-09-03:
    // 0 violations as written, 26 with the planting clause removed.
    expect(gate.sql).toMatch(/harvest_habit IS NULL/)
    expect(gate.sql).toMatch(/FROM public\.plants p/)
    expect(gate.sql).toMatch(/p\.deleted_at IS NULL/)
  })

  it('the handback list is exactly unseeded_vocabulary.slugs', () => {
    const inGate = [...new Set(positiveGateSlugs(gate.sql, UNSEEDED_GATE_NAME))].sort()
    const inJson = [...new Set(doc.unseeded_vocabulary.slugs)].sort()
    expect(inJson.filter(s => !inGate.includes(s)), 'parked in the JSON but unwatched by the gate').toEqual([])
    expect(inGate.filter(s => !inJson.includes(s)), 'watched by the gate but parked on no JSON list').toEqual([])
  })
})
