// seed-lot-filing.int.test.js — V5-SEEDMULTIPARENT-001 release 2a on a real Postgres: which variety a
// saved-seed lot is FILED UNDER, and the locks that write shares with the other writers of a lot.
//
// WHY THIS FILE EXISTS. Until this release nothing could deliberately re-file a lot; the wide PUT
// assigned variety_id from whatever stale row its caller round-tripped. Release 2a adds one statement
// that does it (seed-lot-filing.js fileLot), reached two ways that must not differ:
//   PUT /api/inventory-items/:id/filing          the filing alone, a compare-and-set on the stored variety;
//   PUT /api/inventory-items/:id/source-plants   `filing` beside a new parent set, in ONE transaction.
// Lane I built both against a stub (lane-I-report.log section 4, cases D and E). What only a database
// shows: that the judge's CASE reaches each verdict on real rows (its crop test is an aggregate over a
// correlated subquery); that 'same' really writes nothing — not even updated_at; that a refused filing
// takes the parent edit with it and a refused edit takes the filing (one held verdict, see
// seed-lot-rules.int.test.js case A1); and that this writer queues behind the lot row like the others
// instead of crossing them.
//
// The case labels (D1 ... D10, E2 ... E4) are lane I's. E1 — release 1's own lock-order blocks, results
// unchanged — is seed-lot-parents.int.test.js passing as restated. E5 is a known pair nobody changed.
//
// EVERY ASSERTION ABOUT STATE IS A directSql READ-BACK (L-108); timestamps are compared as text.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { directSql, callHandler, testRunId, setTestUserId, insertProject } from './_harness.js'
import { assertFixtureId, settle } from './_cleanup.js'
import {
  seedVarietyFixture, seedMixTeardown, twoSessions, HAS_PSQL, lit,
} from './_seedLotKit.js'
import { handler as invHandler } from '../../lambda/inventory-items/index.js'
import { handler as varietiesHandler } from '../../lambda/varieties/index.js'
import { handler as plantsHandler } from '../../lambda/plants/index.js'
import { VARIETY_UNUSABLE, FILING_CROP_MISMATCH } from '../../lambda/inventory-items/seed-lot-filing.js'
import { BLEND_REQUIRED } from '../../lambda/inventory-items/seed-lot-rules.js'

const RUN = testRunId()
const USER = `slf-user-${RUN}`
const FOREIGN = `slf-foreign-${RUN}`

const LOT_CHANGED = 'This seed lot was changed at the same moment. Reload and try again.'

// The route under test writes inventory_items.variety_id and nothing new, but every parent it reads is
// a link row and every mix it files under is a keyed variety. One failure that names what to apply.
const [present] = await directSql`
  SELECT to_regclass('public.seed_lot_parent_planting') IS NOT NULL AS links,
         to_regclass('public.variety_blend_component') IS NOT NULL AS components,
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'plant_varieties' AND column_name = 'blend_key') AS blend_key`
const MISSING = [
  !present.links && 'public.seed_lot_parent_planting (migrations/v5-seedmultiparent-001/0a-additive-ddl.sql)',
  !present.blend_key && 'plant_varieties.blend_key (migrations/v5-varietyblend-001/0a-additive-ddl.sql)',
  !present.components && 'public.variety_blend_component (migrations/v5-varietyblend-001/0a-additive-ddl.sql)',
].filter(Boolean)
const READY = MISSING.length === 0

