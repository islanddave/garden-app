// seed-mix-seam.int.test.js — release 2a's SEAM, on a real Postgres: the varieties Lambda makes the
// mix, the inventory-items Lambda files a jar under it, and the two agree.
//
// WHY THIS FILE EXISTS. Two lanes built the two halves against stubs, each from the contract's words:
// lane V the route that finds or creates the named mix (POST /api/varieties/blend), lane I the rule that
// a jar gathered from two varieties must be filed under exactly that mix (blend_required). They meet
// on one string — the mix's key — which the varieties Lambda WRITES and the inventory Lambda COMPUTES
// AGAIN from the jar's parents, once in JavaScript and once in SQL. Nothing has run them against each
// other. This file drives the real save flow end to end, the order release 2's client will use:
//   1. POST /api/varieties/blend { create: true } with the parents' varieties
//   2. POST /api/inventory-items with that id and both parents
//   3. GET  /api/inventory-items/:id
// and holds the result to three statements: the lot is filed under a mix; every parent's crop is the
// mix's crop; the mix's components are exactly the parents' distinct varieties.
//
// THE WIRE CONTRACT. tests/contracts/seed-mix.json lists the keys each reply MUST carry
// (R2A-CONTRACT.md sections 2 and 3). Release 2b's client tests build their mocks from that file, so
// every shape in it is checked here against the real handlers' replies: a key the file promises and a
// handler does not send fails this test, not a screen.
//
// WHAT HOLDS THE FILE STILL (pre-push QA review F7). Three things, all here:
//   · `version` and EVERY list and status in the file are entered a second time below (PINNED). A list
//     shortened in the JSON, a status dropped, a refusal removed: this file reds until both copies
//     agree and the number is raised. A client that mocked from an older copy asserts the old number.
//   · `examples` — one recorded reply per route, cut down to the keys the file promises, ids and
//     names replaced by placeholders. Each real reply below is compared with its example BY TYPE,
//     key by key and element by element: a `deleted` that becomes a timestamp, an `exists` that
//     becomes 1, a promised key that goes missing, all fail here. The fixture is the same every run,
//     so which values are null is the same every run too.
//   · To record them again after a deliberate change (then raise `version`):
//       INT_SEAM_RECORD=/some/path.json npx vitest run --config vitest.integration.config.ts \
//         tests/integration/seed-mix-seam.int.test.js
//     writes the captured examples to that path and does NOT compare; paste them into the JSON.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { directSql, callHandler, testRunId, setTestUserId, insertProject } from './_harness.js'
import { assertFixtureId, settle } from './_cleanup.js'
import { seedVarietyFixture, seedMixTeardown } from './_seedLotKit.js'
import { handler as invHandler } from '../../lambda/inventory-items/index.js'
import { handler as varietiesHandler } from '../../lambda/varieties/index.js'
import { handler as plantsHandler } from '../../lambda/plants/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CONTRACT = JSON.parse(readFileSync(join(ROOT, 'tests', 'contracts', 'seed-mix.json'), 'utf8'))

const RUN = testRunId()
const USER = `sms-user-${RUN}`
const MATE = `sms-mate-${RUN}`       // same household as USER, only in the case that says so
const OTHER = `sms-other-${RUN}`     // never in USER's household
const RECORD_TO = process.env.INT_SEAM_RECORD || null

// Both Lambdas name release 2a's schema. One failure that says what to apply.
const [present] = await directSql`
  SELECT to_regclass('public.seed_lot_parent_planting') IS NOT NULL AS links,
         to_regclass('public.variety_blend_component') IS NOT NULL AS components,
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'plant_varieties' AND column_name = 'blend_key') AS blend_key,
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'inventory_items' AND column_name = 'seed_parent_plant_count') AS plant_count,
         to_regclass('public.seed_lot_addition') IS NOT NULL AS additions`
const MISSING = [
  !present.links && 'public.seed_lot_parent_planting (v5-seedmultiparent-001)',
  !present.blend_key && 'plant_varieties.blend_key (v5-varietyblend-001)',
  !present.components && 'public.variety_blend_component (v5-varietyblend-001)',
  !present.plant_count && 'inventory_items.seed_parent_plant_count (v5-seedplantcount-001)',
  !present.additions && 'public.seed_lot_addition (v5-seedlotaddition-001)',
].filter(Boolean)
const READY = MISSING.length === 0

describe('seed mix seam — the schema is on this branch', () => {
  it('the link table, the mix key, the component table and the plant count exist (apply the release 2a migrations before the code that names them)', () => {
    expect(MISSING, `missing on the database this suite forks: ${MISSING.join('; ')}`).toEqual([])
  })
})

let fx
let seq = 0
const state = {}

