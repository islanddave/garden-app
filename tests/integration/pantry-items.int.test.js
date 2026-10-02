// Put-Up release 2 (B′) — the Pantry list and pantry items on real Postgres (the train's 1b + F + 2 schema):
// GET /api/pantry, POST / PATCH / DELETE /api/pantry/items[/:id], a batch line that names a pantry item, and
// the planting merge repointing pantry_item.plant_id. DAVE + JEN one household, STRANGER outside, per route
// (V4 §5.3: "proven by execution per route"). Fixtures are _kitchenF.js's; this file tears its own items and
// lines down first (they name places and plantings the household teardown removes).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { directSql, callHandler, setTestUserId, insertProject } from './_harness.js'
import { assertFixtureId, settle } from './_cleanup.js'
import {
  makeHousehold, teardownHousehold, call, key, seedBatch, seedJar, seedPlace, seedPlanting, CROP,
} from './_kitchenF.js'
import { handler as plantsHandler } from '../../lambda/plants/index.js'

const H = makeHousehold('pantry-items')
const { DAVE, JEN, STRANGER } = H
// useHousehold's shape, with this file's own rows first: a line names its item and an item names its place
// and planting, all NO ACTION / SET NULL, so lines → items go before the household teardown (which removes
// places and plantings). One afterAll, so the order does not depend on the runner's hook order.
let savedIds
beforeAll(() => { savedIds = process.env.GARDEN_HOUSEHOLD_IDS; process.env.GARDEN_HOUSEHOLD_IDS = `${DAVE},${JEN}` })
afterAll(async () => {
  if (savedIds === undefined) delete process.env.GARDEN_HOUSEHOLD_IDS; else process.env.GARDEN_HOUSEHOLD_IDS = savedIds
  const ids = assertFixtureId(DAVE, JEN, STRANGER)
  await settle(`pantry-items teardown ${H.RUN}`, [
    () => directSql`DELETE FROM kitchen_batch_input WHERE pantry_item_id IN (SELECT id FROM pantry_item WHERE user_id = ANY(${ids}))`,
    () => directSql`DELETE FROM pantry_item WHERE user_id = ANY(${ids})`,
  ])
  await teardownHousehold(H)
})

const create = (user, body) => call(user, 'POST', '/api/pantry/items', { idempotency_key: key(), ...body })
const itemPath = (id) => `/api/pantry/items/${id}`
const readItem = async (id) => (await directSql`SELECT * FROM pantry_item WHERE id = ${id}`)[0]
const rowsOf = async (user, qs = '') => (await call(user, 'GET', `/api/pantry${qs}`)).body.rows