describe('seed lot filing — the schema is on this branch', () => {
  it('the link table, the mix key and the component table exist (apply v5-seedmultiparent-001 and v5-varietyblend-001 before the code that names them)', () => {
    expect(MISSING, `missing on the database this suite forks: ${MISSING.join('; ')}`).toEqual([])
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// Fixtures and readers
// ───────────────────────────────────────────────────────────────────────────────────────────────────
let fx
let seq = 0
const MIX = {}
const P = {}

async function planting(tag, { by = USER, variety = fx.v.a1, projectId = null } = {}) {
  const [p] = await directSql`
    INSERT INTO plants (project_id, name, created_by, variety_id)
    VALUES (${projectId}, ${`${tag}-slf-${RUN}-${seq++}`}, ${by}, ${variety})
    RETURNING id`
  return p.id
}
const setVariety = (plantId, varietyId) => directSql`UPDATE plants SET variety_id = ${varietyId} WHERE id = ${plantId}`

function postLot(extra = {}, as = USER) {
  setTestUserId(as)
  return callHandler(invHandler, {
    method: 'POST', path: '/api/inventory-items',
    body: {
      name: `slf-lot-${RUN}-${seq++}`, type: 'consumable', category: 'seeds', unit: 'packet',
      quantity_on_hand: 1, variety_id: fx.v.a1, ...extra,
    },
  })
}
async function newLot(extra = {}, as = USER) {
  const r = await postLot(extra, as)
  expect(r.status, `POST lot -> ${JSON.stringify(r.body)}`).toBe(201)
  return r.body.id
}
const file = (lotId, body, as = USER) => {
  setTestUserId(as)
  return callHandler(invHandler, { method: 'PUT', path: `/api/inventory-items/${lotId}/filing`, body })
}
const put = (lotId, body, as = USER) => {
  setTestUserId(as)
  return callHandler(invHandler, { method: 'PUT', path: `/api/inventory-items/${lotId}/source-plants`, body })
}
const widePut = (lotId, body, as = USER) => {
  setTestUserId(as)
  return callHandler(invHandler, { method: 'PUT', path: `/api/inventory-items/${lotId}`, body })
}
const merge = (winner, losers) => {
  setTestUserId(USER)
  return callHandler(plantsHandler, {
    method: 'POST', path: `/api/plants/${winner}/merge`, body: { loser_ids: losers, op_id: randomUUID() },
  })
}
async function newMix(ids, as = USER) {
  setTestUserId(as)
  const r = await callHandler(varietiesHandler, {
    method: 'POST', path: '/api/varieties/blend', body: { component_variety_ids: ids, create: true },
  })
  expect([200, 201], `POST /api/varieties/blend -> ${r.status} ${JSON.stringify(r.body)}`).toContain(r.status)
  return r.body
}

const lotRow = async (lotId) => (await directSql`
  SELECT id, name, category, variety_id, source_plant_id,
         updated_at::text AS updated_at, deleted_at::text AS deleted_at
    FROM inventory_items WHERE id = ${lotId}`)[0]
const livePlants = async (lotId) => (await directSql`
  SELECT plant_id FROM seed_lot_parent_planting
   WHERE inventory_item_id = ${lotId} AND role = 'seed_parent' AND deleted_at IS NULL
   ORDER BY plant_id`).map((r) => r.plant_id)

async function everything() {
  const lots = await directSql`
    SELECT id, name, category, variety_id, source_plant_id, source_kind,
           updated_at::text AS updated_at, deleted_at::text AS deleted_at
      FROM inventory_items WHERE created_by IN (${USER}, ${FOREIGN}) ORDER BY id`
  const rows = await directSql`
    SELECT l.id, l.inventory_item_id, l.plant_id, l.role, l.created_by,
           l.created_at::text AS created_at, l.updated_at::text AS updated_at, l.deleted_at::text AS deleted_at
      FROM seed_lot_parent_planting l
     WHERE l.inventory_item_id IN (SELECT id FROM inventory_items WHERE created_by IN (${USER}, ${FOREIGN}))
     ORDER BY l.id`
  return JSON.stringify({ lots, rows })
}

const sorted = (...ids) => [...ids].sort()
const { inOrder: inOrderOn, closeAll } = twoSessions()

beforeAll(async () => {
  if (!READY) return
  setTestUserId(USER)
  fx = await seedVarietyFixture({ run: RUN, user: USER, tag: 'slf' })
  MIX.pair = await newMix([fx.v.a1, fx.v.a2])
  for (const [key, variety] of [
    ['a1', fx.v.a1], ['a1b', fx.v.a1], ['a2', fx.v.a2], ['b', fx.v.b], ['n1', fx.v.n1], ['bare', null],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    P[key] = await planting(key, { variety })
  }
}, 60000)

afterAll(async () => {
  closeAll()
  if (!READY) return
  const ids = assertFixtureId(USER, FOREIGN)
  await settle(`seed-lot-filing teardown ${RUN}`, [
    () => directSql`DELETE FROM merge_event WHERE merged_by = ANY(${ids}) OR winner_plant_id IN (SELECT id FROM plants WHERE created_by = ANY(${ids}))`,
    ...seedMixTeardown(ids, fx?.crops),
    () => directSql`DELETE FROM plant_projects WHERE created_by = ANY(${ids})`,
  ])
}, 60000)

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// D. PUT /api/inventory-items/:id/filing
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!READY)('D — PUT /:id/filing: a compare-and-set on the variety a lot is filed under', () => {
  it('D1: stored = expect_variety_id -> 200 changed:true; the variety moves, the name is kept, updated_at moves, previous is the old pair', async () => {
    const lot = await newLot()
    const before = await lotRow(lot)
    const r = await file(lot, { variety_id: fx.v.a2, expect_variety_id: fx.v.a1 })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toEqual({
      id: lot,
      variety_id: fx.v.a2,
      variety_name: fx.names.a2,
      variety_rank: 'cultivar',
      name: before.name,
      changed: true,
      previous: { variety_id: fx.v.a1, name: before.name },
    })
    const after = await lotRow(lot)
    expect(after.variety_id).toBe(fx.v.a2)
    expect(after.name).toBe(before.name)
    expect(after.updated_at).not.toBe(before.updated_at)
  })

  it('D1: with a name, the name is written trimmed; a mix target reports variety_rank "blend"', async () => {
    const lot = await newLot()
    const before = await lotRow(lot)
    const r = await file(lot, { variety_id: MIX.pair.id, expect_variety_id: fx.v.a1.toUpperCase(), name: `  slf mixed jar ${RUN}  ` })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toMatchObject({
      variety_id: MIX.pair.id, variety_name: MIX.pair.name, variety_rank: 'blend',
      name: `slf mixed jar ${RUN}`, changed: true,
      previous: { variety_id: fx.v.a1, name: before.name },
    })
    const after = await lotRow(lot)
    expect(after.variety_id).toBe(MIX.pair.id)
    expect(after.name).toBe(`slf mixed jar ${RUN}`)
  })

  it('D2: stored = variety_id -> 200 changed:false and the row is byte-identical — updated_at too, and a name sent beside it is NOT written', async () => {
    const lot = await newLot()
    const before = await everything()
    const row = await lotRow(lot)
    const r = await file(lot, { variety_id: fx.v.a1, expect_variety_id: fx.v.a2, name: 'a name that must not land' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toEqual({
      id: lot, variety_id: fx.v.a1, variety_name: fx.names.a1, variety_rank: 'cultivar', name: row.name,
      changed: false, previous: { variety_id: fx.v.a1, name: row.name },
    })
    expect(await everything()).toBe(before)
    // The target is not checked on a replay: a lot filed under a variety that has since been deleted
    // answers the same way.
    const gone = await newLot({ variety_id: fx.v.gone })
    const snap = await everything()
    const replay = await file(gone, { variety_id: fx.v.gone, expect_variety_id: fx.v.a1 })
    expect(replay.status, JSON.stringify(replay.body)).toBe(200)
    expect(replay.body.changed).toBe(false)
    expect(await everything()).toBe(snap)
  })

  it('D3: a stale expect_variety_id -> 409 lot_changed carrying the STORED variety and name; nothing written', async () => {
    const lot = await newLot()
    const row = await lotRow(lot)
    const before = await everything()
    const r = await file(lot, { variety_id: fx.v.a3, expect_variety_id: fx.v.a2, name: 'never' })
    expect(r.status, JSON.stringify(r.body)).toBe(409)
    expect(r.body).toEqual({ error: LOT_CHANGED, code: 'lot_changed', variety_id: fx.v.a1, name: row.name })
    expect(await everything()).toBe(before)
  })

  it('D4: a target that is soft-deleted, or that no row has -> 400 variety_unusable; nothing written', async () => {
    const lot = await newLot()
    const before = await everything()
    for (const target of [fx.v.gone, randomUUID()]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await file(lot, { variety_id: target, expect_variety_id: fx.v.a1 })
      expect(r.status, JSON.stringify(r.body)).toBe(400)
      expect(r.body).toEqual({ error: VARIETY_UNUSABLE, code: 'variety_unusable' })
    }
    expect(await everything()).toBe(before)
    // A stale caller is told it is stale BEFORE being told its target is unusable.
    const order = await file(lot, { variety_id: fx.v.gone, expect_variety_id: fx.v.a2 })
    expect(order.status).toBe(409)
    expect(order.body.code).toBe('lot_changed')
  })

  it('D5: the target\'s crop is held to the parents\' shared crop — and only when they share exactly one', async () => {
    // Parents of crop A, target of crop B.
    const tomato = await newLot({ source_plant_ids: [P.a1, P.a1b] })
    let before = await everything()
    const mismatch = await file(tomato, { variety_id: fx.v.b, expect_variety_id: fx.v.a1 })
    expect(mismatch.status, JSON.stringify(mismatch.body)).toBe(400)
    expect(mismatch.body).toEqual({ error: FILING_CROP_MISMATCH, code: 'filing_crop_mismatch' })
    expect(await everything()).toBe(before)
    // NULL is one value of its own: parents of crop A, target with no crop -> mismatch;
    const toNone = await file(tomato, { variety_id: fx.v.n1, expect_variety_id: fx.v.a1 })
    expect(toNone.status).toBe(400)
    expect(toNone.body.code).toBe('filing_crop_mismatch')
    expect(await everything()).toBe(before)
    // ...and a target of the SAME crop is written.
    const same = await file(tomato, { variety_id: fx.v.a3, expect_variety_id: fx.v.a1 })
    expect(same.status, JSON.stringify(same.body)).toBe(200)
    expect((await lotRow(tomato)).variety_id).toBe(fx.v.a3)

    // No parents: nothing to differ from.
    const bought = await newLot()
    const free = await file(bought, { variety_id: fx.v.b, expect_variety_id: fx.v.a1 })
    expect(free.status, JSON.stringify(free.body)).toBe(200)
    expect((await lotRow(bought)).variety_id).toBe(fx.v.b)

    // Parents with no crop + a target with no crop: NULL agrees with NULL.
    const cropless = await newLot({ source_plant_ids: [P.n1], variety_id: fx.v.n1 })
    const agree = await file(cropless, { variety_id: fx.v.n2, expect_variety_id: fx.v.n1 })
    expect(agree.status, JSON.stringify(agree.body)).toBe(200)
    expect((await lotRow(cropless)).variety_id).toBe(fx.v.n2)
    // ...and beside a crop it differs.
    before = await everything()
    const differ = await file(cropless, { variety_id: fx.v.a1, expect_variety_id: fx.v.n2 })
    expect(differ.status).toBe(400)
    expect(differ.body.code).toBe('filing_crop_mismatch')
    expect(await everything()).toBe(before)

    // Parents of TWO crops (only drift can produce it): no shared crop, so the test is skipped.
    const x = await planting('D5x')
    const y = await planting('D5y')
    const drifted = await newLot({ source_plant_ids: [x, y] })
    await setVariety(y, fx.v.b)
    const skipped = await file(drifted, { variety_id: fx.v.n1, expect_variety_id: fx.v.a1 })
    expect(skipped.status, JSON.stringify(skipped.body)).toBe(200)
    expect((await lotRow(drifted)).variety_id).toBe(fx.v.n1)

    // A parent with no variety at all contributes no crop: the lot has no shared crop either.
    const one = await newLot({ source_plant_ids: [P.bare] })
    const bareOk = await file(one, { variety_id: fx.v.b, expect_variety_id: fx.v.a1 })
    expect(bareOk.status, JSON.stringify(bareOk.body)).toBe(200)
  })

  it('D6: Undo — sending `previous` back restores the variety and the name; the target need not be the parents\' mix', async () => {
    const lot = await newLot({ source_plant_ids: [P.a1, P.a2], variety_id: MIX.pair.id })
    const original = await lotRow(lot)
    // Filed away from the mix, to a plain cultivar of the same crop: allowed.
    const moved = await file(lot, { variety_id: fx.v.a3, expect_variety_id: MIX.pair.id, name: `slf renamed ${RUN}` })
    expect(moved.status, JSON.stringify(moved.body)).toBe(200)
    expect(moved.body.previous).toEqual({ variety_id: MIX.pair.id, name: original.name })
    expect((await lotRow(lot)).variety_id).toBe(fx.v.a3)

    const undo = await file(lot, {
      variety_id: moved.body.previous.variety_id, expect_variety_id: moved.body.variety_id, name: moved.body.previous.name,
    })
    expect(undo.status, JSON.stringify(undo.body)).toBe(200)
    expect(undo.body).toMatchObject({ variety_id: MIX.pair.id, variety_rank: 'blend', name: original.name, changed: true })
    const after = await lotRow(lot)
    expect(after.variety_id).toBe(MIX.pair.id)
    expect(after.name).toBe(original.name)
    expect(await livePlants(lot)).toEqual(sorted(P.a1, P.a2))
  })

  it('D7: a row that is not seeds, another household\'s lot, a deleted lot, an absent one and a malformed id are all the same 404', async () => {
    setTestUserId(USER)
    const tool = await callHandler(invHandler, {
      method: 'POST', path: '/api/inventory-items',
      body: { name: `slf-tool-${RUN}`, type: 'durable', category: 'tools', quantity: 1 },
    })
    expect(tool.status).toBe(201)
    const mine = await newLot()
    const deleted = await newLot()
    setTestUserId(USER)
    expect((await callHandler(invHandler, { method: 'DELETE', path: `/api/inventory-items/${deleted}` })).status).toBe(200)
    const before = await everything()
    const body = { variety_id: fx.v.a2, expect_variety_id: fx.v.a1 }
    for (const [what, id, as] of [
      ['not seeds', tool.body.id, USER], ['foreign', mine, FOREIGN], ['deleted', deleted, USER],
      ['absent', randomUUID(), USER], ['malformed', 'not-a-uuid', USER],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await file(id, body, as)
      expect(r.status, `${what} -> ${JSON.stringify(r.body)}`).toBe(404)
      expect(r.body).toEqual({ error: 'Not found' })
    }
    expect(await everything()).toBe(before)
    // Body shape, before any SQL: both ids required and uuid-shaped; a blank name is refused, not ignored.
    for (const bad of [{}, { variety_id: fx.v.a2 }, { variety_id: 'x', expect_variety_id: fx.v.a1 },
      { variety_id: fx.v.a2, expect_variety_id: fx.v.a1, name: '   ' }, { variety_id: fx.v.a2, expect_variety_id: fx.v.a1, name: 7 }]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await file(mine, bad)
      expect(r.status, JSON.stringify(bad)).toBe(400)
      expect(r.body.code).toBeUndefined()
    }
    expect(await everything()).toBe(before)
    setTestUserId(USER)
    const wrongVerb = await callHandler(invHandler, { method: 'PATCH', path: `/api/inventory-items/${mine}/filing`, body })
    expect(wrongVerb.status).toBe(405)
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// D9, D10 — the filing inside the set route's transaction
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!READY)('D — `filing` on PUT /:id/source-plants: one transaction, one verdict', () => {
  it('the save flow itself: a second variety is added and the lot is re-filed under the mix in ONE request -> 200, both written', async () => {
    const lot = await newLot({ source_plant_ids: [P.a1] })
    const row = await lotRow(lot)
    // Without the filing the same request is the rules' 400.
    const before = await everything()
    const bare = await put(lot, { source_plant_ids: [P.a1, P.a2] })
    expect(bare.status).toBe(400)
    expect(bare.body).toEqual({ error: BLEND_REQUIRED, code: 'blend_required', component_variety_ids: sorted(fx.v.a1, fx.v.a2) })
    expect(await everything()).toBe(before)

    const r = await put(lot, {
      source_plant_ids: [P.a1, P.a2], expected_source_plant_ids: [P.a1], source_plant_id: P.a1,
      filing: { variety_id: MIX.pair.id, expect_variety_id: fx.v.a1 },
    })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(Object.keys(r.body).sort()).toEqual(['filing', 'id', 'source_plant_id', 'source_plants'])
    expect(r.body.filing).toEqual({
      variety_id: MIX.pair.id, variety_name: MIX.pair.name, variety_rank: 'blend', name: row.name,
      changed: true, previous: { variety_id: fx.v.a1, name: row.name },
    })
    expect(r.body.source_plants.map((s) => s.id).sort()).toEqual(sorted(P.a1, P.a2))
    expect(await livePlants(lot)).toEqual(sorted(P.a1, P.a2))
    const after = await lotRow(lot)
    expect(after.variety_id).toBe(MIX.pair.id)
    expect(after.source_plant_id).toBe(P.a1)
    // No `filing` in the body -> no `filing` in the reply.
    const plain = await put(lot, { source_plant_ids: [P.a1, P.a2] })
    expect(plain.status).toBe(200)
    expect(Object.keys(plain.body).sort()).toEqual(['id', 'source_plant_id', 'source_plants'])
  })

  it('D9a: the set is fine and the filing is stale -> 409 lot_changed with the stored set AND filing; the SET is untouched', async () => {
    const lot = await newLot({ source_plant_ids: [P.a1] })
    const row = await lotRow(lot)
    const before = await everything()
    const r = await put(lot, {
      source_plant_ids: [P.a1, P.a1b],
      filing: { variety_id: fx.v.a3, expect_variety_id: fx.v.a2 },
    })
    expect(r.status, JSON.stringify(r.body)).toBe(409)
    expect(r.body.error).toBe(LOT_CHANGED)
    expect(r.body.code).toBe('lot_changed')
    expect(r.body.variety_id).toBe(fx.v.a1)
    expect(r.body.name).toBe(row.name)
    expect(r.body.source_plant_id).toBe(P.a1)
    expect(r.body.source_plants.map((s) => s.id)).toEqual([P.a1])
    expect(await everything()).toBe(before)
    expect(await livePlants(lot)).toEqual([P.a1])
  })

  it('D9b: the filing is fine and the expected set is stale -> 409 lot_changed; the FILING is untouched', async () => {
    const lot = await newLot({ source_plant_ids: [P.a1, P.a1b] })
    const before = await everything()
    const r = await put(lot, {
      source_plant_ids: [P.a1], expected_source_plant_ids: [P.a1],
      filing: { variety_id: fx.v.a2, expect_variety_id: fx.v.a1 },
    })
    expect(r.status, JSON.stringify(r.body)).toBe(409)
    expect(r.body.code).toBe('lot_changed')
    expect(r.body.source_plants.map((s) => s.id).sort()).toEqual(sorted(P.a1, P.a1b))
    expect(await everything()).toBe(before)
    expect((await lotRow(lot)).variety_id).toBe(fx.v.a1)
  })

  it('D9c: both fine -> both written; and a filing to the variety the lot already has is changed:false beside a written set', async () => {
    const lot = await newLot({ source_plant_ids: [P.a1, P.a1b] })
    const r = await put(lot, {
      source_plant_ids: [P.a1], expected_source_plant_ids: [P.a1b, P.a1],
      filing: { variety_id: fx.v.a2, expect_variety_id: fx.v.a1, name: `slf d9c ${RUN}` },
    })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.filing).toMatchObject({ variety_id: fx.v.a2, name: `slf d9c ${RUN}`, changed: true })
    expect(await livePlants(lot)).toEqual([P.a1])
    expect((await lotRow(lot)).variety_id).toBe(fx.v.a2)
    expect((await lotRow(lot)).name).toBe(`slf d9c ${RUN}`)

    const same = await put(lot, {
      source_plant_ids: [P.a1, P.a1b],
      filing: { variety_id: fx.v.a2, expect_variety_id: fx.v.a1, name: 'not written on a replay' },
    })
    expect(same.status, JSON.stringify(same.body)).toBe(200)
    expect(same.body.filing).toMatchObject({ variety_id: fx.v.a2, name: `slf d9c ${RUN}`, changed: false })
    expect(await livePlants(lot)).toEqual(sorted(P.a1, P.a1b))
    expect((await lotRow(lot)).name).toBe(`slf d9c ${RUN}`)
  })

  it('a refused filing refuses the whole edit: an unusable target, and a target of another crop, each leave the set as it was', async () => {
    const lot = await newLot({ source_plant_ids: [P.a1] })
    const before = await everything()
    const unusable = await put(lot, {
      source_plant_ids: [P.a1, P.a1b], filing: { variety_id: fx.v.gone, expect_variety_id: fx.v.a1 },
    })
    expect(unusable.status, JSON.stringify(unusable.body)).toBe(400)
    expect(unusable.body).toEqual({ error: VARIETY_UNUSABLE, code: 'variety_unusable' })
    expect(await everything()).toBe(before)
    const crop = await put(lot, {
      source_plant_ids: [P.a1, P.a1b], filing: { variety_id: fx.v.b, expect_variety_id: fx.v.a1 },
    })
    expect(crop.status, JSON.stringify(crop.body)).toBe(400)
    expect(crop.body).toEqual({ error: FILING_CROP_MISMATCH, code: 'filing_crop_mismatch' })
    expect(await everything()).toBe(before)
    expect(await livePlants(lot)).toEqual([P.a1])
  })

  it('D10: the crop is judged against the NEW set — a crop-A lot given a crop-B parent and re-filed to a crop-B variety in one request -> 200; the same filing alone -> 400', async () => {
    const lot = await newLot({ source_plant_ids: [P.a1] })
    const before = await everything()
    const alone = await file(lot, { variety_id: fx.v.b, expect_variety_id: fx.v.a1 })
    expect(alone.status, JSON.stringify(alone.body)).toBe(400)
    expect(alone.body.code).toBe('filing_crop_mismatch')
    expect(await everything()).toBe(before)

    const together = await put(lot, {
      source_plant_ids: [P.b], filing: { variety_id: fx.v.b, expect_variety_id: fx.v.a1 },
    })
    expect(together.status, JSON.stringify(together.body)).toBe(200)
    expect(await livePlants(lot)).toEqual([P.b])
    const after = await lotRow(lot)
    expect(after.variety_id).toBe(fx.v.b)
    expect(after.source_plant_id).toBe(P.b)
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// D8, E2-E4 — the filing against the other writers of one lot
// ───────────────────────────────────────────────────────────────────────────────────────────────────
// How each case is ordered (_seedLotKit.js inOrder): a psql session holds the lot row; the first request
// is sent and shown waiting behind that session; the second is sent and shown waiting behind the FIRST;
// then the session commits. So the first request always runs first, and the second is judged on what
// it left.
const inOrder = (lot, first, second, label) => inOrderOn(
  `SELECT id FROM inventory_items WHERE id = ${lit(lot)} FOR UPDATE;`, first, second, label)

describe.skipIf(!READY || !HAS_PSQL)('D8, E — the filing queues on the lot row with every other writer of the lot', () => {
  it('D8: two filings at once to DIFFERENT targets — the first writes, the second answers 409 lot_changed with what the first left', { timeout: 90000 }, async () => {
    const lot = await newLot()
    const row = await lotRow(lot)
    const [first, second] = await inOrder(lot,
      () => file(lot, { variety_id: fx.v.a2, expect_variety_id: fx.v.a1 }),
      () => file(lot, { variety_id: fx.v.a3, expect_variety_id: fx.v.a1 }), 'D8 different')
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    expect(first.body.changed).toBe(true)
    expect(second.status, JSON.stringify(second.body)).toBe(409)
    expect(second.body).toEqual({ error: LOT_CHANGED, code: 'lot_changed', variety_id: fx.v.a2, name: row.name })
    expect((await lotRow(lot)).variety_id).toBe(fx.v.a2)
  })

  it('D8: two filings at once to the SAME target — the first writes, the second answers 200 changed:false', { timeout: 90000 }, async () => {
    const lot = await newLot()
    const [first, second] = await inOrder(lot,
      () => file(lot, { variety_id: fx.v.a2, expect_variety_id: fx.v.a1 }),
      () => file(lot, { variety_id: fx.v.a2, expect_variety_id: fx.v.a1 }), 'D8 same')
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    expect(first.body.changed).toBe(true)
    expect(second.status, JSON.stringify(second.body)).toBe(200)
    expect(second.body.changed).toBe(false)
    expect(second.body.previous.variety_id).toBe(fx.v.a2)
    expect((await lotRow(lot)).variety_id).toBe(fx.v.a2)
  })

  it.each([
    ['the filing first', true],
    ['the parents write first', false],
  ])('E2: PUT /filing against PUT /source-plants on one lot, %s — they run one after the other, both 200, no deadlock', { timeout: 90000 }, async (_label, filingFirst) => {
    const lot = await newLot({ source_plant_ids: [P.a1] })
    const doFile = () => file(lot, { variety_id: fx.v.a3, expect_variety_id: fx.v.a1 })
    const doPut = () => put(lot, { source_plant_ids: [P.a1, P.a1b] })
    const [first, second] = await inOrder(lot, filingFirst ? doFile : doPut, filingFirst ? doPut : doFile, 'E2')
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    expect(second.status, JSON.stringify(second.body)).toBe(200)
    expect((await lotRow(lot)).variety_id).toBe(fx.v.a3)
    expect(await livePlants(lot)).toEqual(sorted(P.a1, P.a1b))
  })

  it('E2: a parents write that needs the mix, behind a filing that takes the mix away -> the filing 200, the parents write 409 parents_changed; nothing half-applied', { timeout: 90000 }, async () => {
    const lot = await newLot({ source_plant_ids: [P.a1], variety_id: MIX.pair.id })
    const [first, second] = await inOrder(lot,
      () => file(lot, { variety_id: fx.v.a3, expect_variety_id: MIX.pair.id }),
      () => put(lot, { source_plant_ids: [P.a1, P.a2] }), 'E2 mix')
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    expect(second.status, JSON.stringify(second.body)).toBe(409)
    expect(second.body.code).toBe('parents_changed')
    expect((await lotRow(lot)).variety_id).toBe(fx.v.a3)
    expect(await livePlants(lot)).toEqual([P.a1])
  })

  it.each([
    ['the filing first', true],
    ['the merge first', false],
  ])('E3: PUT /filing against a planting merge that touches the lot, %s — they queue on the lot row, both 200', { timeout: 90000 }, async (_label, filingFirst) => {
    const proj = await insertProject({ name: `slf-mrg-${RUN}-${seq++}`, createdBy: USER })
    const w = await planting('E3w', { projectId: proj.id })
    const l = await planting('E3l', { projectId: proj.id })
    const lot = await newLot({ source_plant_ids: [w, l], source_plant_id: l })
    const doFile = () => file(lot, { variety_id: fx.v.a3, expect_variety_id: fx.v.a1 })
    const doMerge = () => merge(w, [l])
    const [first, second] = await inOrder(lot, filingFirst ? doFile : doMerge, filingFirst ? doMerge : doFile, 'E3')
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    expect(second.status, JSON.stringify(second.body)).toBe(200)
    const after = await lotRow(lot)
    expect(after.variety_id).toBe(fx.v.a3)
    expect(after.source_plant_id).toBe(w)
    expect(await livePlants(lot)).toEqual([w])
  })

  it.each([
    ['the filing first', true],
    ['the wide PUT first', false],
  ])('E4: PUT /filing against the wide PUT on one row, %s — they run one after the other, both 200, and the re-file stands', { timeout: 90000 }, async (_label, filingFirst) => {
    const lot = await newLot({ source_plant_ids: [P.a1] })
    const row = await lotRow(lot)
    const doFile = () => file(lot, { variety_id: fx.v.a3, expect_variety_id: fx.v.a1 })
    // What a shipped client sends: the row as it read it, variety and all, with one field changed.
    const doWide = () => widePut(lot, {
      name: row.name, type: 'consumable', category: 'seeds', unit: 'packet', quantity_on_hand: 9, variety_id: fx.v.a1,
    })
    const [first, second] = await inOrder(lot, filingFirst ? doFile : doWide, filingFirst ? doWide : doFile, 'E4')
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    expect(second.status, JSON.stringify(second.body)).toBe(200)
    const after = await directSql`SELECT variety_id, quantity_on_hand::text AS q FROM inventory_items WHERE id = ${lot}`
    expect(after[0].variety_id).toBe(fx.v.a3)
    expect(Number(after[0].q)).toBe(9)
  })
})
