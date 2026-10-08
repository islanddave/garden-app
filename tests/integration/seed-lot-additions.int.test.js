// seed-lot-additions.int.test.js — V5-SEEDLOTADDITION-001 (release 3) on a real Postgres:
// POST /api/inventory-items/:id/seed-additions, "put it in a seed lot I already started", and the
// compare-and-set it forced onto PUT /api/inventory-items/:id/seed-measure.
//
// WHY THIS FILE EXISTS. The unit suite (lambda/inventory-items/seed-lot-additions.test.js) drives the
// route against a stub that executes no SQL. Everything the release actually promises is a property of
// statements running in one transaction on real rows:
//   - the nine count cells and the four weight cells come out as the contract's table says, on BOTH
//     tables, and never trip a CHECK;
//   - an addition is idempotent on its key — sent twice, sent twice at once, sent again after the lot
//     was used up or the plant taken off it;
//   - a refused addition writes NOTHING: not the link row, not the re-file, not the picking row, not
//     even updated_at — each refusal is sent with a new plant and a filing, so every write that could
//     leak is armed;
//   - two additions at once both land, once each;
//   - a planting merge is not blocked by the picking table's foreign key;
//   - a stale page can no longer write an absolute count over a picking.
//
// EVERY ASSERTION ABOUT STATE IS A directSql READ-BACK (L-108); timestamps are compared as text.
// Lines that begin [R3-MEASURED] are the lane report's raw material: what the database answered.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { directSql, callHandler, testRunId, setTestUserId } from './_harness.js'
import { assertFixtureId, settle } from './_cleanup.js'
import { seedVarietyFixture, seedMixTeardown, twoSessions } from './_seedLotKit.js'
import { handler as invHandler, SEED_CONSTRAINT_MESSAGES } from '../../lambda/inventory-items/index.js'
import { handler as varietiesHandler } from '../../lambda/varieties/index.js'
import { handler as plantsHandler } from '../../lambda/plants/index.js'
import { addSeedToLot } from '../../lambda/inventory-items/seed-lot-additions.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CONTRACT = JSON.parse(readFileSync(join(ROOT, 'tests', 'contracts', 'seed-mix.json'), 'utf8'))

const RUN = testRunId()
const USER = `sla-user-${RUN}`
const FOREIGN = `sla-foreign-${RUN}`
const LOT_CHANGED = 'This seed lot was changed at the same moment. Reload and try again.'
const PLANTS_CHANGED = 'One of those plants changed just now. Reload and try again.'

// One failure that names what to apply, rather than forty that each say "relation does not exist".
const [present] = await directSql`
  SELECT to_regclass('public.seed_lot_addition') IS NOT NULL AS additions,
         to_regclass('public.seed_lot_parent_planting') IS NOT NULL AS links,
         to_regclass('public.variety_blend_component') IS NOT NULL AS components,
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'inventory_items' AND column_name = 'seed_parent_plant_count') AS plant_count`
const MISSING = [
  !present.additions && 'public.seed_lot_addition (migrations/v5-seedlotaddition-001/0a-additive-ddl.sql)',
  !present.links && 'public.seed_lot_parent_planting (v5-seedmultiparent-001)',
  !present.components && 'public.variety_blend_component (v5-varietyblend-001)',
  !present.plant_count && 'inventory_items.seed_parent_plant_count (v5-seedplantcount-001)',
].filter(Boolean)
const READY = MISSING.length === 0