describe('POST /api/pantry/items', () => {
  it('DAVE creates at a known place: 201 {item}; the row is Dave\'s, keyed, with the day\'s precision', async () => {
    const place = await seedPlace(DAVE, { kind: 'pantry' })
    const k = key()
    const r = await call(DAVE, 'POST', '/api/pantry/items', { idempotency_key: k, name: ' Arborio rice ', storage_location_id: place, acquired_at: '2026-10-03' })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.item).toMatchObject({ name: 'Arborio rice', storage_location_id: place, acquired_at: '2026-10-03', acquired_precision: 'day', used_up_at: null })
    const row = await readItem(r.body.item.id)
    expect(row.user_id).toBe(DAVE)
    expect(row.idempotency_key).toBe(k)
    // replay: same key → 200 replayed, one row
    const again = await call(DAVE, 'POST', '/api/pantry/items', { idempotency_key: k, name: 'Arborio rice', storage_location_id: place })
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ replayed: true, item: { id: r.body.item.id } })
    expect((await directSql`SELECT count(*)::int AS n FROM pantry_item WHERE idempotency_key = ${k}`)[0].n).toBe(1)
    // the key outside the household → 409 key_conflict, no payload
    const foreign = await call(STRANGER, 'POST', '/api/pantry/items', { idempotency_key: k, name: 'x', place: { kind: 'pantry', label: `str ${H.RUN}` } })
    expect(foreign.status).toBe(409)
    expect(foreign.body.code).toBe('key_conflict')
    expect(foreign.body.item).toBeUndefined()
  })

  it('JEN creates at a new place by {kind, label}; DAVE naming the same place (other case) lands on it', async () => {
    const label = `pantry cellar ${H.RUN}`
    const j = await create(JEN, { name: 'Onions', place: { kind: 'cold_storage', label: ` ${label} ` } })
    expect(j.status, JSON.stringify(j.body)).toBe(201)
    expect(j.body.item.place).toMatchObject({ label, kind: 'cold_storage' })
    const d = await create(DAVE, { name: 'Shallots', place: { kind: 'cold_storage', label: label.toUpperCase() } })
    expect(d.status).toBe(201)
    expect(d.body.item.storage_location_id).toBe(j.body.item.storage_location_id)
  })

  it('a planting hit keeps the planting and its crop; STRANGER\'s place or planting → 400, nothing written', async () => {
    const place = await seedPlace(DAVE, { kind: 'cold_storage' })
    const { plantId } = await seedPlanting(DAVE, { name: 'pantry walla' })
    const r = await create(JEN, { name: 'Walla Walla, fresh', storage_location_id: place, plant_id: plantId, crop_type_slug: CROP })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.item).toMatchObject({ plant_id: plantId, crop_type_slug: CROP })
    const before = (await directSql`SELECT count(*)::int AS n FROM pantry_item WHERE user_id = ${STRANGER}`)[0].n
    expect((await create(STRANGER, { name: 'x', storage_location_id: place })).status).toBe(400)
    const strangerPlace = await seedPlace(STRANGER, { kind: 'pantry' })
    expect((await create(STRANGER, { name: 'x', storage_location_id: strangerPlace, plant_id: plantId })).status).toBe(400)
    expect((await directSql`SELECT count(*)::int AS n FROM pantry_item WHERE user_id = ${STRANGER}`)[0].n).toBe(before)
  })

  it('the DB refuses what the route would: a blank name, a date with "unknown", a crop that does not exist', async () => {
    const place = await seedPlace(DAVE, { kind: 'pantry' })
    expect((await create(DAVE, { name: '  ', storage_location_id: place })).status).toBe(400)
    expect((await create(DAVE, { name: 'x', storage_location_id: place, acquired_at: '2026-10-01', acquired_precision: 'unknown' })).status).toBe(400)
    const bad = await create(DAVE, { name: 'x', storage_location_id: place, crop_type_slug: `no-such-crop-${H.RUN}` })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/crop/)
  })
})

describe('PATCH / DELETE /api/pantry/items/:id', () => {
  it('presence-sentinel edit by JEN on Dave\'s item; Used it up and its Undo; Move; STRANGER → 404', async () => {
    const place = await seedPlace(DAVE, { kind: 'pantry' })
    const fridge = await seedPlace(JEN, { kind: 'fridge' })
    const { body } = await create(DAVE, { name: 'Tahini', storage_location_id: place, notes: 'opened' })
    const id = body.item.id
    const p = await call(JEN, 'PATCH', itemPath(id), { use_by_target: '2027-01-15', acquired_at: '2026-09-01', acquired_precision: 'month' })
    expect(p.status, JSON.stringify(p.body)).toBe(200)
    expect(p.body.item).toMatchObject({ name: 'Tahini', notes: 'opened', use_by_target: '2027-01-15', acquired_precision: 'month' })
    const used = await call(DAVE, 'PATCH', itemPath(id), { used_up_at: 'now' })
    expect(used.body.item.used_up_at).not.toBeNull()
    expect((await rowsOf(JEN)).some((r) => r.stock_id === id)).toBe(false)   // a used-up item is off the list
    const stamp = (await readItem(id)).used_up_at
    await call(DAVE, 'PATCH', itemPath(id), { used_up_at: 'now' })            // a retried tap keeps the stamp
    expect((await readItem(id)).used_up_at).toEqual(stamp)
    const undo = await call(DAVE, 'PATCH', itemPath(id), { used_up_at: null })
    expect(undo.body.item.used_up_at).toBeNull()
    const moved = await call(DAVE, 'PATCH', itemPath(id), { storage_location_id: fridge })
    expect(moved.body.item.place).toMatchObject({ id: fridge, kind: 'fridge' })
    expect((await call(STRANGER, 'PATCH', itemPath(id), { notes: 'mine now' })).status).toBe(404)
    expect((await readItem(id)).notes).toBe('opened')
    // the owner never changes, whoever edits (the user_id guard)
    expect((await readItem(id)).user_id).toBe(DAVE)
  })

  it('DELETE is soft: 200, then 404; the row stays with deleted_at; STRANGER → 404', async () => {
    const place = await seedPlace(DAVE, { kind: 'pantry' })
    const { body } = await create(JEN, { name: 'Capers', storage_location_id: place })
    expect((await call(STRANGER, 'DELETE', itemPath(body.item.id))).status).toBe(404)
    expect((await call(DAVE, 'DELETE', itemPath(body.item.id))).status).toBe(200)
    expect((await call(DAVE, 'DELETE', itemPath(body.item.id))).status).toBe(404)
    expect((await readItem(body.item.id)).deleted_at).not.toBeNull()
    expect((await call(DAVE, 'PATCH', itemPath(body.item.id), { notes: 'x' })).status).toBe(404)
  })
})