async function planting(tag, variety, projectId = null) {
  const [p] = await directSql`
    INSERT INTO plants (project_id, name, created_by, variety_id)
    VALUES (${projectId}, ${`${tag}-sms-${RUN}-${seq++}`}, ${USER}, ${variety}) RETURNING id`
  return p.id
}
const inv = (method, path, body, as = USER) => {
  setTestUserId(as)
  return callHandler(invHandler, { method, path, body })
}
const varieties = (method, path, body, as = USER) => {
  setTestUserId(as)
  return callHandler(varietiesHandler, { method, path, body })
}
const lotBody = (extra) => ({
  name: `sms-lot-${RUN}-${seq++}`, type: 'consumable', category: 'seeds', unit: 'packet', quantity_on_hand: 1, ...extra,
})
// Every key the contract file says a reply carries is there. Presence, not value: null is a value.
const expectKeys = (body, keys, what) => {
  for (const key of keys) expect(body, `${what}: "${key}"`).toHaveProperty(key)
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// The file, entered a second time. Everything but `examples`.
// ───────────────────────────────────────────────────────────────────────────────────────────────────
const ADDITIONS_ROUTE = 'POST /api/inventory-items/:id/seed-additions'
const LOT_ROUTES = ['POST /api/inventory-items', 'PUT /api/inventory-items/:id/source-plants', ADDITIONS_ROUTE]
const FILING_ROUTES = ['PUT /api/inventory-items/:id/filing', 'PUT /api/inventory-items/:id/source-plants', ADDITIONS_ROUTE]
const additionRefusal = (status, error) => ({ status, routes: [ADDITIONS_ROUTE], required: ['error', 'code'], error })
const PINNED = {
  name: 'seed-mix',
  version: 3,
  version_rule: 'Raise this number with ANY change to this file. The seam test pins it and pins every list below; a client test that builds mocks from this file asserts the number it was written against.',
  release: 'V5-SEEDMULTIPARENT-001 release 2a / V5-VARIETYBLEND-001 / V5-SEEDLOTADDITION-001 release 3',
  source: 'R2A-CONTRACT.md sections 2 and 3; R3-CONTRACT.md sections 2, 3 and 6.5',
  verified_by: 'tests/integration/seed-mix-seam.int.test.js',
  varieties_blend: {
    route: 'POST /api/varieties/blend',
    request_required: ['component_variety_ids', 'create'],
    statuses: [200, 201],
    other_statuses: [409, 429],
    other_statuses_body: ['error'],
    required: ['id', 'name', 'variety_rank', 'crop_type_slug', 'blend_key', 'exists', 'created', 'components'],
    component_required: ['id', 'name', 'variety_rank', 'deleted'],
    variety_rank: 'blend',
    refusals: { component_unknown: 400, blend_needs_two: 400, blend_too_many: 400, mixed_crop_components: 400 },
  },
  seed_lot: {
    routes: ['POST /api/inventory-items', 'GET /api/inventory-items/:id'],
    statuses: [201, 200],
    required: ['id', 'name', 'variety_id', 'variety_rank', 'source_plant_id', 'source_plants'],
    source_plant_required: ['id', 'name', 'variety_id', 'variety_name', 'breeding_system', 'variety_rank', 'crop_slug', 'archived', 'deleted'],
  },
  source_plants_put: {
    route: 'PUT /api/inventory-items/:id/source-plants',
    request_required: ['source_plant_ids'],
    request_optional: ['expected_source_plant_ids', 'source_plant_id', 'filing'],
    statuses: [200],
    required: ['id', 'source_plant_id', 'source_plants'],
    required_when_filing_sent: ['filing'],
    filing_required: ['variety_id', 'variety_name', 'variety_rank', 'name', 'changed', 'previous'],
    previous_required: ['variety_id', 'name'],
  },
  filing_put: {
    route: 'PUT /api/inventory-items/:id/filing',
    request_required: ['variety_id', 'expect_variety_id'],
    request_optional: ['name'],
    statuses: [200],
    required: ['id', 'variety_id', 'variety_name', 'variety_rank', 'name', 'changed', 'previous'],
    previous_required: ['variety_id', 'name'],
  },
  seed_measure_put: {
    route: 'PUT /api/inventory-items/:id/seed-measure',
    request_optional: [
      'seed_count', 'seed_weight_g', 'seed_count_estimated', 'seed_parent_plant_count',
      'expected_seed_count', 'expected_seed_count_estimated', 'expected_seed_weight_g',
    ],
    statuses: [200, 409],
    required: ['seed_parent_plant_count'],
  },
  seed_additions_post: {
    route: ADDITIONS_ROUTE,
    replay_example: `${ADDITIONS_ROUTE} (replay)`,
    request_required: ['addition_key', 'plant_id', 'expected_source_plant_ids', 'picked_on'],
    request_optional: ['add_seed_count', 'add_estimated', 'add_seed_weight_g', 'filing'],
    request_never: ['name', 'type', 'category'],
    statuses: [200],
    required: [
      'id', 'name', 'variety_id', 'source_plant_id', 'source_plants', 'seed_count', 'seed_count_estimated',
      'seed_weight_g', 'seed_parent_plant_count', 'quantity_on_hand', 'updated_at', 'addition',
    ],
    addition_required: ['id', 'replayed', 'plant_was_added', 'count_applied', 'weight_applied'],
    required_when_filing_sent: ['filing'],
    saved_rule: 'Only a 2xx whose body carries addition.id is a save. A replay (the same addition_key on the same lot) is a 200 with addition.replayed true, the lot as it stands now, and no filing key.',
    refusals: {
      lot_used_up: additionRefusal(409, 'This seed lot is used up or no longer active. Nothing was added.'),
      addition_key_conflict: additionRefusal(409, 'That addition is already recorded against another seed lot.'),
      own_source_lot: additionRefusal(400, 'This plant was grown from this seed lot.'),
      amount_too_large: additionRefusal(400, 'That would make the seed count too large.'),
      variety_mismatch_no_parents: additionRefusal(400, 'This seed lot has no plant on record and is filed under a different variety.'),
      too_many_parents: additionRefusal(400, 'source_plant_ids can name at most 12 plantings'),
    },
  },
  seed_lots_open_get: {
    route: 'GET /api/inventory-items/seed-lots-open',
    query_required: ['plant_id'],
    statuses: [200],
    required: ['plant_id', 'crop_slug', 'open_lots'],
    row_required: [
      'id', 'name', 'variety_id', 'variety_name', 'variety_rank', 'crop_slug', 'seed_stage', 'seed_process',
      'stage_entered_at', 'created_at', 'updated_at', 'seed_count', 'seed_count_estimated', 'seed_weight_g',
      'seed_parent_plant_count', 'quantity_on_hand', 'status', 'source_plant_id', 'is_member', 'same_variety',
      'source_plants',
    ],
    order: 'is_member first, then same_variety, then newest (created_at, then id).',
    failed_rule: 'Anything but a 2xx whose open_lots is an array is the failed state: an older Lambda answers this path 500.',
  },
  plants_seed_lots_get: {
    route: 'GET /api/plants/:id/seed-lots',
    statuses: [200],
    envelope_required: ['plant_id', 'seed_lots'],
    required: [
      'id', 'name', 'seed_stage', 'quantity_on_hand', 'created_at', 'seed_count', 'seed_count_estimated',
      'seed_weight_g', 'variety_name', 'other_parents',
    ],
    other_parent_required: ['id', 'name', 'variety_name'],
  },
  filing_cases: {
    rule: 'same_variety = adding the plant would NOT change what the lot is filed under: the lot\'s variety is the plant\'s, OR a live parent\'s planting has the plant\'s variety. refile = the request must carry `filing`: the mix of the set\'s distinct varieties (the lot\'s parents plus the plant) is not what the lot is filed under now.',
    symbols: 'A, B and C are three varieties of one crop; mix(A,B) is their named mix. null in parent_varieties is a parent planting with no variety.',
    cases: [
      { name: 'one parent of A, filed A, a plant of A', lot_variety: 'A', parent_varieties: ['A'], plant_variety: 'A', same_variety: true, refile: false, refile_to: null },
      { name: 'no plant on record, filed A, a plant of A', lot_variety: 'A', parent_varieties: [], plant_variety: 'A', same_variety: true, refile: false, refile_to: null },
      { name: 'a parent with no variety, filed A, a plant of A', lot_variety: 'A', parent_varieties: [null], plant_variety: 'A', same_variety: true, refile: false, refile_to: null },
      { name: 'one parent of A, filed A, a plant of B', lot_variety: 'A', parent_varieties: ['A'], plant_variety: 'B', same_variety: false, refile: true, refile_to: 'mix(A,B)' },
      { name: 'parents of A and B, filed mix(A,B), a plant of A', lot_variety: 'mix(A,B)', parent_varieties: ['A', 'B'], plant_variety: 'A', same_variety: true, refile: false, refile_to: null },
      { name: 'parents of A and B, filed mix(A,B), a plant of C', lot_variety: 'mix(A,B)', parent_varieties: ['A', 'B'], plant_variety: 'C', same_variety: false, refile: true, refile_to: 'mix(A,B,C)' },
      { name: 'one parent of A, filed by hand under mix(A,B), a plant of B', lot_variety: 'mix(A,B)', parent_varieties: ['A'], plant_variety: 'B', same_variety: false, refile: false, refile_to: null },
    ],
  },
  refusals: {
    parent_without_variety: { status: 400, routes: LOT_ROUTES, required: ['error', 'code', 'plant_id'] },
    mixed_crop_parents: { status: 400, routes: LOT_ROUTES, required: ['error', 'code'] },
    blend_required: { status: 400, routes: LOT_ROUTES, required: ['error', 'code', 'component_variety_ids'] },
    variety_unusable: { status: 400, routes: FILING_ROUTES, required: ['error', 'code'] },
    filing_crop_mismatch: { status: 400, routes: FILING_ROUTES, required: ['error', 'code'] },
    parents_changed: {
      status: 409,
      routes: [...LOT_ROUTES, 'PATCH /api/inventory-items/:id/source-plant'],
      required: ['error', 'code'],
      error: 'One of those plants changed just now. Reload and try again.',
    },
    lot_changed: {
      status: 409,
      routes: [
        'PUT /api/inventory-items/:id/source-plants', 'PATCH /api/inventory-items/:id/source-plant', 'PUT /api/inventory-items/:id/filing',
        ADDITIONS_ROUTE, 'PUT /api/inventory-items/:id/seed-measure',
      ],
      required: ['error', 'code'],
      error: 'This seed lot was changed at the same moment. Reload and try again.',
      optional: [
        'source_plant_id', 'source_plants', 'variety_id', 'name',
        'seed_count', 'seed_count_estimated', 'seed_weight_g', 'seed_parent_plant_count', 'quantity_on_hand',
      ],
    },
    multi_parent_lot: { status: 409, routes: ['PATCH /api/inventory-items/:id/source-plant'], required: ['error', 'code', 'source_plant_ids'] },
  },
  examples_rule: 'One real reply per route (and one more for a replayed addition, under seed_additions_post.replay_example), taken from the seam test\'s own fixture and cut down to the keys promised above; ids and names are placeholders. The seam test compares every real reply with its example by type, key by key. Build mocks from these.',
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// One recorded example per route, compared with the real reply by type
// ───────────────────────────────────────────────────────────────────────────────────────────────────
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k]]))
const lotKeys = (b) => ({
  ...pick(b, CONTRACT.seed_lot.required),
  source_plants: (b.source_plants ?? []).map((p) => pick(p, CONTRACT.seed_lot.source_plant_required)),
})
const additionKeys = (b) => ({
  ...pick(b, CONTRACT.seed_additions_post.required),
  source_plants: (b.source_plants ?? []).map((p) => pick(p, CONTRACT.seed_lot.source_plant_required)),
  addition: pick(b.addition, CONTRACT.seed_additions_post.addition_required),
})
// A reply cut down to what the file promises for its route. Every reply key list in the file is read
// here, so each is exercised against a real reply as well as pinned above.
const PROMISED = {
  'POST /api/varieties/blend': (b) => ({
    ...pick(b, CONTRACT.varieties_blend.required),
    components: (b.components ?? []).map((c) => pick(c, CONTRACT.varieties_blend.component_required)),
  }),
  'POST /api/inventory-items': lotKeys,
  'GET /api/inventory-items/:id': lotKeys,
  'PUT /api/inventory-items/:id/source-plants': (b) => ({
    ...pick(b, [...CONTRACT.source_plants_put.required, ...CONTRACT.source_plants_put.required_when_filing_sent]),
    source_plants: (b.source_plants ?? []).map((p) => pick(p, CONTRACT.seed_lot.source_plant_required)),
    filing: {
      ...pick(b.filing, CONTRACT.source_plants_put.filing_required),
      previous: pick(b.filing?.previous, CONTRACT.source_plants_put.previous_required),
    },
  }),
  'PUT /api/inventory-items/:id/filing': (b) => ({
    ...pick(b, CONTRACT.filing_put.required),
    previous: pick(b.previous, CONTRACT.filing_put.previous_required),
  }),
  'PUT /api/inventory-items/:id/seed-measure': (b) => pick(b, CONTRACT.seed_measure_put.required),
  // Release 3. The first reply to a re-filing addition carries `filing` (the set route's own shape);
  // a replay never does, so the two have a cut of their own each.
  [ADDITIONS_ROUTE]: (b) => ({
    ...additionKeys(b),
    filing: {
      ...pick(b.filing, CONTRACT.source_plants_put.filing_required),
      previous: pick(b.filing?.previous, CONTRACT.source_plants_put.previous_required),
    },
  }),
  [`${ADDITIONS_ROUTE} (replay)`]: (b) => additionKeys(b),
  'GET /api/inventory-items/seed-lots-open': (b) => ({
    ...pick(b, CONTRACT.seed_lots_open_get.required),
    open_lots: (b.open_lots ?? []).map((row) => ({
      ...pick(row, CONTRACT.seed_lots_open_get.row_required),
      source_plants: (row.source_plants ?? []).map((p) => pick(p, CONTRACT.seed_lot.source_plant_required)),
    })),
  }),
  'GET /api/plants/:id/seed-lots': (b) => ({
    ...pick(b, CONTRACT.plants_seed_lots_get.envelope_required),
    seed_lots: (b.seed_lots ?? []).map((row) => ({
      ...pick(row, CONTRACT.plants_seed_lots_get.required),
      other_parents: (row.other_parents ?? []).map((p) => pick(p, CONTRACT.plants_seed_lots_get.other_parent_required)),
    })),
  }),
}
// null is a type of its own here: the fixture is fixed, so a key that is null in the example is null
// in the reply. A missing key reads 'undefined' and never matches.
const typeShape = (v) => {
  if (v === null) return 'null'
  if (Array.isArray(v)) return v.map(typeShape)
  if (typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, typeShape(v[k])]))
  return typeof v
}
const captured = {}
function expectExample(route, r) {
  captured[route] = { status: r.status, body: PROMISED[route](r.body) }
  if (RECORD_TO) return
  const example = CONTRACT.examples?.[route]
  expect(example, `tests/contracts/seed-mix.json has no recorded example for ${route} (see this file's header to record one)`).toBeDefined()
  expect(r.status, `${route}: status`).toBe(example.status)
  expect(typeShape(captured[route].body), `${route}: the real reply against the recorded example, by type`).toEqual(typeShape(example.body))
}
// What is written when recording: ids become placeholders that keep their ORDER (a mix's key is its
// leaf ids in uuid order), and the run id becomes a fixed word.
function forTheFile(examples) {
  let text = JSON.stringify(examples)
  const ids = [...new Set(text.match(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/g) ?? [])].sort()
  ids.forEach((id, i) => { text = text.split(id).join(`00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`) })
  return JSON.parse(text.split(RUN).join('example-run'))
}