describe('seed lot additions — the schema is on this branch', () => {
  it('the picking table and everything it hangs on exist (apply v5-seedlotaddition-001 before the code that names it)', () => {
    expect(MISSING, `missing on the database this suite forks: ${MISSING.join('; ')}`).toEqual([])
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// Fixtures and readers
// ───────────────────────────────────────────────────────────────────────────────────────────────────
let fx
let seq = 0
const MIX = {}
const { onOwnConnection, closeAll } = twoSessions()
// R3_MEASURE_LOG=<path> also appends each line to a file (a reporter may not print a passing test's output).
const measured = (line) => {
  console.log(`[R3-MEASURED] ${line}`)
  if (process.env.R3_MEASURE_LOG) appendFileSync(process.env.R3_MEASURE_LOG, `${line}\n`)
}

async function planting(tag, { by = USER, variety = fx.v.a1, quantity = 1, sourceLot = null } = {}) {
  const [p] = await directSql`
    INSERT INTO plants (project_id, name, created_by, variety_id, quantity, source_inventory_item_id)
    VALUES (NULL, ${`${tag}-sla-${RUN}-${seq++}`}, ${by}, ${variety}, ${quantity}, ${sourceLot})
    RETURNING id`
  return p.id
}
const inv = (method, path, body, as = USER) => {
  setTestUserId(as)
  return callHandler(invHandler, { method, path, body })
}
async function newLot(extra = {}, as = USER) {
  const r = await inv('POST', '/api/inventory-items', {
    name: `sla-lot-${RUN}-${seq++}`, type: 'consumable', category: 'seeds', unit: 'packet',
    quantity_on_hand: 1, variety_id: fx.v.a1, ...extra,
  }, as)
  expect(r.status, `POST lot -> ${JSON.stringify(r.body)}`).toBe(201)
  return r.body.id
}
// A lot with its own year, stage and process, so "a picking never moves these" has something to move.
async function agedLot(extra = {}) {
  const lot = await newLot(extra)
  await directSql`
    UPDATE inventory_items SET year_harvested = 2025, seed_stage = 'drying', seed_process = 'dry',
           created_at = now() - interval '40 days'
     WHERE id = ${lot}`
  return lot
}
const measure = async (lot, body) => {
  const r = await inv('PUT', `/api/inventory-items/${lot}/seed-measure`, body)
  expect(r.status, `PUT seed-measure -> ${JSON.stringify(r.body)}`).toBe(200)
  return r
}
const addBody = (plant, expected, extra = {}) => ({
  addition_key: randomUUID(), plant_id: plant, expected_source_plant_ids: expected, picked_on: '2026-09-01', ...extra,
})
const add = (lot, body, as = USER) => inv('POST', `/api/inventory-items/${lot}/seed-additions`, body, as)
async function newMix(ids) {
  setTestUserId(USER)
  const r = await callHandler(varietiesHandler, {
    method: 'POST', path: '/api/varieties/blend', body: { component_variety_ids: ids, create: true },
  })
  expect([200, 201], `POST /api/varieties/blend -> ${r.status} ${JSON.stringify(r.body)}`).toContain(r.status)
  return r.body
}

const lotRow = async (lot) => (await directSql`
  SELECT id, name, variety_id, source_plant_id, source_kind, seed_count, seed_count_estimated,
         seed_weight_g::text AS seed_weight_g, seed_parent_plant_count, quantity_on_hand::text AS quantity_on_hand,
         status, year_harvested, seed_stage, seed_process,
         created_at::text AS created_at, updated_at::text AS updated_at, deleted_at::text AS deleted_at
    FROM inventory_items WHERE id = ${lot}`)[0]
const pickings = async (lot) => directSql`
  SELECT a.id, a.addition_key, a.parent_link_id, l.plant_id, l.inventory_item_id, (l.deleted_at IS NULL) AS link_live,
         a.picked_on::text AS picked_on, a.seed_count, a.seed_count_estimated, a.seed_weight_g::text AS seed_weight_g,
         a.count_applied, a.weight_applied, a.created_by, (a.created_at = l.created_at) AS same_instant_as_link
    FROM seed_lot_addition a JOIN seed_lot_parent_planting l ON l.id = a.parent_link_id
   WHERE l.inventory_item_id = ${lot}
   ORDER BY a.created_at, a.id`
const links = async (lot) => (await directSql`
  SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int AS live,
         count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS retired
    FROM seed_lot_parent_planting WHERE inventory_item_id = ${lot}`)[0]
const livePlants = async (lot) => (await directSql`
  SELECT plant_id FROM seed_lot_parent_planting
   WHERE inventory_item_id = ${lot} AND role = 'seed_parent' AND deleted_at IS NULL
   ORDER BY plant_id`).map((r) => r.plant_id)
const allAdditions = async () => (await directSql`
  SELECT count(*)::int AS n FROM seed_lot_addition
   WHERE created_by IN (${USER}, ${FOREIGN})`)[0].n
// Everything a refused addition could have moved, in one string: the lot's own row (updated_at
// included), how many link rows it has, live and retired, and how many pickings exist at all.
async function snapshot(lot) {
  return JSON.stringify({ row: await lotRow(lot), links: await links(lot), onLot: (await pickings(lot)).length, anywhere: await allAdditions() })
}
// What the reply promises about the lot, against the row.
function expectReplyIsRow(body, row, what) {
  expect(body.id, what).toBe(row.id)
  expect(body.name, what).toBe(row.name)
  expect(body.variety_id, what).toBe(row.variety_id)
  expect(body.source_plant_id, what).toBe(row.source_plant_id)
  expect(body.seed_count, what).toBe(row.seed_count)
  expect(body.seed_count_estimated, what).toBe(row.seed_count_estimated)
  expect(body.seed_weight_g, what).toBe(row.seed_weight_g)
  expect(body.seed_parent_plant_count, what).toBe(row.seed_parent_plant_count)
  expect(body.quantity_on_hand, what).toBe(row.quantity_on_hand)
  expect(new Date(body.updated_at).getTime(), what).toBe(new Date(row.updated_at).getTime())
}
const UNMOVED = ['created_at', 'year_harvested', 'seed_stage', 'seed_process', 'quantity_on_hand', 'status']
const pickOf = (row, keys) => Object.fromEntries(keys.map((k) => [k, row[k]]))

beforeAll(async () => {
  if (!READY) return
  setTestUserId(USER)
  fx = await seedVarietyFixture({ run: RUN, user: USER, tag: 'sla' })
  MIX.pair = await newMix([fx.v.a1, fx.v.a2])
}, 60000)

afterAll(async () => {
  closeAll()
  if (!READY) return
  const ids = assertFixtureId(USER, FOREIGN)
  await settle(`seed-lot-additions teardown ${RUN}`, [
    // The own-source-lot case sows a planting FROM a lot that names a planting: plants and
    // inventory_items then hold each other (both keys RESTRICT) and neither can be deleted first.
    // The pointer is this file's own fixture, so this file lets go of it.
    () => directSql`UPDATE plants SET source_inventory_item_id = NULL WHERE created_by = ANY(${ids}) AND source_inventory_item_id IS NOT NULL`,
    () => directSql`DELETE FROM merge_event WHERE merged_by = ANY(${ids}) OR winner_plant_id IN (SELECT id FROM plants WHERE created_by = ANY(${ids}))`,
    ...seedMixTeardown(ids, fx?.crops),
    () => directSql`DELETE FROM plant_projects WHERE created_by = ANY(${ids})`,
  ])
}, 60000)

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// T1 / T1b — the amounts
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!READY)('T1 — the nine count cells (and a counted 0), both columns on both tables', () => {
  // [lot before, today] -> lot seed_count / seed_count_estimated after; picking seed_count,
  // seed_count_estimated, count_applied. `n` = 100, `a` = 7.
  const BEFORE = {
    uncounted: null,
    'counted n': { seed_count: 100, seed_count_estimated: false },
    'estimated n': { seed_count: 100, seed_count_estimated: true },
  }
  const TODAY = {
    blank: {},
    'counted a': { add_seed_count: 7, add_estimated: false },
    'estimated a': { add_seed_count: 7, add_estimated: true },
  }
  const CELLS = {
    'uncounted x blank': { lot: [null, null], picking: [null, null, false] },
    'uncounted x counted a': { lot: [null, null], picking: [7, false, false] },
    'uncounted x estimated a': { lot: [null, null], picking: [7, true, false] },
    'counted n x blank': { lot: [100, true], picking: [null, null, false] },
    'counted n x counted a': { lot: [107, false], picking: [7, false, true] },
    'counted n x estimated a': { lot: [107, true], picking: [7, true, true] },
    'estimated n x blank': { lot: [100, true], picking: [null, null, false] },
    'estimated n x counted a': { lot: [107, true], picking: [7, false, true] },
    'estimated n x estimated a': { lot: [107, true], picking: [7, true, true] },
  }
  let plant

  beforeAll(async () => { plant = await planting('t1') })

  async function cell(label, before, today, expected) {
    const lot = await agedLot({ source_plant_ids: [plant] })
    if (before) await measure(lot, before)
    const was = await lotRow(lot)
    const r = await add(lot, addBody(plant, [plant], today))
    expect(r.status, `${label} -> ${JSON.stringify(r.body)}`).toBe(200)
    const now = await lotRow(lot)
    const rows = await pickings(lot)
    expect(rows, label).toHaveLength(1)
    const got = {
      lot: [now.seed_count, now.seed_count_estimated],
      picking: [rows[0].seed_count, rows[0].seed_count_estimated, rows[0].count_applied],
    }
    measured(`T1 cell | ${label} | lot ${JSON.stringify(got.lot)} | picking ${JSON.stringify(got.picking)} | HTTP ${r.status}`)
    expect(got, label).toEqual(expected)
    // Both tables keep "a count and its basis are one fact".
    expect((now.seed_count === null) === (now.seed_count_estimated === null), `${label}: lot pairing`).toBe(true)
    expect((rows[0].seed_count === null) === (rows[0].seed_count_estimated === null), `${label}: picking pairing`).toBe(true)
    // On every 200: the lot's own age, stage, process, container count and status did not move…
    expect(pickOf(now, UNMOVED), `${label}: a column a picking must never move`).toEqual(pickOf(was, UNMOVED))
    expect(now.year_harvested).toBe(2025)
    expect(now.seed_stage).toBe('drying')
    // …and the reply's lot fields ARE the row.
    expectReplyIsRow(r.body, now, label)
    expect(r.body.addition).toEqual({
      id: rows[0].id, replayed: false, plant_was_added: false, count_applied: expected.picking[2], weight_applied: false,
    })
    expect(rows[0]).toMatchObject({ plant_id: plant, inventory_item_id: lot, link_live: true, picked_on: '2026-09-01', created_by: USER })
  }

  for (const [beforeName, before] of Object.entries(BEFORE)) {
    for (const [todayName, today] of Object.entries(TODAY)) {
      const label = `${beforeName} x ${todayName}`
      it(label, () => cell(label, before, today, CELLS[label]))
    }
  }

  it('a counted 0 is counted: 0/false + blank = 0/true', () => cell(
    'counted 0 x blank', { seed_count: 0, seed_count_estimated: false }, {}, { lot: [0, true], picking: [null, null, false] },
  ))

  it('a counted 0 is counted: 0/false + 5 counted = 5/false', () => cell(
    'counted 0 x counted 5', { seed_count: 0, seed_count_estimated: false }, { add_seed_count: 5, add_estimated: false },
    { lot: [5, false], picking: [5, false, true] },
  ))

  it('the table above has nine cells, and each was a case', () => {
    expect(Object.keys(CELLS)).toHaveLength(9)
    expect(Object.keys(BEFORE).flatMap((b) => Object.keys(TODAY).map((t) => `${b} x ${t}`)).sort()).toEqual(Object.keys(CELLS).sort())
  })
})

describe.skipIf(!READY)('T1b — the weight: four cells, exact arithmetic, and independent of the count', () => {
  let plant
  beforeAll(async () => { plant = await planting('t1b') })

  async function weigh(label, before, today, expected) {
    const lot = await agedLot({ source_plant_ids: [plant] })
    if (before) await measure(lot, before)
    const r = await add(lot, addBody(plant, [plant], today))
    expect(r.status, `${label} -> ${JSON.stringify(r.body)}`).toBe(200)
    const now = await lotRow(lot)
    const [row] = await pickings(lot)
    const got = { lot: now.seed_weight_g, picking: row.seed_weight_g, weight_applied: row.weight_applied, count: now.seed_count, count_applied: row.count_applied }
    measured(`T1b cell | ${label} | lot weight ${got.lot} | picking weight ${got.picking} | weight_applied ${got.weight_applied} | lot count ${got.count} | count_applied ${got.count_applied}`)
    expect(got, label).toEqual(expected)
    expectReplyIsRow(r.body, now, label)
    expect(r.body.addition.weight_applied).toBe(expected.weight_applied)
    expect(r.body.addition.count_applied).toBe(expected.count_applied)
  }

  it('NULL + w: the lot stays unweighed, the picking records w, not applied', () => weigh(
    'NULL + w', null, { add_seed_weight_g: 2.5 }, { lot: null, picking: '2.500', weight_applied: false, count: null, count_applied: false },
  ))
  it('NULL + blank: nothing, anywhere', () => weigh(
    'NULL + blank', null, {}, { lot: null, picking: null, weight_applied: false, count: null, count_applied: false },
  ))
  it('w0 + w is exactly w0 + w: 12.345 + 0.005 = 12.350', () => weigh(
    '12.345 + 0.005', { seed_weight_g: 12.345 }, { add_seed_weight_g: 0.005 },
    { lot: '12.350', picking: '0.005', weight_applied: true, count: null, count_applied: false },
  ))
  it('w0 + blank: the lot keeps w0', () => weigh(
    'w0 + blank', { seed_weight_g: 12.345 }, {}, { lot: '12.345', picking: null, weight_applied: false, count: null, count_applied: false },
  ))
  it('the count applies and the weight does not: a counted, unweighed lot + (a, w)', () => weigh(
    'counted, unweighed + (7, 2.5)', { seed_count: 100, seed_count_estimated: false }, { add_seed_count: 7, add_estimated: false, add_seed_weight_g: 2.5 },
    { lot: null, picking: '2.500', weight_applied: false, count: 107, count_applied: true },
  ))
  it('the weight applies and the count does not: a weighed, uncounted lot + (a, w)', () => weigh(
    'weighed, uncounted + (7, 2.5)', { seed_weight_g: 10 }, { add_seed_count: 7, add_estimated: true, add_seed_weight_g: 2.5 },
    { lot: '12.500', picking: '2.500', weight_applied: true, count: null, count_applied: false },
  ))

  it('a weight that rounds to nothing is refused by the route, not by the CHECK — and nothing is written', async () => {
    const lot = await agedLot({ source_plant_ids: [plant] })
    const before = await snapshot(lot)
    const errors = []
    const orig = console.error
    console.error = (...a) => errors.push(a)
    let r
    try { r = await add(lot, addBody(plant, [plant], { add_seed_weight_g: 0.0004 })) } finally { console.error = orig }
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('add_seed_weight_g must be more than 0 and at most 100000 grams')
    expect(errors, 'a statement raised: the 400 came from the database, not the rule').toHaveLength(0)
    expect(await snapshot(lot)).toBe(before)
    // The CHECK it is in front of is real, and has a sentence if anything ever reaches it.
    const [link] = await directSql`SELECT id FROM seed_lot_parent_planting WHERE inventory_item_id = ${lot} AND deleted_at IS NULL`
    const raw = await directSql`
      INSERT INTO seed_lot_addition (addition_key, parent_link_id, picked_on, seed_weight_g, count_applied, weight_applied, created_by)
      VALUES (${randomUUID()}, ${link.id}, '2026-09-01', 0.0004, false, false, ${USER})`.then(() => null, (e) => e)
    expect(raw?.code).toBe('23514')
    expect(raw?.constraint).toBe('chk_sla_seed_weight_positive')
    expect(SEED_CONSTRAINT_MESSAGES[raw.constraint]).toEqual(expect.any(String))
    expect(await snapshot(lot)).toBe(before)
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// T2 / T3 — the key
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!READY)('T2 — replay: the same key on the same lot is a 200 that writes nothing', () => {
  it('(a) a plant already in the lot: the amount is raised once, the same addition.id, replayed true', async () => {
    const plant = await planting('t2a')
    const lot = await agedLot({ source_plant_ids: [plant] })
    await measure(lot, { seed_count: 100, seed_count_estimated: false })
    const body = addBody(plant, [plant], { add_seed_count: 7, add_estimated: false })
    const first = await add(lot, body)
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    expect(first.body.addition).toMatchObject({ replayed: false, plant_was_added: false, count_applied: true })
    const after = await snapshot(lot)
    const second = await add(lot, body)
    expect(second.status, JSON.stringify(second.body)).toBe(200)
    expect(second.body.addition).toEqual({ ...first.body.addition, replayed: true })
    expect(second.body.seed_count).toBe(107)
    expect(await snapshot(lot), 'a replay wrote something').toBe(after)
    expect(await pickings(lot)).toHaveLength(1)
    expectReplyIsRow(second.body, await lotRow(lot), 'replay')
  })

  it('(b) a NEW plant, same body twice: plant_was_added true BOTH times, one link row, one picking row, the plant count raised once', async () => {
    const [first, second] = [await planting('t2b-first'), await planting('t2b-new')]
    const lot = await agedLot({ source_plant_ids: [first] })
    await measure(lot, { seed_count: 100, seed_count_estimated: false, seed_parent_plant_count: 3 })
    const body = addBody(second, [first], { add_seed_count: 7, add_estimated: false })
    const one = await add(lot, body)
    expect(one.status, JSON.stringify(one.body)).toBe(200)
    expect(one.body.addition).toMatchObject({ replayed: false, plant_was_added: true })
    expect(one.body.seed_parent_plant_count).toBe(4)
    const after = await snapshot(lot)
    const two = await add(lot, body)
    expect(two.status, JSON.stringify(two.body)).toBe(200)
    expect(two.body.addition).toEqual({ ...one.body.addition, replayed: true })
    // The INFERENCE the contract asks this test to prove: the link row and the picking row carry the
    // same created_at exactly when one transaction wrote both.
    const [row] = await pickings(lot)
    expect(row.same_instant_as_link).toBe(true)
    measured(`T2b | link.created_at = picking.created_at when one transaction wrote both: ${row.same_instant_as_link}`)
    expect(await snapshot(lot)).toBe(after)
    expect(await links(lot)).toEqual({ live: 2, retired: 0 })
    expect(await pickings(lot)).toHaveLength(1)
    expect((await lotRow(lot)).seed_parent_plant_count).toBe(4)
    // And for a plant that was ALREADY there, the two instants differ: plant_was_added false on replay.
    const again = addBody(first, [first, second].sort(), { add_seed_count: 1, add_estimated: false })
    expect((await add(lot, again)).body.addition.plant_was_added).toBe(false)
    expect((await add(lot, again)).body.addition).toMatchObject({ replayed: true, plant_was_added: false })
    measured(`T2b | a picking on a plant already in the lot replays with plant_was_added false: ${(await pickings(lot)).map((p) => p.same_instant_as_link).join(',')}`)
  })

  it('(c) a re-filing body twice: the second is a 200 with NO filing key, name and variety as the first left them', async () => {
    const [a1, a2] = [await planting('t2c-a1'), await planting('t2c-a2', { variety: fx.v.a2 })]
    const lot = await agedLot({ source_plant_ids: [a1] })
    const name = `sla refiled ${RUN} ${seq++}`
    const body = addBody(a2, [a1], { filing: { variety_id: MIX.pair.id, expect_variety_id: fx.v.a1, name } })
    const first = await add(lot, body)
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    expect(first.body.filing).toMatchObject({ variety_id: MIX.pair.id, name, changed: true, previous: { variety_id: fx.v.a1 } })
    expect(first.body).toMatchObject({ variety_id: MIX.pair.id, name })
    const after = await snapshot(lot)
    // The same body: its expect_variety_id is now stale by construction.
    const second = await add(lot, body)
    expect(second.status, JSON.stringify(second.body)).toBe(200)
    expect(second.body).not.toHaveProperty('filing')
    expect(second.body).toMatchObject({ variety_id: MIX.pair.id, name })
    expect(second.body.addition).toEqual({ ...first.body.addition, replayed: true })
    expect(await snapshot(lot)).toBe(after)
  })

  it('(d) first POST, then the lot is used up, same body: 200 replayed, not 409', async () => {
    const plant = await planting('t2d')
    const lot = await agedLot({ source_plant_ids: [plant] })
    const body = addBody(plant, [plant], { add_seed_weight_g: 1.5 })
    const first = await add(lot, body)
    expect(first.status).toBe(200)
    await directSql`UPDATE inventory_items SET quantity_on_hand = 0, status = 'depleted' WHERE id = ${lot}`
    const after = await snapshot(lot)
    const second = await add(lot, body)
    expect(second.status, JSON.stringify(second.body)).toBe(200)
    expect(second.body.addition).toEqual({ ...first.body.addition, replayed: true })
    // The lot as it stands NOW.
    expect(second.body.quantity_on_hand).toBe('0.000')
    expect(await snapshot(lot)).toBe(after)
    // A NEW key on the same lot is the refusal.
    expect((await add(lot, addBody(plant, [plant]))).status).toBe(409)
  })

  it('(e) POST, take the plant off the lot by PUT /source-plants, replay: 200 replayed, the amount unchanged', async () => {
    const [stays, leaves] = [await planting('t2e-stays'), await planting('t2e-leaves')]
    const lot = await agedLot({ source_plant_ids: [stays] })
    await measure(lot, { seed_count: 100, seed_count_estimated: false })
    const body = addBody(leaves, [stays], { add_seed_count: 7, add_estimated: false })
    const first = await add(lot, body)
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    const off = await inv('PUT', `/api/inventory-items/${lot}/source-plants`, {
      source_plant_ids: [stays], expected_source_plant_ids: [stays, leaves],
    })
    expect(off.status, JSON.stringify(off.body)).toBe(200)
    expect(await livePlants(lot)).toEqual([stays])
    const after = await snapshot(lot)
    const second = await add(lot, body)
    expect(second.status, JSON.stringify(second.body)).toBe(200)
    expect(second.body.addition).toEqual({ ...first.body.addition, replayed: true, plant_was_added: true })
    expect(second.body.seed_count).toBe(107)
    expect(second.body.source_plants.map((p) => p.id)).toEqual([stays])
    expect(await snapshot(lot)).toBe(after)
    // The picking is still the record, on a link row that is no longer live.
    expect(await pickings(lot)).toMatchObject([{ plant_id: leaves, link_live: false, seed_count: 7 }])
  })

  it('(f) POST, soft-delete the planting, replay: 200 — the gate that would refuse it is not asked', async () => {
    const [stays, goes] = [await planting('t2f-stays'), await planting('t2f-goes')]
    const lot = await agedLot({ source_plant_ids: [stays] })
    const body = addBody(goes, [stays], { add_seed_count: 4, add_estimated: true })
    const first = await add(lot, body)
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    await directSql`UPDATE plants SET deleted_at = now() WHERE id = ${goes}`
    const after = await snapshot(lot)
    const second = await add(lot, body)
    expect(second.status, JSON.stringify(second.body)).toBe(200)
    expect(second.body.addition).toEqual({ ...first.body.addition, replayed: true })
    expect(await snapshot(lot)).toBe(after)
    // A NEW addition from the deleted planting is the gate's 400.
    const fresh = await add(lot, addBody(goes, [stays, goes].sort()))
    expect(fresh.status).toBe(400)
    expect(fresh.body).toEqual({ error: 'plant_id does not match a planting you can use' })
    expect(await snapshot(lot)).toBe(after)
  })
})

describe.skipIf(!READY)('T3 — the same key on another lot is 409 addition_key_conflict, and neither lot moves', () => {
  it('both lots are as they were', async () => {
    const plant = await planting('t3')
    const [first, other] = [await agedLot({ source_plant_ids: [plant] }), await agedLot({ source_plant_ids: [plant] })]
    await measure(other, { seed_count: 50, seed_count_estimated: false })
    const body = addBody(plant, [plant], { add_seed_count: 7, add_estimated: false })
    expect((await add(first, body)).status).toBe(200)
    const [a, b] = [await snapshot(first), await snapshot(other)]
    const r = await add(other, body)
    const spec = CONTRACT.seed_additions_post.refusals.addition_key_conflict
    expect(r.status, JSON.stringify(r.body)).toBe(spec.status)
    expect(r.body).toEqual({ error: spec.error, code: 'addition_key_conflict' })
    expect(await snapshot(first)).toBe(a)
    expect(await snapshot(other)).toBe(b)
    measured(`T3 wrote-nothing | addition_key_conflict | HTTP ${r.status} ${r.body.code} | both lots before == after: true`)
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// T4 — refusals write nothing
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!READY)('T4 — every refusal leaves the lot, its link rows and the picking table exactly as they were', () => {
  let member
  beforeAll(async () => { member = await planting('t4-member') })

  // A counted, weighed lot filed under a1 with one parent, and a NEW plant of a2 with the filing that
  // would move the lot to the mix: every write the transaction has is armed. The control proves the
  // same request, undisturbed, is a 200 that makes all four writes.
  const armedLot = async () => {
    const lot = await agedLot({ source_plant_ids: [member] })
    await measure(lot, { seed_count: 100, seed_count_estimated: false, seed_weight_g: 5, seed_parent_plant_count: 2 })
    return lot
  }
  const armedBody = (plant, expected = [member], extra = {}) => addBody(plant, expected, {
    add_seed_count: 5, add_estimated: false, add_seed_weight_g: 1.25,
    filing: { variety_id: MIX.pair.id, expect_variety_id: fx.v.a1, name: `sla should not stick ${RUN} ${seq++}` },
    ...extra,
  })
  async function refused(label, lot, send, { status, code, error }) {
    const before = await snapshot(lot)
    const errors = []
    const orig = console.error
    console.error = (...a) => errors.push(a)
    let r
    try { r = await send() } finally { console.error = orig }
    expect(r.status, `${label} -> ${JSON.stringify(r.body)}`).toBe(status)
    if (code) expect(r.body.code, label).toBe(code)
    else expect(r.body, label).not.toHaveProperty('code')
    if (error) expect(r.body.error, label).toBe(error)
    expect(errors, `${label}: a statement raised`).toHaveLength(0)
    const same = (await snapshot(lot)) === before
    measured(`T4 wrote-nothing | ${label} | HTTP ${r.status} ${r.body.code ?? '(no code)'} | lot row, link rows (live+retired), picking rows before == after: ${same}`)
    expect(same, `${label}: a refused addition changed something`).toBe(true)
    return r
  }
  const specOf = (code) => {
    const spec = CONTRACT.seed_additions_post.refusals[code] ?? CONTRACT.refusals[code]
    expect(spec, `tests/contracts/seed-mix.json has no refusal ${code}`).toBeDefined()
    return { status: spec.status, code, error: spec.error }
  }

  it('the control: the armed request, undisturbed, is a 200 that links the plant, re-files the lot, raises the amounts and records the picking', async () => {
    const lot = await armedLot()
    const plant = await planting('t4-control', { variety: fx.v.a2 })
    const body = armedBody(plant)
    const r = await add(lot, body)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const row = await lotRow(lot)
    expect(row).toMatchObject({ variety_id: MIX.pair.id, name: body.filing.name, seed_count: 105, seed_weight_g: '6.250', seed_parent_plant_count: 3 })
    expect(await links(lot)).toEqual({ live: 2, retired: 0 })
    expect(await pickings(lot)).toHaveLength(1)
  })

  it('verdict 2 — key_conflict', async () => {
    const lot = await armedLot()
    const elsewhere = await armedLot()
    const used = addBody(member, [member])
    expect((await add(elsewhere, used)).status).toBe(200)
    const plant = await planting('t4-v2', { variety: fx.v.a2 })
    await refused('verdict 2 key_conflict', lot, () => add(lot, { ...armedBody(plant), addition_key: used.addition_key }), specOf('addition_key_conflict'))
  })

  it('verdict 3 — used_up, both signals: quantity_on_hand = 0, and status depleted with a quantity of 1', async () => {
    const plant = await planting('t4-v3', { variety: fx.v.a2 })
    const empty = await armedLot()
    await directSql`UPDATE inventory_items SET quantity_on_hand = 0 WHERE id = ${empty}`
    await refused('verdict 3 used_up (quantity_on_hand = 0)', empty, () => add(empty, armedBody(plant)), specOf('lot_used_up'))
    const depleted = await armedLot()
    await directSql`UPDATE inventory_items SET status = 'depleted' WHERE id = ${depleted}`
    expect((await lotRow(depleted)).quantity_on_hand).toBe('1.000')
    await refused('verdict 3 used_up (status depleted, quantity 1)', depleted, () => add(depleted, armedBody(plant)), specOf('lot_used_up'))
  })

  it('verdict 4 — lot_changed: the caller\'s set is not the lot\'s, and the 409 says what the lot holds', async () => {
    const lot = await armedLot()
    const plant = await planting('t4-v4', { variety: fx.v.a2 })
    // Stale: the caller believes the lot has no plant on record.
    const r = await refused('verdict 4 lot_changed', lot, () => add(lot, armedBody(plant, [])), specOf('lot_changed'))
    expect(Object.keys(r.body).sort()).toEqual([
      'code', 'error', 'name', 'quantity_on_hand', 'seed_count', 'seed_count_estimated', 'seed_parent_plant_count',
      'seed_weight_g', 'source_plant_id', 'source_plants', 'variety_id',
    ])
    const row = await lotRow(lot)
    expect(r.body).toMatchObject({
      source_plant_id: member, variety_id: fx.v.a1, name: row.name, seed_count: 100, seed_count_estimated: false,
      seed_weight_g: '5.000', seed_parent_plant_count: 2, quantity_on_hand: '1.000',
    })
    expect(r.body.source_plants.map((p) => p.id)).toEqual([member])
    // A sheet that takes that body as its picture of the lot is not stale any more.
    const retry = await add(lot, armedBody(plant, r.body.source_plants.map((p) => p.id)))
    expect(retry.status, JSON.stringify(retry.body)).toBe(200)
  })

  it('verdict 5 — source_kind: the 400 is the judge\'s, with the CHECK\'s own sentence, and no statement raised', async () => {
    const gift = await newLot()
    const r0 = await inv('PATCH', `/api/inventory-items/${gift}/source-kind`, { source_kind: 'gift' })
    expect(r0.status, JSON.stringify(r0.body)).toBe(200)
    const plant = await planting('t4-v5')
    // refused() fails the case if console.error was called: a 23514 reaching the handler's catch
    // would answer this same sentence, and that is exactly what must NOT be how it was answered.
    const r = await refused('verdict 5 source_kind', gift, () => add(gift, armedBody(plant, [], { filing: { variety_id: fx.v.a3, expect_variety_id: fx.v.a1 } })), {
      status: 400, error: SEED_CONSTRAINT_MESSAGES.chk_inventory_seed_source_plant,
    })
    expect(Object.keys(r.body)).toEqual(['error'])
  })

  it('verdict 7 — own_source_lot: a plant grown from this lot', async () => {
    const lot = await armedLot()
    const grown = await planting('t4-v7', { variety: fx.v.a2, sourceLot: lot })
    await refused('verdict 7 own_source_lot', lot, () => add(lot, armedBody(grown)), specOf('own_source_lot'))
  })

  it('verdict 8 — no_parent_variety: a lot with no plant on record takes only its own variety', async () => {
    const bare = await agedLot()
    expect(await links(bare)).toEqual({ live: 0, retired: 0 })
    const other = await planting('t4-v8', { variety: fx.v.a2 })
    await refused('verdict 8 variety_mismatch_no_parents', bare, () => add(bare, armedBody(other, [], {
      filing: { variety_id: fx.v.a2, expect_variety_id: fx.v.a1 },
    })), specOf('variety_mismatch_no_parents'))
    // The same lot, a plant of ITS variety: 200, and the plant is now its one parent.
    const same = await planting('t4-v8-same')
    const ok = await add(bare, addBody(same, []))
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body).toMatchObject({ source_plant_id: same, addition: { plant_was_added: true } })
    expect(await livePlants(bare)).toEqual([same])
  })

  it('verdict 9 — too_many_parents: a thirteenth plant', async () => {
    const twelve = []
    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      twelve.push(await planting(`t4-v9-${i}`))
    }
    const lot = await agedLot({ source_plant_ids: twelve })
    const thirteenth = await planting('t4-v9-13')
    await refused('verdict 9 too_many_parents', lot, () => add(lot, armedBody(thirteenth, twelve, {
      filing: { variety_id: fx.v.a3, expect_variety_id: fx.v.a1 },
    })), specOf('too_many_parents'))
    // One of the twelve may still add.
    expect((await add(lot, addBody(twelve[3], twelve))).status).toBe(200)
  })

  it('verdict 10 — amount_too_large: the count past integer, and the weight past numeric(10,3)', async () => {
    const plant = await planting('t4-v10', { variety: fx.v.a2 })
    const count = await armedLot()
    await measure(count, { seed_count: 2147483000 })
    await refused('verdict 10 amount_too_large (count)', count, () => add(count, armedBody(plant, [member], { add_seed_count: 648 })), specOf('amount_too_large'))
    // One fewer fits exactly, and is not refused by the judge. (Sent from the member, with no filing.)
    const fits = await add(count, addBody(member, [member], { add_seed_count: 647, add_estimated: false }))
    expect(fits.status, JSON.stringify(fits.body)).toBe(200)
    expect(fits.body.seed_count).toBe(2147483647)
    const weight = await armedLot()
    await directSql`UPDATE inventory_items SET seed_weight_g = 9999999.000 WHERE id = ${weight}`
    await refused('verdict 10 amount_too_large (weight)', weight, () => add(weight, armedBody(plant, [member], { add_seed_weight_g: 1 })), specOf('amount_too_large'))
    const light = await add(weight, addBody(member, [member], { add_seed_weight_g: 0.999 }))
    expect(light.status, JSON.stringify(light.body)).toBe(200)
    expect(light.body.seed_weight_g).toBe('9999999.999')
  })

  it('404 — absent, foreign, soft-deleted and not-seeds lots answer alike, and nothing is written anywhere', async () => {
    const plant = await planting('t4-404', { variety: fx.v.a2 })
    const lot = await armedLot()
    const gone = await armedLot()
    await directSql`UPDATE inventory_items SET deleted_at = now() WHERE id = ${gone}`
    const tool = (await inv('POST', '/api/inventory-items', {
      name: `sla-tool-${RUN}-${seq++}`, type: 'durable', category: 'tools', quantity: 1,
    })).body.id
    setTestUserId(FOREIGN)
    const [theirs] = await directSql`
      INSERT INTO inventory_items (user_id, created_by, name, type, category, unit, quantity_on_hand, variety_id)
      VALUES (${FOREIGN}, ${FOREIGN}, ${`sla-foreign-lot-${RUN}`}, 'consumable', 'seeds', 'packet', 1, ${fx.v.a1})
      RETURNING id`
    const anywhere = await allAdditions()
    for (const [label, target] of [['absent', randomUUID()], ['foreign', theirs.id], ['soft-deleted', gone], ['not seeds', tool]]) {
      // eslint-disable-next-line no-await-in-loop
      const before = target === gone ? await snapshot(gone) : null
      // eslint-disable-next-line no-await-in-loop
      const r = await add(target, armedBody(plant))
      expect(r.status, `${label} -> ${JSON.stringify(r.body)}`).toBe(404)
      expect(r.body, label).toEqual({ error: 'Not found' })
      // eslint-disable-next-line no-await-in-loop
      if (before) expect(await snapshot(gone), label).toBe(before)
      // eslint-disable-next-line no-await-in-loop
      measured(`T4 wrote-nothing | 404 ${label} | HTTP ${r.status} | picking rows anywhere unchanged: ${(await allAdditions()) === anywhere}`)
    }
    expect(await allAdditions()).toBe(anywhere)
    expect((await directSql`SELECT count(*)::int AS n FROM seed_lot_parent_planting WHERE plant_id = ${plant}`)[0].n).toBe(0)
    expect(await links(lot)).toEqual({ live: 1, retired: 0 })
  })

  it('a planting of another household is the gate\'s generic 400, with nothing written and no lot named', async () => {
    const lot = await armedLot()
    const theirs = await planting('t4-foreign', { by: FOREIGN, variety: fx.v.a2 })
    const r = await refused('fast path: foreign plant_id', lot, async () => {
      const warn = console.warn
      console.warn = () => {}
      try { return await add(lot, armedBody(theirs)) } finally { console.warn = warn }
    }, { status: 400, error: 'plant_id does not match a planting you can use' })
    expect(JSON.stringify(r.body)).not.toContain(lot)
  })

  // ── Past the fast path: the row is changed FIRST, and addSeedToLot is called directly ───────────
  const direct = (lot, body) => addSeedToLot(directSql, {
    lotId: lot, householdIds: [USER], userId: USER, additionKey: body.addition_key, plantId: body.plant_id,
    expected: body.expected_source_plant_ids, pickedOn: body.picked_on,
    addCount: body.add_seed_count ?? null, addEstimated: body.add_estimated ?? null, addWeight: body.add_seed_weight_g ?? null,
    filing: body.filing ? { varietyId: body.filing.variety_id, expectVarietyId: body.filing.expect_variety_id, name: body.filing.name ?? null } : null,
  })
  async function refusedDirect(label, lot, body, outcome) {
    const before = await snapshot(lot)
    const out = await direct(lot, body)
    const same = (await snapshot(lot)) === before
    measured(`T4 wrote-nothing | ${label} (addSeedToLot, past the fast path) | outcome ${out.outcome} | lot row, link rows, picking rows before == after: ${same}`)
    expect(out.outcome, `${label} -> ${JSON.stringify(out)}`).toBe(outcome)
    expect(same, `${label}: a refused addition changed something`).toBe(true)
    return out
  }

  it('verdict 6 — plants_changed: the planting was soft-deleted after the route\'s gate would have passed it', async () => {
    const lot = await armedLot()
    const plant = await planting('t4-v6', { variety: fx.v.a2 })
    await directSql`UPDATE plants SET deleted_at = now() WHERE id = ${plant}`
    await refusedDirect('verdict 6 plants_changed', lot, armedBody(plant), 'plants_changed')
    // …and a member whose planting was deleted cannot receive a picking either (the first arm only).
    const lot2 = await armedLot()
    const was = await planting('t4-v6-member')
    expect((await add(lot2, addBody(was, [member]))).status).toBe(200)
    await directSql`UPDATE plants SET deleted_at = now() WHERE id = ${was}`
    await refusedDirect('verdict 6 plants_changed (a member, since deleted)', lot2, addBody(was, [member, was].sort()), 'plants_changed')
  })

  it('rules_changed — the set stopped satisfying the parent rules: another crop', async () => {
    const lot = await armedLot()
    const otherCrop = await planting('t4-rules', { variety: fx.v.b })
    await refusedDirect('rules_changed (mixed crop)', lot, armedBody(otherCrop), 'rules_changed')
    // Through the route the same request is the fast path's 400, and writes nothing either.
    await refused('fast path: mixed_crop_parents', lot, () => add(lot, armedBody(otherCrop)), { status: 400, code: 'mixed_crop_parents' })
    // A second variety with NO filing: the rules ask for the mix.
    const second = await planting('t4-rules-blend', { variety: fx.v.a2 })
    const { filing: _filing, ...noFiling } = armedBody(second)
    await refusedDirect('rules_changed (blend required, no filing)', lot, noFiling, 'rules_changed')
    const r = await refused('fast path: blend_required', lot, () => add(lot, noFiling), { status: 400, code: 'blend_required' })
    expect(r.body.component_variety_ids).toEqual([fx.v.a1, fx.v.a2].sort())
  })

  it('filing lot_changed — the lot was re-filed after the caller read it: 409 with the stored variety and name, and no plants', async () => {
    const lot = await armedLot()
    const plant = await planting('t4-filing', { variety: fx.v.a2 })
    const stale = armedBody(plant, [member], { filing: { variety_id: MIX.pair.id, expect_variety_id: fx.v.a3 } })
    const out = await refusedDirect('filing lot_changed', lot, stale, 'lot_changed')
    const row = await lotRow(lot)
    expect(out).toEqual({ outcome: 'lot_changed', variety_id: fx.v.a1, name: row.name })
    // Through the route: the same, as the filing route answers it.
    const r = await refused('filing lot_changed (route)', lot, () => add(lot, stale), specOf('lot_changed'))
    expect(r.body).toEqual({ error: LOT_CHANGED, code: 'lot_changed', variety_id: fx.v.a1, name: row.name })
    // The other two filing refusals, through the route.
    await refused('filing variety_unusable', lot, () => add(lot, addBody(member, [member], { filing: { variety_id: fx.v.gone, expect_variety_id: fx.v.a1 } })), { status: 400, code: 'variety_unusable' })
    await refused('filing filing_crop_mismatch', lot, () => add(lot, addBody(member, [member], { filing: { variety_id: fx.v.b, expect_variety_id: fx.v.a1 } })), { status: 400, code: 'filing_crop_mismatch' })
  })

  it('every refusal the additions route names in the contract file was driven above, with its status and sentence', () => {
    expect(Object.keys(CONTRACT.seed_additions_post.refusals).sort()).toEqual([
      'addition_key_conflict', 'amount_too_large', 'lot_used_up', 'own_source_lot', 'too_many_parents', 'variety_mismatch_no_parents',
    ])
    expect(CONTRACT.refusals.parents_changed.error).toBe(PLANTS_CHANGED)
    expect(CONTRACT.refusals.lot_changed.error).toBe(LOT_CHANGED)
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// T5 / T6 / T8
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!READY)('T5 — a re-file inside the write', () => {
  it('a one-parent lot + a second cultivar with a filing: the mix, the new name, the link and the picking, in one transaction', async () => {
    const [a1, a2] = [await planting('t5-a1'), await planting('t5-a2', { variety: fx.v.a2 })]
    const lot = await agedLot({ source_plant_ids: [a1] })
    await measure(lot, { seed_count: 100, seed_count_estimated: false })
    const name = `sla mix lot ${RUN} ${seq++}`
    const r = await add(lot, addBody(a2, [a1], {
      add_seed_count: 7, add_estimated: false, filing: { variety_id: MIX.pair.id, expect_variety_id: fx.v.a1, name },
    }))
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const row = await lotRow(lot)
    expect(row).toMatchObject({ variety_id: MIX.pair.id, name, seed_count: 107, source_plant_id: a1 })
    expect(await livePlants(lot)).toEqual([a1, a2].sort())
    const [picking] = await pickings(lot)
    expect(picking).toMatchObject({ plant_id: a2, seed_count: 7, count_applied: true, same_instant_as_link: true })
    // The reply carries the re-filed name and variety (applyAddition runs after fileLot), and `filing`.
    expectReplyIsRow(r.body, row, 'T5')
    expect(r.body.filing).toMatchObject({
      variety_id: MIX.pair.id, variety_rank: 'blend', name, changed: true, previous: { variety_id: fx.v.a1 },
    })
    expect(r.body.source_plants.map((p) => p.id).sort()).toEqual([a1, a2].sort())
    // One transaction: the lot's updated_at, the link's created_at and the picking's are one instant.
    const [t] = await directSql`
      SELECT (SELECT count(DISTINCT x.at) FROM (
                SELECT l.created_at AS at FROM seed_lot_parent_planting l WHERE l.inventory_item_id = ${lot} AND l.plant_id = ${a2}
                UNION ALL SELECT a.created_at FROM seed_lot_addition a WHERE a.id = ${picking.id}
                UNION ALL SELECT i.updated_at FROM inventory_items i WHERE i.id = ${lot}) x)::int AS instants`
    expect(t.instants).toBe(1)
  })

  it('a stale expect_variety_id is 409 and nothing moved', async () => {
    const [a1, a2] = [await planting('t5s-a1'), await planting('t5s-a2', { variety: fx.v.a2 })]
    const lot = await agedLot({ source_plant_ids: [a1] })
    await measure(lot, { seed_count: 100, seed_count_estimated: false })
    const before = await snapshot(lot)
    const r = await add(lot, addBody(a2, [a1], {
      add_seed_count: 7, add_estimated: false, filing: { variety_id: MIX.pair.id, expect_variety_id: fx.v.a2 },
    }))
    expect(r.status, JSON.stringify(r.body)).toBe(409)
    expect(r.body.code).toBe('lot_changed')
    expect(await snapshot(lot)).toBe(before)
    measured(`T5 wrote-nothing | stale expect_variety_id | HTTP ${r.status} ${r.body.code} | before == after: true`)
  })
})

describe.skipIf(!READY)('T6 — the plant count: +1 only for a plant NEW to the lot that stands for one plant', () => {
  let member
  beforeAll(async () => { member = await planting('t6-member') })
  const counted = async (n) => {
    const lot = await agedLot({ source_plant_ids: [member] })
    if (n != null) await measure(lot, { seed_parent_plant_count: n })
    return lot
  }
  const after = async (lot) => (await lotRow(lot)).seed_parent_plant_count

  it('count set, plant new, quantity 1: +1', async () => {
    const lot = await counted(3)
    const r = await add(lot, addBody(await planting('t6-new'), [member]))
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(await after(lot)).toBe(4)
    expect(r.body.seed_parent_plant_count).toBe(4)
    measured('T6 | count 3, plant new, quantity 1 -> 4')
  })

  it('a plant already in the lot: unchanged', async () => {
    const lot = await counted(3)
    expect((await add(lot, addBody(member, [member]))).status).toBe(200)
    expect(await after(lot)).toBe(3)
    measured('T6 | count 3, member -> 3')
  })

  it('a planting that stands for two plants: unchanged', async () => {
    const lot = await counted(3)
    expect((await add(lot, addBody(await planting('t6-two', { quantity: 2 }), [member]))).status).toBe(200)
    expect(await after(lot)).toBe(3)
    expect(await links(lot)).toEqual({ live: 2, retired: 0 })
    measured('T6 | count 3, plant new, quantity 2 -> 3')
  })

  it('a lot with no plant count: stays NULL', async () => {
    const lot = await counted(null)
    expect((await add(lot, addBody(await planting('t6-null'), [member]))).status).toBe(200)
    expect(await after(lot)).toBeNull()
    measured('T6 | count NULL, plant new, quantity 1 -> NULL')
  })

  it('9999: stays 9999', async () => {
    const lot = await counted(9999)
    expect((await add(lot, addBody(await planting('t6-cap'), [member]))).status).toBe(200)
    expect(await after(lot)).toBe(9999)
    measured('T6 | count 9999, plant new, quantity 1 -> 9999')
  })

  it('remove the plant and add it again: +1 again (accepted)', async () => {
    const lot = await counted(3)
    const plant = await planting('t6-again')
    expect((await add(lot, addBody(plant, [member]))).status).toBe(200)
    expect(await after(lot)).toBe(4)
    const off = await inv('PUT', `/api/inventory-items/${lot}/source-plants`, {
      source_plant_ids: [member], expected_source_plant_ids: [member, plant],
    })
    expect(off.status, JSON.stringify(off.body)).toBe(200)
    const back = await add(lot, addBody(plant, [member]))
    expect(back.status, JSON.stringify(back.body)).toBe(200)
    expect(back.body.addition.plant_was_added).toBe(true)
    expect(await after(lot)).toBe(5)
    expect(await links(lot)).toEqual({ live: 2, retired: 1 })
    measured('T6 | remove then add again -> +1 again (3 -> 4 -> 5)')
  })

  it('"quantity NULL" cannot be built: plants.quantity is NOT NULL, default 1, CHECK >= 1 — the statement reads it IS TRUE all the same', async () => {
    const [col] = await directSql`
      SELECT is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'plants' AND column_name = 'quantity'`
    expect(col).toEqual({ is_nullable: 'NO', column_default: '1' })
    const nullQuantity = await directSql`
      INSERT INTO plants (project_id, name, created_by, variety_id, quantity)
      VALUES (NULL, ${`t6-nullq-sla-${RUN}`}, ${USER}, ${fx.v.a1}, NULL)`.then(() => null, (e) => e)
    expect(nullQuantity?.code).toBe('23502')
    measured(`T6 | quantity NULL: NOT BUILDABLE on this schema (plants.quantity is_nullable=${col.is_nullable}, default ${col.column_default}; INSERT NULL -> ${nullQuantity?.code})`)
  })
})

describe.skipIf(!READY)('T8 — the same plant on a set that would fail today\'s rules for a NEW plant is a 200', () => {
  it('a lot whose parents are already two crops: a picking from one of them goes in', async () => {
    const [a1, b] = [await planting('t8-a1'), await planting('t8-b', { variety: fx.v.b })]
    const lot = await agedLot({ source_plant_ids: [a1] })
    // A set the rules would refuse today, as older data can hold it: the second crop's link is
    // written directly.
    await directSql`
      INSERT INTO seed_lot_parent_planting (inventory_item_id, plant_id, role, created_by)
      VALUES (${lot}, ${b}, 'seed_parent', ${USER})`
    await measure(lot, { seed_count: 10, seed_count_estimated: false })
    // A NEW plant on that set is refused…
    const fresh = await add(lot, addBody(await planting('t8-new'), [a1, b].sort()))
    expect(fresh.status).toBe(400)
    expect(fresh.body.code).toBe('mixed_crop_parents')
    // …and the plant that is already there is not.
    const r = await add(lot, addBody(a1, [a1, b].sort(), { add_seed_count: 3, add_estimated: false }))
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.seed_count).toBe(13)
    expect(r.body.addition).toMatchObject({ replayed: false, plant_was_added: false, count_applied: true })
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// T7 / T7b — two at once
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!READY)('T7 — two additions at once', () => {
  it('two DIFFERENT keys, ten rounds: both 200, the total is base + a + b, two picking rows a round', { timeout: 120000 }, async () => {
    const [p1, p2] = [await planting('t7-p1'), await planting('t7-p2')]
    const lot = await agedLot({ source_plant_ids: [p1, p2] })
    const set = [p1, p2].sort()
    await measure(lot, { seed_count: 1000, seed_count_estimated: false, seed_weight_g: 10 })
    let total = 1000
    for (let round = 0; round < 10; round += 1) {
      const [a, b] = [round + 1, 100 + round]
      // Each on a connection of its own, so the two really are in flight together.
      // eslint-disable-next-line no-await-in-loop
      const [ra, rb] = await Promise.all([
        onOwnConnection(() => add(lot, addBody(p1, set, { add_seed_count: a, add_estimated: false, add_seed_weight_g: 0.5 }))),
        onOwnConnection(() => add(lot, addBody(p2, set, { add_seed_count: b, add_estimated: false }))),
      ])
      expect(ra.status, `round ${round}: ${JSON.stringify(ra.body)}`).toBe(200)
      expect(rb.status, `round ${round}: ${JSON.stringify(rb.body)}`).toBe(200)
      total += a + b
      // eslint-disable-next-line no-await-in-loop
      const row = await lotRow(lot)
      expect(row.seed_count, `round ${round}`).toBe(total)
      // eslint-disable-next-line no-await-in-loop
      expect(await pickings(lot), `round ${round}`).toHaveLength(2 * (round + 1))
      // Whichever landed second saw the first: its reply is the running total.
      expect(Math.max(ra.body.seed_count, rb.body.seed_count), `round ${round}`).toBe(total)
    }
    const row = await lotRow(lot)
    expect(row.seed_weight_g).toBe('15.000')
    measured(`T7 | 10 rounds, two different keys at once: every reply 200, final count ${row.seed_count} = 1000 + sum(a) + sum(b) = ${total}, picking rows ${(await pickings(lot)).length}`)
  })

  it('the SAME key twice at once, ten rounds: both 2xx, one addition.id, exactly one replayed false, one picking row, the amount raised once', { timeout: 120000 }, async () => {
    const [member, fresh] = [await planting('t7b-member'), null]
    const lot = await agedLot({ source_plant_ids: [member] })
    await measure(lot, { seed_count: 500, seed_count_estimated: false, seed_parent_plant_count: 1 })
    let total = 500
    let set = [member]
    const firsts = []
    for (let round = 0; round < 10; round += 1) {
      // Odd rounds send a NEW plant, so the link INSERT is in the race as well.
      // eslint-disable-next-line no-await-in-loop
      const plant = round % 2 ? await planting(`t7b-new-${round}`) : member
      const body = addBody(plant, set, { add_seed_count: round + 1, add_estimated: false })
      // eslint-disable-next-line no-await-in-loop
      const [ra, rb] = await Promise.all([
        onOwnConnection(() => add(lot, body)),
        onOwnConnection(() => add(lot, body)),
      ])
      expect(ra.status, `round ${round}: ${JSON.stringify(ra.body)}`).toBe(200)
      expect(rb.status, `round ${round}: ${JSON.stringify(rb.body)}`).toBe(200)
      expect(ra.body.addition.id, `round ${round}`).toBe(rb.body.addition.id)
      expect([ra.body.addition.replayed, rb.body.addition.replayed].sort(), `round ${round}`).toEqual([false, true])
      expect(ra.body.addition.plant_was_added).toBe(plant !== member)
      expect(rb.body.addition.plant_was_added).toBe(plant !== member)
      firsts.push(ra.body.addition.replayed ? 'second' : 'first')
      total += round + 1
      if (plant !== member) set = [...set, plant].sort()
      // eslint-disable-next-line no-await-in-loop
      expect((await lotRow(lot)).seed_count, `round ${round}`).toBe(total)
      // eslint-disable-next-line no-await-in-loop
      expect(await pickings(lot), `round ${round}`).toHaveLength(round + 1)
      // eslint-disable-next-line no-await-in-loop
      expect(await livePlants(lot), `round ${round}`).toEqual(set)
    }
    const row = await lotRow(lot)
    // Five new one-plant plantings joined, once each.
    expect(row.seed_parent_plant_count).toBe(6)
    expect(await links(lot)).toEqual({ live: 6, retired: 0 })
    expect(fresh).toBeNull()
    measured(`T7b | 10 rounds, the same key twice at once: every reply 200, one addition.id a round, exactly one replayed:false a round, final count ${row.seed_count} = ${total}, picking rows ${(await pickings(lot)).length}, plant count ${row.seed_parent_plant_count}; which request won: ${firsts.join(',')}`)
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// T9 — a planting merge after pickings
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!READY)('T9 — a planting merge is not blocked by the picking table, and pickings resolve to the winner', () => {
  const merge = (winner, losers) => {
    setTestUserId(USER)
    return callHandler(plantsHandler, {
      method: 'POST', path: `/api/plants/${winner}/merge`, body: { loser_ids: losers, op_id: randomUUID() },
    })
  }

  it('the loser was the lot\'s only parent: its link row moves to the winner, and the picking with it', async () => {
    const [winner, loser] = [await planting('t9-winner'), await planting('t9-loser')]
    const lot = await agedLot({ source_plant_ids: [loser] })
    await measure(lot, { seed_count: 10, seed_count_estimated: false })
    const body = addBody(loser, [loser], { add_seed_count: 5, add_estimated: false })
    expect((await add(lot, body)).status).toBe(200)
    const m = await merge(winner, [loser])
    expect(m.status, `merge -> ${JSON.stringify(m.body)}`).toBeLessThan(300)
    expect(await pickings(lot)).toMatchObject([{ plant_id: winner, inventory_item_id: lot, link_live: true, seed_count: 5 }])
    expect(await livePlants(lot)).toEqual([winner])
    // The same request again is still a replay: the key is found through its link row, not the plant.
    const replay = await add(lot, body)
    expect(replay.status, JSON.stringify(replay.body)).toBe(200)
    expect(replay.body.addition.replayed).toBe(true)
    expect((await lotRow(lot)).seed_count).toBe(15)
    measured(`T9 | merge, loser the only parent: HTTP ${m.status}; picking -> link -> plant = winner on the same lot, link live; replay after merge 200 replayed`)
  })

  it('winner and loser were BOTH parents: the loser\'s link row is retired onto the winner, its pickings stay on (lot, winner), and the merge is not blocked', async () => {
    const [winner, loser] = [await planting('t9b-winner'), await planting('t9b-loser')]
    const lot = await agedLot({ source_plant_ids: [winner, loser] })
    const set = [winner, loser].sort()
    await measure(lot, { seed_count: 10, seed_count_estimated: false })
    const onLoser = addBody(loser, set, { add_seed_count: 5, add_estimated: false })
    expect((await add(lot, onLoser)).status).toBe(200)
    expect((await add(lot, addBody(winner, set, { add_seed_count: 2, add_estimated: false }))).status).toBe(200)
    const m = await merge(winner, [loser])
    expect(m.status, `merge -> ${JSON.stringify(m.body)}`).toBeLessThan(300)
    const rows = await pickings(lot)
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row).toMatchObject({ plant_id: winner, inventory_item_id: lot })
    expect(rows.map((r) => r.link_live).sort()).toEqual([false, true])
    expect(await livePlants(lot)).toEqual([winner])
    expect((await lotRow(lot)).seed_count).toBe(17)
    // The loser's request, sent again: a replay, found on a link row that is no longer live.
    const replay = await add(lot, onLoser)
    expect(replay.status, JSON.stringify(replay.body)).toBe(200)
    expect(replay.body.addition.replayed).toBe(true)
    expect(await pickings(lot)).toHaveLength(2)
    measured(`T9 | merge, both parents on the lot: HTTP ${m.status}; both pickings resolve to (lot, winner), link live ${rows.map((r) => r.link_live).sort().join('/')}; replay of the loser's key 200 replayed`)
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// T25 — /seed-measure compare-and-set
// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!READY)('T25 — PUT /seed-measure can no longer write a stale count over a picking', () => {
  const put = (lot, body) => inv('PUT', `/api/inventory-items/${lot}/seed-measure`, body)
  const measureOf = async (lot) => pickOf(await lotRow(lot), ['seed_count', 'seed_count_estimated', 'seed_weight_g', 'seed_parent_plant_count'])
  let plant
  beforeAll(async () => { plant = await planting('t25') })
  const countedLot = async (n = 100) => {
    const lot = await agedLot({ source_plant_ids: [plant] })
    await measure(lot, { seed_count: n, seed_count_estimated: false, seed_weight_g: 12.345, seed_parent_plant_count: 2 })
    return lot
  }

  it('count n, a picking of +a, then a PUT that expected n: 409, and the lot still says n + a', async () => {
    const lot = await countedLot(100)
    expect((await add(lot, addBody(plant, [plant], { add_seed_count: 7, add_estimated: false }))).status).toBe(200)
    const before = await lotRow(lot)
    const r = await put(lot, { seed_count: 120, seed_count_estimated: false, expected_seed_count: 100 })
    expect(r.status, JSON.stringify(r.body)).toBe(409)
    expect(r.body).toEqual({
      error: LOT_CHANGED, code: 'lot_changed', seed_count: 107, seed_count_estimated: false, seed_weight_g: '12.345', seed_parent_plant_count: 2,
    })
    expect(await lotRow(lot), 'a refused measure moved the row (updated_at included)').toEqual(before)
    // With what the lot holds now — the 409's own body — the same write goes through.
    const ok = await put(lot, { seed_count: 120, seed_count_estimated: false, expected_seed_count: r.body.seed_count })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(Object.keys(ok.body).sort()).toEqual(['id', 'seed_count', 'seed_count_estimated', 'seed_parent_plant_count', 'seed_weight_g'])
    expect((await lotRow(lot)).seed_count).toBe(120)
    measured('T25 | count 100, picking +7, PUT expected 100 -> 409 and the lot still 107; PUT expected 107 -> 200')
  })

  it('NO expected key is today\'s behaviour: the write goes through whatever the lot holds', async () => {
    const lot = await countedLot(100)
    expect((await add(lot, addBody(plant, [plant], { add_seed_count: 7, add_estimated: false }))).status).toBe(200)
    const r = await put(lot, { seed_count: 50, seed_count_estimated: true })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(await measureOf(lot)).toEqual({ seed_count: 50, seed_count_estimated: true, seed_weight_g: '12.345', seed_parent_plant_count: 2 })
  })

  it('null means "I loaded no value": 200 on an uncounted lot, 409 once it has been counted', async () => {
    const lot = await agedLot({ source_plant_ids: [plant] })
    const first = await put(lot, { seed_count: 30, seed_count_estimated: true, expected_seed_count: null, expected_seed_count_estimated: null, expected_seed_weight_g: null })
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    const again = await put(lot, { seed_count: 31, seed_count_estimated: true, expected_seed_count: null })
    expect(again.status).toBe(409)
    expect(again.body.seed_count).toBe(30)
    expect((await lotRow(lot)).seed_count).toBe(30)
  })

  it('a missing lot with the keys is 404, as it is without them', async () => {
    const r = await put(randomUUID(), { seed_weight_g: 1, expected_seed_weight_g: null })
    expect(r.status).toBe(404)
    expect(r.body).toEqual({ error: 'Not found' })
    const foreign = await put((await countedLot()), { seed_weight_g: 1, expected_seed_weight_g: 12.345 })
    expect(foreign.status).toBe(200)
    setTestUserId(FOREIGN)
    const lot = await countedLot()
    const theirs = await inv('PUT', `/api/inventory-items/${lot}/seed-measure`, { seed_weight_g: 1, expected_seed_weight_g: 12.345 }, FOREIGN)
    expect(theirs.status).toBe(404)
    expect((await lotRow(lot)).seed_weight_g).toBe('12.345')
  })

  it('the BASIS-ONLY flip: a blank picking on a counted lot, then the stale stage-sheet body — 409, and the basis is still true', async () => {
    const lot = await countedLot(100)
    // Nothing typed: the count stays 100 and its basis becomes "estimated".
    expect((await add(lot, addBody(plant, [plant]))).status).toBe(200)
    expect(await measureOf(lot)).toMatchObject({ seed_count: 100, seed_count_estimated: true })
    const before = await lotRow(lot)
    // The sheet opened before the picking: it loaded 100 / counted, and writes that back.
    const stale = await put(lot, { seed_count: 100, seed_count_estimated: false, expected_seed_count: 100, expected_seed_count_estimated: false })
    expect(stale.status, JSON.stringify(stale.body)).toBe(409)
    expect(stale.body).toMatchObject({ code: 'lot_changed', seed_count: 100, seed_count_estimated: true })
    expect(await lotRow(lot)).toEqual(before)
    // Comparing the count ALONE would have let it through — which is why the basis is a key of its own.
    const countOnly = await put(lot, { seed_count: 100, seed_count_estimated: false, expected_seed_count: 100 })
    expect(countOnly.status).toBe(200)
    expect((await lotRow(lot)).seed_count_estimated).toBe(false)
    measured('T25 | basis-only flip: blank picking on 100/counted -> 100/estimated; stale body (expected 100, false) -> 409, basis still true')
  })

  it('the weight is compared as a number: 12.35 is the stored 12.350, and a picking\'s weight makes it stale', async () => {
    const lot = await countedLot(100)
    await measure(lot, { seed_weight_g: 12.35 })
    const same = await put(lot, { seed_weight_g: 13, expected_seed_weight_g: 12.35 })
    expect(same.status, JSON.stringify(same.body)).toBe(200)
    expect((await add(lot, addBody(plant, [plant], { add_seed_weight_g: 0.5 }))).status).toBe(200)
    const stale = await put(lot, { seed_weight_g: 20, expected_seed_weight_g: 13 })
    expect(stale.status).toBe(409)
    expect(stale.body.seed_weight_g).toBe('13.500')
    expect((await lotRow(lot)).seed_weight_g).toBe('13.500')
    // The 409's own value, as a client reads it (Number of the driver's string), is current.
    const ok = await put(lot, { seed_weight_g: 20, expected_seed_weight_g: Number(stale.body.seed_weight_g) })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  })

  it('a wrong type for an expected key is a 400 and writes nothing', async () => {
    const lot = await countedLot(100)
    const before = await lotRow(lot)
    const r = await put(lot, { seed_weight_g: 20, expected_seed_weight_g: '12.345' })
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error: 'expected_seed_weight_g must be a number of grams, or null' })
    expect(await lotRow(lot)).toEqual(before)
  })
})