describe('GET /api/pantry', () => {
  it('put-ups ∪ items for the household; used-up, removed and empty rows excluded; STRANGER sees none of it', async () => {
    const place = await seedPlace(DAVE, { kind: 'deep_freezer' })
    const counted = await seedJar(DAVE, { count: 3, remaining: 2 })
    await directSql`UPDATE preservation_log SET storage_location_id = ${place}, label = ${`pantry sauce ${H.RUN}`} WHERE id = ${counted}`
    const bag = await seedJar(JEN, { weighed: true, remainingAmount: 60 })
    const empty = await seedJar(DAVE, { count: 2, remaining: 0 })
    const gone = await seedJar(DAVE, { deleted: true })
    const { body } = await create(JEN, { name: `pantry peas ${H.RUN}`, storage_location_id: place })
    const rows = await rowsOf(DAVE)
    const ids = rows.map((r) => r.stock_id)
    expect(ids).toEqual(expect.arrayContaining([counted, bag, body.item.id]))
    expect(ids).not.toContain(empty)
    expect(ids).not.toContain(gone)
    expect(rows.find((r) => r.stock_id === counted)).toMatchObject({
      stock_kind: 'put_up', stock_mode: 'counted', count_left: 2, count_made: 3, grams_left: null,
      place: { id: place, kind: 'deep_freezer' }, created_by: DAVE,
    })
    expect(rows.find((r) => r.stock_id === bag)).toMatchObject({ stock_mode: 'weighed', grams_left: 60, count_left: null })
    expect(rows.find((r) => r.stock_id === body.item.id)).toMatchObject({
      stock_kind: 'pantry_item', stock_mode: 'item', discard: { date: null, basis: null, status: null }, created_by: JEN,
    })
    const strangerIds = (await rowsOf(STRANGER)).map((r) => r.stock_id)
    expect(strangerIds).not.toContain(counted)
    expect(strangerIds).not.toContain(body.item.id)
  })

  it('group=kind, q (name only) and place_id narrow the list; a bad place_id → 400', async () => {
    const place = await seedPlace(JEN, { kind: 'pantry' })
    const { body } = await create(DAVE, { name: `pantry quinoa ${H.RUN}`, storage_location_id: place })
    let rows = await rowsOf(DAVE, `?q=${encodeURIComponent(`QUINOA ${H.RUN}`)}`)
    expect(rows.map((r) => r.stock_id)).toEqual([body.item.id])
    rows = await rowsOf(DAVE, `?place_id=${place}&group=kind`)
    expect(rows.map((r) => r.stock_id)).toEqual([body.item.id])
    expect(rows[0]).toMatchObject({ group_key: 'other', group_label: 'Other things' })
    expect((await call(DAVE, 'GET', '/api/pantry?place_id=nope')).status).toBe(400)
  })

  it('discard-by: a jar reads its stored date and basis with a status; an item\'s typed date reads basis typed', async () => {
    const jar = await seedJar(DAVE, { count: 2, useByInDays: -3 })
    await directSql`UPDATE preservation_log SET use_by_basis = 'typed' WHERE id = ${jar}`
    const place = await seedPlace(DAVE, { kind: 'pantry' })
    const { body } = await create(DAVE, { name: `pantry crackers ${H.RUN}`, storage_location_id: place, use_by_target: '2099-01-01' })
    const rows = await rowsOf(DAVE)
    expect(rows.find((r) => r.stock_id === jar).discard).toMatchObject({ basis: 'typed', status: 'past' })
    expect(rows.find((r) => r.stock_id === body.item.id).discard).toEqual({ date: '2099-01-01', basis: 'typed', status: 'ok' })
  })
})