beforeAll(async () => {
  if (!READY) return
  setTestUserId(USER)
  fx = await seedVarietyFixture({ run: RUN, user: USER, tag: 'sms' })
  // Three plantings, two varieties of one crop: two of the first, one of the second.
  state.p1 = await planting('p1', fx.v.a1)
  state.p1b = await planting('p1b', fx.v.a1)
  state.p2 = await planting('p2', fx.v.a2)
}, 60000)

afterAll(async () => {
  if (!READY) return
  if (RECORD_TO) {
    writeFileSync(RECORD_TO, `${JSON.stringify(forTheFile(captured), null, 2)}\n`)
    console.log(`[seed-mix-seam] RECORDED ${Object.keys(captured).length} example(s) to ${RECORD_TO}; nothing was compared with the file's own`)
  }
  const ids = assertFixtureId(USER, MATE, OTHER)
  await settle(`seed-mix-seam teardown ${RUN}`, [
    ...seedMixTeardown(ids, fx?.crops),
    () => directSql`DELETE FROM plant_projects WHERE created_by = ANY(${ids})`,
  ])
}, 60000)

describe.skipIf(!READY)('the save flow across both Lambdas', () => {
  it('the contract file is the one this test was written against: its version, and every list, status and refusal in it', () => {
    expect(CONTRACT.version).toBe(PINNED.version)
    const { examples, ...theRest } = CONTRACT
    // Section by section first, so a failure names the list; then the whole, so nothing is outside it.
    for (const section of Object.keys(PINNED)) expect(theRest[section], section).toEqual(PINNED[section])
    expect(theRest).toEqual(PINNED)
    // One example for each route the file names, and for nothing else.
    const routes = [
      CONTRACT.varieties_blend.route, ...CONTRACT.seed_lot.routes, CONTRACT.source_plants_put.route,
      CONTRACT.filing_put.route, CONTRACT.seed_measure_put.route,
      CONTRACT.seed_additions_post.route, CONTRACT.seed_additions_post.replay_example,
      CONTRACT.seed_lots_open_get.route, CONTRACT.plants_seed_lots_get.route,
    ]
    expect(Object.keys(PROMISED).sort()).toEqual([...routes].sort())
    if (!RECORD_TO) expect(Object.keys(examples ?? {}).sort()).toEqual([...routes].sort())
  })

  it('1. the varieties Lambda makes the mix of the parents\' varieties: 201, every REQUIRED key', async () => {
    const r = await varieties('POST', '/api/varieties/blend', { component_variety_ids: [fx.v.a2, fx.v.a1], create: true })
    expect(CONTRACT.varieties_blend.statuses).toContain(r.status)
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expectKeys(r.body, CONTRACT.varieties_blend.required, 'POST /api/varieties/blend')
    expect(r.body.variety_rank).toBe(CONTRACT.varieties_blend.variety_rank)
    for (const c of r.body.components) expectKeys(c, CONTRACT.varieties_blend.component_required, 'a component')
    expectExample('POST /api/varieties/blend', r)
    state.mix = r.body
  })

  it('2. the inventory Lambda files a jar from both varieties under that id: 201, every REQUIRED key; the same jar filed under one of its varieties is refused', async () => {
    const parents = [state.p1, state.p2, state.p1b]
    const wrong = await inv('POST', '/api/inventory-items', lotBody({ variety_id: fx.v.a1, source_plant_ids: parents }))
    expect(wrong.status).toBe(CONTRACT.refusals.blend_required.status)
    expectKeys(wrong.body, CONTRACT.refusals.blend_required.required, 'blend_required')
    expect(wrong.body.code).toBe('blend_required')
    // What the refusal names is what step 1 was given, so a client can go straight from one to the other.
    expect(wrong.body.component_variety_ids).toEqual([fx.v.a1, fx.v.a2].sort())
    expect(wrong.body.component_variety_ids).toEqual(state.mix.components.map((c) => c.id).sort())

    const r = await inv('POST', '/api/inventory-items', lotBody({ variety_id: state.mix.id, source_plant_ids: parents }))
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expectKeys(r.body, CONTRACT.seed_lot.required, 'POST /api/inventory-items')
    for (const s of r.body.source_plants) expectKeys(s, CONTRACT.seed_lot.source_plant_required, 'a source_plants element (POST)')
    expect(r.body.variety_id).toBe(state.mix.id)
    expect(r.body.variety_rank).toBe('blend')
    expectExample('POST /api/inventory-items', r)
    state.lot = r.body.id
    state.lotName = r.body.name
  })

  it('3. GET reads it back: filed under a "blend"; every parent\'s crop is the mix\'s crop; the mix\'s components are exactly the parents\' distinct varieties', async () => {
    const r = await inv('GET', `/api/inventory-items/${state.lot}`)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expectKeys(r.body, CONTRACT.seed_lot.required, 'GET /api/inventory-items/:id')
    expect(r.body.source_plants).toHaveLength(3)
    for (const s of r.body.source_plants) {
      expectKeys(s, CONTRACT.seed_lot.source_plant_required, 'a source_plants element (GET)')
      expect(Object.keys(s).sort()).toEqual([...CONTRACT.seed_lot.source_plant_required].sort())
    }
    expectExample('GET /api/inventory-items/:id', r)

    expect(r.body.variety_rank).toBe('blend')
    expect(r.body.variety_id).toBe(state.mix.id)
    expect(state.mix.crop_type_slug).toBe(fx.crops.a)
    expect(r.body.source_plants.map((s) => s.crop_slug)).toEqual([fx.crops.a, fx.crops.a, fx.crops.a])
    for (const s of r.body.source_plants) expect(s.crop_slug).toBe(state.mix.crop_type_slug)
    const parentVarieties = [...new Set(r.body.source_plants.map((s) => s.variety_id))].sort()
    expect(state.mix.components.map((c) => c.id).sort()).toEqual(parentVarieties)
    expect(state.mix.blend_key).toBe(parentVarieties.join(','))

    // The same three statements, read off the database rather than off either reply.
    const [db] = await directSql`
      SELECT pv.variety_rank, pv.crop_type_slug, pv.blend_key,
             (SELECT string_agg(DISTINCT p.variety_id::text, ',' ORDER BY p.variety_id::text)
                FROM seed_lot_parent_planting l JOIN plants p ON p.id = l.plant_id
               WHERE l.inventory_item_id = i.id AND l.role = 'seed_parent' AND l.deleted_at IS NULL) AS parent_varieties,
             (SELECT string_agg(c.component_variety_id::text, ',' ORDER BY c.component_variety_id)
                FROM variety_blend_component c
               WHERE c.blend_variety_id = pv.id AND c.deleted_at IS NULL) AS components,
             (SELECT count(DISTINCT cv.crop_type_slug)
                FROM seed_lot_parent_planting l JOIN plants p ON p.id = l.plant_id
                JOIN plant_varieties cv ON cv.id = p.variety_id
               WHERE l.inventory_item_id = i.id AND l.role = 'seed_parent' AND l.deleted_at IS NULL)::int AS parent_crops
        FROM inventory_items i JOIN plant_varieties pv ON pv.id = i.variety_id
       WHERE i.id = ${state.lot}`
    expect(db.variety_rank).toBe('blend')
    expect(db.parent_varieties).toBe(db.blend_key)
    expect(db.components).toBe(db.blend_key)
    expect(db.parent_crops).toBe(1)
    expect(db.crop_type_slug).toBe(fx.crops.a)
  })
})

