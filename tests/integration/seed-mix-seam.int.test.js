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

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
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

// Both Lambdas name release 2a's schema. One failure that says what to apply.
const [present] = await directSql`
  SELECT to_regclass('public.seed_lot_parent_planting') IS NOT NULL AS links,
         to_regclass('public.variety_blend_component') IS NOT NULL AS components,
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'plant_varieties' AND column_name = 'blend_key') AS blend_key,
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'inventory_items' AND column_name = 'seed_parent_plant_count') AS plant_count`
const MISSING = [
  !present.links && 'public.seed_lot_parent_planting (v5-seedmultiparent-001)',
  !present.blend_key && 'plant_varieties.blend_key (v5-varietyblend-001)',
  !present.components && 'public.variety_blend_component (v5-varietyblend-001)',
  !present.plant_count && 'inventory_items.seed_parent_plant_count (v5-seedplantcount-001)',
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
const inv = (method, path, body) => {
  setTestUserId(USER)
  return callHandler(invHandler, { method, path, body })
}
const varieties = (method, path, body) => {
  setTestUserId(USER)
  return callHandler(varietiesHandler, { method, path, body })
}
const lotBody = (extra) => ({
  name: `sms-lot-${RUN}-${seq++}`, type: 'consumable', category: 'seeds', unit: 'packet', quantity_on_hand: 1, ...extra,
})
// Every key the contract file says a reply carries is there. Presence, not value: null is a value.
const expectKeys = (body, keys, what) => {
  for (const key of keys) expect(body, `${what}: "${key}"`).toHaveProperty(key)
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
  const ids = assertFixtureId(USER)
  await settle(`seed-mix-seam teardown ${RUN}`, [
    ...seedMixTeardown(ids, fx?.crops),
    () => directSql`DELETE FROM plant_projects WHERE created_by = ANY(${ids})`,
  ])
}, 60000)

describe.skipIf(!READY)('the save flow across both Lambdas', () => {
  it('the contract file is the one this test was written against', () => {
    expect(CONTRACT.name).toBe('seed-mix')
    expect(CONTRACT.verified_by).toBe('tests/integration/seed-mix-seam.int.test.js')
    expect(CONTRACT.varieties_blend.required).toEqual(
      ['id', 'name', 'variety_rank', 'crop_type_slug', 'blend_key', 'exists', 'created', 'components'])
    expect(CONTRACT.seed_lot.source_plant_required).toEqual(
      ['id', 'name', 'variety_id', 'variety_name', 'breeding_system', 'variety_rank', 'crop_slug', 'archived', 'deleted'])
  })

  it('1. the varieties Lambda makes the mix of the parents\' varieties: 201, every REQUIRED key', async () => {
    const r = await varieties('POST', '/api/varieties/blend', { component_variety_ids: [fx.v.a2, fx.v.a1], create: true })
    expect(CONTRACT.varieties_blend.statuses).toContain(r.status)
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expectKeys(r.body, CONTRACT.varieties_blend.required, 'POST /api/varieties/blend')
    expect(r.body.variety_rank).toBe(CONTRACT.varieties_blend.variety_rank)
    for (const c of r.body.components) expectKeys(c, CONTRACT.varieties_blend.component_required, 'a component')
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

    const filed = await inv('PUT', `/api/inventory-items/${lot}/filing`, {
      variety_id: fx.v.a3, expect_variety_id: state.mix.id, name: `sms refiled ${RUN}`,
    })
    expect(filed.status, JSON.stringify(filed.body)).toBe(200)
    expectKeys(filed.body, CONTRACT.filing_put.required, 'PUT filing')
    expectKeys(filed.body.previous, CONTRACT.filing_put.previous_required, 'PUT filing previous')
    expect(Object.keys(filed.body).sort()).toEqual([...CONTRACT.filing_put.required].sort())

    const measured = await inv('PUT', `/api/inventory-items/${lot}/seed-measure`, { seed_parent_plant_count: 2 })
    expect(measured.status, JSON.stringify(measured.body)).toBe(200)
    expectKeys(measured.body, CONTRACT.seed_measure_put.required, 'PUT seed-measure')
    expect(measured.body.seed_parent_plant_count).toBe(2)
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