describe('a batch line that names a pantry item (POST /api/kitchen-batches/:id/inputs, keyed)', () => {
  it('DAVE adds Jen\'s item: 201, pantry_item_id stored, label from the item, no stock or use written; STRANGER\'s batch → 404', async () => {
    const place = await seedPlace(JEN, { kind: 'pantry' })
    const { body } = await create(JEN, { name: 'Morton pickling salt', storage_location_id: place })
    const b = (await seedBatch(DAVE)).id
    const k = key()
    const r = await call(DAVE, 'POST', `/api/kitchen-batches/${b}/inputs`, { inputs: [{ input_kind: 'pantry', idempotency_key: k, pantry_item_id: body.item.id, qty: 30, qty_unit: 'g', role: 'salt' }] })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const [line] = await directSql`SELECT * FROM kitchen_batch_input WHERE idempotency_key = ${k}`
    expect(line).toMatchObject({ input_kind: 'pantry', pantry_item_id: body.item.id, label: 'Morton pickling salt', created_by: DAVE })
    expect((await directSql`SELECT count(*)::int AS n FROM pantry_use WHERE kitchen_batch_input_id = ${line.id}`)[0].n).toBe(0)
    expect(r.body.inputs[0].pantry_item_id).toBe(body.item.id)
    const stranger = await call(STRANGER, 'POST', `/api/kitchen-batches/${b}/inputs`, { inputs: [{ input_kind: 'pantry', idempotency_key: key(), pantry_item_id: body.item.id }] })
    expect(stranger.status).toBe(404)
  })

  it('a stranger\'s item on Dave\'s batch → 400; a removed item → 409 item_removed; the DB CHECK refuses an item on a non-pantry line', async () => {
    const strangerPlace = await seedPlace(STRANGER, { kind: 'pantry' })
    const s = await create(STRANGER, { name: 'not yours', storage_location_id: strangerPlace })
    const b = (await seedBatch(DAVE)).id
    const foreign = await call(DAVE, 'POST', `/api/kitchen-batches/${b}/inputs`, { inputs: [{ input_kind: 'pantry', idempotency_key: key(), pantry_item_id: s.body.item.id }] })
    expect(foreign.status).toBe(400)
    const place = await seedPlace(DAVE, { kind: 'pantry' })
    const { body } = await create(DAVE, { name: 'gone soon', storage_location_id: place })
    await call(DAVE, 'DELETE', itemPath(body.item.id))
    const removed = await call(DAVE, 'POST', `/api/kitchen-batches/${b}/inputs`, { inputs: [{ input_kind: 'pantry', idempotency_key: key(), pantry_item_id: body.item.id }] })
    expect(removed.status).toBe(409)
    expect(removed.body.code).toBe('item_removed')
    let code = null
    try {
      await directSql`INSERT INTO kitchen_batch_input (batch_id, input_kind, label, pantry_item_id, created_by) VALUES (${b}, 'other', 'x', ${body.item.id}, ${DAVE})`
    } catch (e) { code = e.code ?? e.sourceError?.code }
    expect(code).toBe('23514')
  })
})