describe.skipIf(!READY)('every other shape in tests/contracts/seed-mix.json, against the real replies', () => {
  it('the preview (create:false) carries the same REQUIRED keys, with id null', async () => {
    const r = await varieties('POST', '/api/varieties/blend', { component_variety_ids: [fx.v.a1, fx.v.a3], create: false })
    expect(r.status).toBe(200)
    expectKeys(r.body, CONTRACT.varieties_blend.required, 'the preview')
    expect(r.body.id).toBeNull()
    for (const c of r.body.components) expectKeys(c, CONTRACT.varieties_blend.component_required, 'a preview component')
  })

  it('the blend route\'s four refusals answer the status the file gives, with { error, code }', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000'
    const thirteen = []
    for (let i = 0; i < 13; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const [v] = await directSql`
        INSERT INTO plant_varieties (name, created_by, crop_type_slug, variety_rank)
        VALUES (${`sms-many-${RUN}-${i}`}, ${USER}, ${fx.crops.a}, 'cultivar') RETURNING id`
      thirteen.push(v.id)
    }
    const send = {
      component_unknown: [fx.v.a1, ghost],
      blend_needs_two: [fx.v.a1],
      blend_too_many: thirteen,
      mixed_crop_components: [fx.v.a1, fx.v.b],
    }
    expect(Object.keys(CONTRACT.varieties_blend.refusals).sort()).toEqual(Object.keys(send).sort())
    for (const [code, ids] of Object.entries(send)) {
      // eslint-disable-next-line no-await-in-loop
      const r = await varieties('POST', '/api/varieties/blend', { component_variety_ids: ids, create: true })
      expect(r.status, code).toBe(CONTRACT.varieties_blend.refusals[code])
      expect(r.body.code, JSON.stringify(r.body)).toBe(code)
      expect(typeof r.body.error).toBe('string')
    }
  })

  it('the plants picker (GET /api/plants?view=picker) hands each planting\'s variety_rank and blend_key on: "blend" and the key for a planting of the mix, "cultivar" and null for a plain one', async () => {
    // Lane R's half of the seam (contract section 5): the save sheet resolves a jar's parents out of
    // this list, and has to tell a planting that is ALREADY a mix from a single variety. The projection
    // names cultivar.blend_key, which no statement of lambda/plants had named before this release.
    const proj = await insertProject({ name: `sms-picker-${RUN}`, createdBy: USER })
    const onMix = await planting('pick-mix', state.mix.id, proj.id)
    const onPlain = await planting('pick-plain', fx.v.a1, proj.id)
    setTestUserId(USER)
    const r = await callHandler(plantsHandler, { method: 'GET', path: '/api/plants?view=picker' })
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200)
    const rows = Array.isArray(r.body) ? r.body : (r.body.plants ?? r.body.items ?? [])
    const mixRow = rows.find((x) => x.id === onMix)
    const plainRow = rows.find((x) => x.id === onPlain)
    expect(mixRow, 'the planting of the mix is in the picker').toBeDefined()
    expect(plainRow, 'the plain planting is in the picker').toBeDefined()
    expect(mixRow.variety_ref).toMatchObject({ id: state.mix.id, variety_rank: 'blend', blend_key: state.mix.blend_key })
    expect(plainRow.variety_ref).toMatchObject({ id: fx.v.a1, variety_rank: 'cultivar', blend_key: null })
    expect(Object.prototype.hasOwnProperty.call(plainRow.variety_ref, 'blend_key')).toBe(true)
  })

  it('PUT /:id/source-plants with a filing, PUT /:id/filing and PUT /:id/seed-measure each carry their REQUIRED keys', async () => {
    // A jar of one variety that gains the second and moves to the mix in one request.
    const made = await inv('POST', '/api/inventory-items', lotBody({ variety_id: fx.v.a1, source_plant_ids: [state.p1] }))
    expect(made.status).toBe(201)
    const lot = made.body.id

    const set = await inv('PUT', `/api/inventory-items/${lot}/source-plants`, {
      source_plant_ids: [state.p1, state.p2], expected_source_plant_ids: [state.p1], source_plant_id: state.p1,
      filing: { variety_id: state.mix.id, expect_variety_id: fx.v.a1 },
    })
    expect(set.status, JSON.stringify(set.body)).toBe(200)
    expectKeys(set.body, [...CONTRACT.source_plants_put.required, ...CONTRACT.source_plants_put.required_when_filing_sent], 'PUT source-plants')
    expectKeys(set.body.filing, CONTRACT.source_plants_put.filing_required, 'PUT source-plants filing')
    expectKeys(set.body.filing.previous, CONTRACT.source_plants_put.previous_required, 'PUT source-plants filing.previous')
    for (const s of set.body.source_plants) expectKeys(s, CONTRACT.seed_lot.source_plant_required, 'a source_plants element (PUT)')
    expect(set.body.filing.variety_rank).toBe('blend')
    expectExample('PUT /api/inventory-items/:id/source-plants', set)

    const filed = await inv('PUT', `/api/inventory-items/${lot}/filing`, {
      variety_id: fx.v.a3, expect_variety_id: state.mix.id, name: `sms refiled ${RUN}`,
    })
    expect(filed.status, JSON.stringify(filed.body)).toBe(200)
    expectKeys(filed.body, CONTRACT.filing_put.required, 'PUT filing')
    expectKeys(filed.body.previous, CONTRACT.filing_put.previous_required, 'PUT filing previous')
    expect(Object.keys(filed.body).sort()).toEqual([...CONTRACT.filing_put.required].sort())
    expectExample('PUT /api/inventory-items/:id/filing', filed)

    const measured = await inv('PUT', `/api/inventory-items/${lot}/seed-measure`, { seed_parent_plant_count: 2 })
    expect(measured.status, JSON.stringify(measured.body)).toBe(200)
    expectKeys(measured.body, CONTRACT.seed_measure_put.required, 'PUT seed-measure')
    expect(measured.body.seed_parent_plant_count).toBe(2)
    expectExample('PUT /api/inventory-items/:id/seed-measure', measured)
  })

  it('the blend route\'s OTHER statuses, each { error } with no code: 429 when the hour\'s creates are spent, 409 when every name the mix could take is in use — and neither writes', { timeout: 60000 }, async () => {
    expect(CONTRACT.varieties_blend.other_statuses).toEqual([409, 429])
    const mk = async (tag, by = OTHER, name = `sms-${tag}-${RUN}`) => (await directSql`
      INSERT INTO plant_varieties (name, created_by, crop_type_slug, variety_rank)
      VALUES (${name}, ${by}, ${fx.crops.a}, 'cultivar') RETURNING id, name`)[0]
    const mixesOf = async (a, b) => (await directSql`
      SELECT count(*)::int AS n FROM plant_varieties WHERE blend_key = ${[a, b].sort().join(',')}`)[0].n
    const onlyError = (r) => {
      expect(Object.keys(r.body)).toEqual(CONTRACT.varieties_blend.other_statuses_body)
      expect(typeof r.body.error).toBe('string')
    }

    // 429 — OTHER has had its sixty creates this hour (and next, should the clock turn mid-case).
    const [x, y] = [await mk('limit-x'), await mk('limit-y')]
    await directSql`
      INSERT INTO rate_limit_buckets (actor_clerk_sub, bucket_key, window_start, count)
      SELECT ${OTHER}, 'plant_varieties.create', date_trunc('hour', now()) + h * interval '1 hour', 60
        FROM generate_series(0, 1) AS h`
    const limited = await varieties('POST', '/api/varieties/blend', { component_variety_ids: [x.id, y.id], create: true }, OTHER)
    expect(limited.status, JSON.stringify(limited.body)).toBe(429)
    onlyError(limited)
    expect(await mixesOf(x.id, y.id)).toBe(0)
    // The preview spends nothing and is not limited.
    const peek = await varieties('POST', '/api/varieties/blend', { component_variety_ids: [x.id, y.id], create: false }, OTHER)
    expect(peek.status).toBe(200)

    // 409 — the automatic name and all eight of its suffixes belong to other varieties.
    const [p, q] = [await mk('names-p', USER), await mk('names-q', USER)]
    const preview = await varieties('POST', '/api/varieties/blend', { component_variety_ids: [p.id, q.id], create: false })
    for (const suffix of ['', ' (2)', ' (3)', ' (4)', ' (5)', ' (6)', ' (7)', ' (8)', ' (9)']) {
      // eslint-disable-next-line no-await-in-loop
      await mk('taken', OTHER, `${preview.body.name}${suffix}`)
    }
    const full = await varieties('POST', '/api/varieties/blend', { component_variety_ids: [p.id, q.id], create: true })
    expect(full.status, JSON.stringify(full.body)).toBe(409)
    onlyError(full)
    expect(await mixesOf(p.id, q.id)).toBe(0)
    expect((await directSql`SELECT count(*)::int AS n FROM variety_blend_component WHERE component_variety_id IN (${p.id}, ${q.id})`)[0].n).toBe(0)
  })

  it('a HOUSEHOLD of two: one member makes the mix, the other files a two-variety jar under it with one of the first member\'s plantings -> 201, variety_rank "blend". Alone, the same member is refused twice over', { timeout: 60000 }, async () => {
    // Pre-push QA review F4. Every other lot case in these files runs a household of ONE, so "the
    // HOUSEHOLD's live mix" and "a planting the HOUSEHOLD owns" were only ever proved for "mine".
    const saved = process.env.GARDEN_HOUSEHOLD_IDS
    const mk = async (tag, by) => (await directSql`
      INSERT INTO plant_varieties (name, created_by, crop_type_slug, variety_rank)
      VALUES (${`sms-hh-${tag}-${RUN}`}, ${by}, ${fx.crops.a}, 'cultivar') RETURNING id`)[0].id
    const sow = async (tag, by, variety) => (await directSql`
      INSERT INTO plants (project_id, name, created_by, variety_id)
      VALUES (NULL, ${`hh-${tag}-sms-${RUN}`}, ${by}, ${variety}) RETURNING id`)[0].id
    const lotsNamed = async (name) => (await directSql`SELECT id FROM inventory_items WHERE name = ${name}`).length
    try {
      delete process.env.GARDEN_HOUSEHOLD_IDS
      const [x, y] = [await mk('x', USER), await mk('y', MATE)]
      // MATE makes the mix, as MATE. It is MATE's row.
      const mix = await varieties('POST', '/api/varieties/blend', { component_variety_ids: [x, y], create: true }, MATE)
      expect(mix.status, JSON.stringify(mix.body)).toBe(201)
      expect(mix.body.created_by).toBe(MATE)
      const mineX = await sow('mine-x', USER, x)
      const mineY = await sow('mine-y', USER, y)
      const matesY = await sow('mates-y', MATE, y)

      // ALONE (no household): MATE's mix is not USER's household's mix, and MATE's planting is not USER's.
      const aloneMix = lotBody({ variety_id: mix.body.id, source_plant_ids: [mineX, mineY] })
      const notTheirMix = await inv('POST', '/api/inventory-items', aloneMix)
      expect(notTheirMix.status, JSON.stringify(notTheirMix.body)).toBe(400)
      expect(notTheirMix.body).toMatchObject({ code: 'blend_required', component_variety_ids: [x, y].sort() })
      const alonePlanting = lotBody({ variety_id: mix.body.id, source_plant_ids: [mineX, matesY] })
      const notTheirPlanting = await inv('POST', '/api/inventory-items', alonePlanting)
      expect(notTheirPlanting.status, JSON.stringify(notTheirPlanting.body)).toBe(400)
      expect(notTheirPlanting.body.code).toBeUndefined()
      expect(await lotsNamed(aloneMix.name) + await lotsNamed(alonePlanting.name)).toBe(0)

      // TOGETHER: the same two requests are a household's ordinary save.
      process.env.GARDEN_HOUSEHOLD_IDS = `${USER},${MATE}`
      const r = await inv('POST', '/api/inventory-items', lotBody({ variety_id: mix.body.id, source_plant_ids: [mineX, matesY] }))
      expect(r.status, JSON.stringify(r.body)).toBe(201)
      expectKeys(r.body, CONTRACT.seed_lot.required, 'POST /api/inventory-items (household)')
      expect(r.body.variety_id).toBe(mix.body.id)
      expect(r.body.variety_rank).toBe('blend')
      expect(r.body.source_plants.map((p) => p.id).sort()).toEqual([mineX, matesY].sort())
      expect(r.body.source_plants.map((p) => p.variety_id).sort()).toEqual([x, y].sort())

      // Read back: USER's lot, filed under MATE's mix, linked to one planting of each member.
      const [db] = await directSql`
        SELECT i.created_by AS lot_by, pv.created_by AS mix_by, pv.variety_rank, pv.blend_key,
               (SELECT string_agg(p.created_by, ',' ORDER BY p.created_by)
                  FROM seed_lot_parent_planting l JOIN plants p ON p.id = l.plant_id
                 WHERE l.inventory_item_id = i.id AND l.role = 'seed_parent' AND l.deleted_at IS NULL) AS planting_owners,
               (SELECT string_agg(DISTINCT l.created_by, ',')
                  FROM seed_lot_parent_planting l
                 WHERE l.inventory_item_id = i.id AND l.deleted_at IS NULL) AS linked_by,
               (SELECT string_agg(DISTINCT p.variety_id::text, ',' ORDER BY p.variety_id::text)
                  FROM seed_lot_parent_planting l JOIN plants p ON p.id = l.plant_id
                 WHERE l.inventory_item_id = i.id AND l.role = 'seed_parent' AND l.deleted_at IS NULL) AS parent_varieties
          FROM inventory_items i JOIN plant_varieties pv ON pv.id = i.variety_id
         WHERE i.id = ${r.body.id}`
      expect(db).toEqual({
        lot_by: USER, mix_by: MATE, variety_rank: 'blend', blend_key: [x, y].sort().join(','),
        planting_owners: [MATE, USER].sort().join(','), linked_by: USER, parent_varieties: [x, y].sort().join(','),
      })
      // And the other member reads the jar, and may add to it: USER's second planting, sent by MATE.
      const seen = await inv('GET', `/api/inventory-items/${r.body.id}`, undefined, MATE)
      expect(seen.status, JSON.stringify(seen.body)).toBe(200)
      expect(seen.body.variety_rank).toBe('blend')
      const grown = await inv('PUT', `/api/inventory-items/${r.body.id}/source-plants`, {
        source_plant_ids: [mineX, matesY, mineY], expected_source_plant_ids: [matesY, mineX],
      }, MATE)
      expect(grown.status, JSON.stringify(grown.body)).toBe(200)
      expect(grown.body.source_plants.map((p) => p.id).sort()).toEqual([mineX, matesY, mineY].sort())
    } finally {
      if (saved === undefined) delete process.env.GARDEN_HOUSEHOLD_IDS
      else process.env.GARDEN_HOUSEHOLD_IDS = saved
    }
  })

  it('each refusal the inventory Lambda can be driven to without a second session answers the status, the code and the keys the file gives', async () => {
    const bare = await planting('bare', null)
    const other = await planting('other', fx.v.b)
    const one = await inv('POST', '/api/inventory-items', lotBody({ variety_id: fx.v.a1, source_plant_ids: [state.p1] }))
    const lot = one.body.id
    const put = (body) => inv('PUT', `/api/inventory-items/${lot}/source-plants`, body)
    const seen = {
      parent_without_variety: await put({ source_plant_ids: [state.p1, bare] }),
      mixed_crop_parents: await put({ source_plant_ids: [state.p1, other] }),
      blend_required: await put({ source_plant_ids: [state.p1, state.p2] }),
      variety_unusable: await inv('PUT', `/api/inventory-items/${lot}/filing`, { variety_id: fx.v.gone, expect_variety_id: fx.v.a1 }),
      filing_crop_mismatch: await inv('PUT', `/api/inventory-items/${lot}/filing`, { variety_id: fx.v.b, expect_variety_id: fx.v.a1 }),
      lot_changed: await put({ source_plant_ids: [state.p1, state.p1b], expected_source_plant_ids: [] }),
    }
    // A lot with two parents, for the legacy route's refusal.
    const two = await inv('POST', '/api/inventory-items', lotBody({ variety_id: fx.v.a1, source_plant_ids: [state.p1, state.p1b] }))
    seen.multi_parent_lot = await inv('PATCH', `/api/inventory-items/${two.body.id}/source-plant`, { source_plant_id: state.p1 })

    for (const [code, r] of Object.entries(seen)) {
      const spec = CONTRACT.refusals[code]
      expect(spec, `tests/contracts/seed-mix.json has no entry for ${code}`).toBeDefined()
      expect(r.status, `${code} -> ${JSON.stringify(r.body)}`).toBe(spec.status)
      expect(r.body.code).toBe(code)
      expectKeys(r.body, spec.required, code)
      if (spec.error) expect(r.body.error).toBe(spec.error)
    }
    // parents_changed needs a concurrent writer; it is driven in seed-lot-rules.int.test.js (C7, C8),
    // where the body is held to exactly { error, code } with this sentence.
    expect(Object.keys(CONTRACT.refusals).sort()).toEqual([...Object.keys(seen), 'parents_changed'].sort())
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// Release 3 (V5-SEEDLOTADDITION-001) — the three replies the "put it in a seed lot I already started"
// sheet is built on, each against its recorded example
// ───────────────────────────────────────────────────────────────────────────────────────────────────
// The sheet reads GET /api/plants/:id/seed-lots (the plant's own lots) and GET /seed-lots-open (any lot
// it could go into), builds its POST from a row of either, and reads the POST's reply. Its tests mock
// all three from the examples in the contract file, so each is held here to a real reply by type.
//
// ITS OWN CROP. Everything below is the fixture's second crop (`b`), which no case above files a lot
// under or links a planting of — so what the open-lots read returns here is this block's one lot and
// nothing left behind by an earlier case, on every run.
describe.skipIf(!READY)('release 3 — the add-to-a-lot replies, against their recorded examples', () => {
  const r3 = {}
  const seedLots = (plantId) => {
    setTestUserId(USER)
    return callHandler(plantsHandler, { method: 'GET', path: `/api/plants/${plantId}/seed-lots` })
  }

  beforeAll(async () => {
    // A second variety of crop b, and the named mix of the two.
    const [second] = await directSql`
      INSERT INTO plant_varieties (name, created_by, crop_type_slug, variety_rank)
      VALUES (${`sms-variety-b2-${RUN}`}, ${USER}, ${fx.crops.b}, 'cultivar') RETURNING id`
    r3.b2 = second.id
    const mix = await varieties('POST', '/api/varieties/blend', { component_variety_ids: [fx.v.b, r3.b2], create: true })
    expect(mix.status, JSON.stringify(mix.body)).toBe(201)
    r3.mix = mix.body
    r3.q1 = await planting('q1', fx.v.b)
    r3.q2 = await planting('q2', r3.b2)
    // One lot of variety b from q1: drying, counted, weighed, one plant.
    const made = await inv('POST', '/api/inventory-items', lotBody({ variety_id: fx.v.b, source_plant_ids: [r3.q1] }))
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    r3.lot = made.body.id
    const staged = await inv('POST', `/api/inventory-items/${r3.lot}/seed-stage`, { stage: 'drying', seed_process: 'dry' })
    expect(staged.status, JSON.stringify(staged.body)).toBe(201)
    const measured = await inv('PUT', `/api/inventory-items/${r3.lot}/seed-measure`, {
      seed_count: 100, seed_count_estimated: false, seed_weight_g: 12.345, seed_parent_plant_count: 1,
    })
    expect(measured.status, JSON.stringify(measured.body)).toBe(200)
  }, 60000)

  // The one row this block writes that neither the kit's teardown nor the global sweep removes: the
  // stage-log entry POST /seed-stage made (it names the lot, with no ON DELETE action). Before the
  // file's own afterAll, so the lot can then go.
  afterAll(async () => {
    if (r3.lot) await directSql`DELETE FROM seed_lot_stage_log WHERE inventory_item_id = ${r3.lot}`
  })

  it('GET /seed-lots-open for a second planting of the crop: the lot, every REQUIRED key, and each row exactly the row keys', async () => {
    const r = await inv('GET', `/api/inventory-items/seed-lots-open?plant_id=${r3.q2}`)
    expect(CONTRACT.seed_lots_open_get.statuses).toContain(r.status)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(Object.keys(r.body).sort()).toEqual([...CONTRACT.seed_lots_open_get.required].sort())
    expect(r.body).toMatchObject({ plant_id: r3.q2, crop_slug: fx.crops.b })
    expect(r.body.open_lots.map((row) => row.id)).toEqual([r3.lot])
    for (const row of r.body.open_lots) {
      expect(Object.keys(row).sort()).toEqual([...CONTRACT.seed_lots_open_get.row_required].sort())
      for (const p of row.source_plants) expect(Object.keys(p).sort()).toEqual([...CONTRACT.seed_lot.source_plant_required].sort())
    }
    // The contract's filing case "one parent of A, filed A, a plant of B": not the same variety.
    expect(r.body.open_lots[0]).toMatchObject({ is_member: false, same_variety: false, variety_id: fx.v.b, seed_stage: 'drying' })
    expectExample('GET /api/inventory-items/seed-lots-open', r)
    r3.row = r.body.open_lots[0]
  })

  it('POST /:id/seed-additions built from that row — first, then the same request again: every REQUIRED key both times, `filing` only the first', async () => {
    const spec = CONTRACT.seed_additions_post
    // Exactly as the sheet builds it: the set from the row's own plants, the filing's expectation
    // from the row's own variety, the target from the blend route.
    const body = {
      addition_key: randomUUID(),
      plant_id: r3.q2,
      expected_source_plant_ids: r3.row.source_plants.map((p) => p.id),
      picked_on: '2026-09-01',
      add_seed_count: 30,
      add_estimated: true,
      add_seed_weight_g: 1.5,
      filing: { variety_id: r3.mix.id, expect_variety_id: r3.row.variety_id, name: `sms mix lot ${RUN}` },
    }
    // The body is the contract's keys and never the three an older Lambda would take for a create.
    const allowed = [...spec.request_required, ...spec.request_optional]
    for (const key of spec.request_required) expect(body).toHaveProperty(key)
    for (const key of Object.keys(body)) expect(allowed, `the body carries "${key}"`).toContain(key)
    for (const key of spec.request_never) expect(body).not.toHaveProperty(key)

    const first = await inv('POST', `/api/inventory-items/${r3.lot}/seed-additions`, body)
    expect(spec.statuses).toContain(first.status)
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    expectKeys(first.body, [...spec.required, ...spec.required_when_filing_sent], 'POST seed-additions')
    expect(Object.keys(first.body).sort()).toEqual([...spec.required, ...spec.required_when_filing_sent].sort())
    expect(Object.keys(first.body.addition).sort()).toEqual([...spec.addition_required].sort())
    expectKeys(first.body.filing, CONTRACT.source_plants_put.filing_required, 'POST seed-additions filing')
    for (const p of first.body.source_plants) expectKeys(p, CONTRACT.seed_lot.source_plant_required, 'a source_plants element (POST seed-additions)')
    expect(first.body.addition).toMatchObject({ replayed: false, plant_was_added: true, count_applied: true, weight_applied: true })
    expect(first.body).toMatchObject({ id: r3.lot, variety_id: r3.mix.id, name: body.filing.name, seed_count: 130, seed_count_estimated: true, seed_weight_g: '13.845', seed_parent_plant_count: 2 })
    expect(first.body.filing).toMatchObject({ variety_rank: 'blend', changed: true, previous: { variety_id: fx.v.b } })
    expectExample(ADDITIONS_ROUTE, first)

    const replay = await inv('POST', `/api/inventory-items/${r3.lot}/seed-additions`, body)
    expect(replay.status, JSON.stringify(replay.body)).toBe(200)
    expect(Object.keys(replay.body).sort()).toEqual([...spec.required].sort())
    expect(replay.body.addition).toEqual({ ...first.body.addition, replayed: true })
    expect(replay.body).toMatchObject({ seed_count: 130, variety_id: r3.mix.id, name: body.filing.name })
    expectExample(CONTRACT.seed_additions_post.replay_example, replay)

    // Read off the database rather than off either reply: one picking, hung on q2's link row of this lot.
    const rows = await directSql`
      SELECT a.id, a.seed_count, a.seed_count_estimated, a.seed_weight_g::text AS seed_weight_g, a.count_applied, a.weight_applied,
             l.plant_id, l.inventory_item_id
        FROM seed_lot_addition a JOIN seed_lot_parent_planting l ON l.id = a.parent_link_id
       WHERE l.inventory_item_id = ${r3.lot}`
    expect(rows).toEqual([{
      id: first.body.addition.id, seed_count: 30, seed_count_estimated: true, seed_weight_g: '1.500', count_applied: true, weight_applied: true,
      plant_id: r3.q2, inventory_item_id: r3.lot,
    }])
  })

  it('GET /api/plants/:id/seed-lots for the first planting: the envelope, each lot\'s REQUIRED keys, and the other parent by name', async () => {
    const spec = CONTRACT.plants_seed_lots_get
    const r = await seedLots(r3.q1)
    expect(spec.statuses).toContain(r.status)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(Object.keys(r.body).sort()).toEqual([...spec.envelope_required].sort())
    expect(r.body.plant_id).toBe(r3.q1)
    expect(r.body.seed_lots.map((row) => row.id)).toEqual([r3.lot])
    for (const row of r.body.seed_lots) {
      expect(Object.keys(row).sort()).toEqual([...spec.required].sort())
      for (const p of row.other_parents) expect(Object.keys(p).sort()).toEqual([...spec.other_parent_required].sort())
    }
    // What the sheet's one-tap line needs: the lot as the addition left it, and the plant that joined.
    expect(r.body.seed_lots[0]).toMatchObject({ seed_stage: 'drying', seed_count: 130, seed_count_estimated: true, seed_weight_g: '13.845' })
    expect(r.body.seed_lots[0].other_parents.map((p) => p.id)).toEqual([r3.q2])
    expectExample('GET /api/plants/:id/seed-lots', r)
  })
})