// ── R2a (V5-PUTUPLOGRETIRE-001, contract 5; migrations/v5-pantryitemamount-001) ─────────────────────────
// An item's amount (as logged — nothing decrements it) and where it came from, on real Postgres: the six
// column lists of pantryRoutes.js and the nine CHECKs. The unit mock runs no SQL, so a column missing from
// the INSERT, a RETURNING or the list SELECT is found HERE or on staging.
describe('R2a — an item\'s amount and where-from', () => {
  const FOUR = ['quantity_value', 'quantity_unit', 'source_kind', 'source_label']
  const four = (o) => FOUR.map((k) => o[k])
  // The driver hands numeric back as text; the row is read as stored.
  const storedFour = async (id) => {
    const row = await readItem(id)
    return [row.quantity_value == null ? null : String(row.quantity_value), row.quantity_unit, row.source_kind, row.source_label]
  }

  it('DAVE creates with all four: 201, stored as sent with the amount rounded to two places; the replay returns them', async () => {
    const place = await seedPlace(DAVE, { kind: 'pantry' })
    const k = key()
    const body = { idempotency_key: k, name: `r2a rice ${H.RUN}`, storage_location_id: place, quantity_value: 2.345, quantity_unit: 'lb', source_kind: 'store', source_label: ' Costco ' }
    const r = await call(DAVE, 'POST', '/api/pantry/items', body)
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(four(r.body.item)).toEqual([2.35, 'lb', 'store', 'Costco'])
    expect(typeof r.body.item.quantity_value).toBe('number')
    expect(await storedFour(r.body.item.id)).toEqual(['2.35', 'lb', 'store', 'Costco'])
    const again = await call(DAVE, 'POST', '/api/pantry/items', body)
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ replayed: true, item: { id: r.body.item.id } })
    expect(four(again.body.item)).toEqual([2.35, 'lb', 'store', 'Costco'])
  })

  it('today\'s keys only: all four are stored NULL, and the item answers them as null', async () => {
    const place = await seedPlace(DAVE, { kind: 'pantry' })
    const r = await create(JEN, { name: `r2a capers ${H.RUN}`, storage_location_id: place, notes: 'x' })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(four(r.body.item)).toEqual([null, null, null, null])
    expect(await storedFour(r.body.item.id)).toEqual([null, null, null, null])
  })

  it('a fresh-as-picked item takes our garden beside its planting and stores no name; a non-garden source on it → 400 in words, nothing written', async () => {
    const place = await seedPlace(DAVE, { kind: 'cold_storage' })
    const { plantId } = await seedPlanting(DAVE, { name: 'r2a walla' })
    const r = await create(DAVE, { name: `r2a fresh ${H.RUN}`, storage_location_id: place, plant_id: plantId, quantity_value: 6, quantity_unit: 'count', source_kind: 'own_garden', source_label: 'never stored' })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(four(r.body.item)).toEqual([6, 'count', 'own_garden', null])
    const before = (await directSql`SELECT count(*)::int AS n FROM pantry_item WHERE user_id = ${DAVE}`)[0].n
    const bad = await create(DAVE, { name: `r2a refused ${H.RUN}`, storage_location_id: place, plant_id: plantId, source_kind: 'store' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/one of your plantings/)
    expect((await directSql`SELECT count(*)::int AS n FROM pantry_item WHERE user_id = ${DAVE}`)[0].n).toBe(before)
  })

  it('PATCH each pair by JEN on Dave\'s item: the amount and its clear; the source, garden clears the name, un-choose; one of a pair alone → 400; STRANGER → 404', async () => {
    const place = await seedPlace(DAVE, { kind: 'pantry' })
    const { body } = await create(DAVE, { name: `r2a tahini ${H.RUN}`, storage_location_id: place })
    const id = body.item.id
    let p = await call(JEN, 'PATCH', itemPath(id), { quantity_value: 1.5, quantity_unit: 'qt' })
    expect(p.status, JSON.stringify(p.body)).toBe(200)
    expect(four(p.body.item)).toEqual([1.5, 'qt', null, null])
    p = await call(JEN, 'PATCH', itemPath(id), { source_kind: 'farm_stand', source_label: ' Harris ' })
    expect(four(p.body.item)).toEqual([1.5, 'qt', 'farm_stand', 'Harris'])
    expect(await storedFour(id)).toEqual(['1.50', 'qt', 'farm_stand', 'Harris'])
    p = await call(JEN, 'PATCH', itemPath(id), { source_kind: 'own_garden', source_label: 'Harris' })
    expect(four(p.body.item)).toEqual([1.5, 'qt', 'own_garden', null])
    p = await call(JEN, 'PATCH', itemPath(id), { name: `r2a tahini, opened ${H.RUN}` })
    expect(four(p.body.item)).toEqual([1.5, 'qt', 'own_garden', null])   // an edit naming neither pair leaves both
    p = await call(JEN, 'PATCH', itemPath(id), { quantity_value: null, quantity_unit: null })
    expect(four(p.body.item)).toEqual([null, null, 'own_garden', null])
    p = await call(JEN, 'PATCH', itemPath(id), { source_kind: null, source_label: null })
    expect(four(p.body.item)).toEqual([null, null, null, null])
    expect(await storedFour(id)).toEqual([null, null, null, null])
    expect((await call(JEN, 'PATCH', itemPath(id), { quantity_value: 2 })).status).toBe(400)
    expect((await call(JEN, 'PATCH', itemPath(id), { source_label: 'Costco' })).status).toBe(400)
    expect((await call(STRANGER, 'PATCH', itemPath(id), { quantity_value: 9, quantity_unit: 'lb' })).status).toBe(404)
    expect(await storedFour(id)).toEqual([null, null, null, null])
    expect((await readItem(id)).user_id).toBe(DAVE)
  })

  it('the planting refusal on a PATCH is the database\'s (chk_pantry_item_source_plant), answered in words; the row is unchanged', async () => {
    const place = await seedPlace(DAVE, { kind: 'cold_storage' })
    const { plantId } = await seedPlanting(DAVE, { name: 'r2a patch walla' })
    const { body } = await create(DAVE, { name: `r2a fresh patch ${H.RUN}`, storage_location_id: place, plant_id: plantId })
    const id = body.item.id
    const p = await call(DAVE, 'PATCH', itemPath(id), { source_kind: 'store', source_label: null })
    expect(p.status, JSON.stringify(p.body)).toBe(400)
    expect(p.body.error).toMatch(/one of your plantings/)
    expect(p.body.error).not.toMatch(/chk_|constraint/i)
    expect(await storedFour(id)).toEqual([null, null, null, null])
    // our garden, and an amount, are both allowed on it
    const ok = await call(DAVE, 'PATCH', itemPath(id), { source_kind: 'own_garden', source_label: null, quantity_value: 12, quantity_unit: 'count' })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(four(ok.body.item)).toEqual([12, 'count', 'own_garden', null])
  })

  it('GET /api/pantry carries the four as stored on an item and on a put-up; an amount is never left; where_from and from_garden follow the stored source', async () => {
    const place = await seedPlace(DAVE, { kind: 'pantry' })
    const named = (await create(DAVE, { name: `r2a list rice ${H.RUN}`, storage_location_id: place, quantity_value: 2, quantity_unit: 'lb', source_kind: 'store', source_label: 'Costco' })).body.item.id
    const unnamed = (await create(JEN, { name: `r2a list eggs ${H.RUN}`, storage_location_id: place, source_kind: 'farm_stand' })).body.item.id
    const garden = (await create(JEN, { name: `r2a list squash ${H.RUN}`, storage_location_id: place, source_kind: 'own_garden' })).body.item.id
    const jar = await seedJar(DAVE, { count: 2 })
    const rows = await rowsOf(DAVE)
    expect(rows.find((r) => r.stock_id === named)).toMatchObject({
      stock_kind: 'pantry_item', stock_mode: 'item', count_left: null, count_made: null, grams_left: null,
      quantity_value: 2, quantity_unit: 'lb', source_kind: 'store', source_label: 'Costco', where_from: 'Costco', from_garden: false,
    })
    expect(rows.find((r) => r.stock_id === unnamed)).toMatchObject({ source_kind: 'farm_stand', source_label: null, where_from: 'Farm stand', from_garden: false })
    expect(rows.find((r) => r.stock_id === garden)).toMatchObject({ source_kind: 'own_garden', source_label: null, where_from: 'My garden', from_garden: true })
    const jarRow = rows.find((r) => r.stock_id === jar)
    expect(jarRow.stock_kind).toBe('put_up')
    for (const k of FOUR) expect(jarRow, k).toHaveProperty(k)
    expect(jarRow.quantity_value === null || typeof jarRow.quantity_value === 'number').toBe(true)
  })

  describe('each CHECK of v5-pantryitemamount-001 refuses by name', () => {
    let place
    let plant
    beforeAll(async () => {
      place = await seedPlace(DAVE, { kind: 'pantry' })
      plant = (await seedPlanting(DAVE, { name: 'r2a check walla' })).plantId
    })
    const attempt = async ({ withPlant = false, v = null, u = null, k = null, l = null }) => {
      try {
        await directSql`
          INSERT INTO pantry_item (user_id, name, storage_location_id, plant_id, quantity_value, quantity_unit, source_kind, source_label)
          VALUES (${DAVE}, ${`r2a check ${H.RUN}`}, ${place}, ${withPlant ? plant : null}, ${v}, ${u}, ${k}, ${l})`
        return null
      } catch (e) {
        return { code: e.code ?? e.sourceError?.code, constraint: e.constraint ?? e.sourceError?.constraint }
      }
    }

    it.each([
      ['chk_pantry_item_quantity_pairing', { v: 2 }],
      ['chk_pantry_item_quantity_pairing', { u: 'lb' }],
      ['chk_pantry_item_quantity_value', { v: 0, u: 'lb' }],
      ['chk_pantry_item_quantity_value', { v: 'NaN', u: 'lb' }],
      ['chk_pantry_item_quantity_unit', { v: 2, u: 'lbs' }],
      ['chk_pantry_item_source_kind', { k: 'swap' }],
      ['chk_pantry_item_source_label_len', { k: 'store', l: 'x'.repeat(121) }],
      ['chk_pantry_item_source_label_nonblank', { k: 'store', l: '  ' }],
      ['chk_pantry_item_source_label_kind', { l: 'Costco' }],
      ['chk_pantry_item_source_other', { k: 'other' }],
      ['chk_pantry_item_source_plant', { withPlant: true, k: 'store' }],
    ])('%s refuses %o with a 23514', async (constraint, cols) => {
      expect(await attempt(cols)).toEqual({ code: '23514', constraint })
    })

    it('the rows the deployed writer makes (all four NULL, with and without a planting) and a full row are accepted', async () => {
      expect(await attempt({})).toBeNull()
      expect(await attempt({ withPlant: true })).toBeNull()
      expect(await attempt({ v: 2, u: 'lb', k: 'farm_stand', l: 'Harris' })).toBeNull()
      expect(await attempt({ withPlant: true, v: 6, u: 'count', k: 'own_garden' })).toBeNull()
    })
  })
})

describe('the planting merge repoints pantry_item.plant_id (merge.js SURFACES)', () => {
  it('a "Fresh, as picked" item on a loser planting follows the winner, a removed one too; the snapshot records it', async () => {
    const proj = await insertProject({ name: `pantry-merge-${H.RUN}`, createdBy: DAVE })
    const plant = async (who) => (await directSql`
      INSERT INTO plants (project_id, name, created_by) VALUES (${proj.id}, ${`pantry-merge-${who}-${H.RUN}`}, ${DAVE}) RETURNING id`)[0].id
    const W = await plant('w')
    const L = await plant('l')
    const place = await seedPlace(DAVE, { kind: 'fridge' })
    const live = (await create(DAVE, { name: 'fresh onions', storage_location_id: place, plant_id: L })).body.item.id
    const removed = (await create(JEN, { name: 'fresh shallots', storage_location_id: place, plant_id: L })).body.item.id
    await call(DAVE, 'DELETE', itemPath(removed))
    setTestUserId(DAVE)
    const r = await callHandler(plantsHandler, {
      method: 'POST', path: `/api/plants/${W}/merge`, body: { loser_ids: [L], op_id: randomUUID() }, userId: DAVE,
    })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect((await readItem(live)).plant_id).toBe(W)
    expect((await readItem(removed)).plant_id).toBe(W)
    const [m] = await directSql`SELECT snapshot FROM merge_event WHERE id = ${r.body.merge_event_id}`
    const snap = typeof m.snapshot === 'string' ? JSON.parse(m.snapshot) : m.snapshot
    expect(snap.repoints.filter((x) => x.table === 'pantry_item').map((x) => [String(x.row_id), x.old_value]).sort())
      .toEqual([[live, L], [removed, L]].sort())
  })
})
