// Put-Up R2a (prep) — src/__tests__/helpers/pantryFake.js, the additions every R2a lane is built against:
//   · POST /api/preservation is judged by the Lambda's OWN validateCreate, and a body key that is not a column
//     the create INSERT writes is refused too (validateCreate alone lets a misspelt key through: the server
//     never reads it, and the row is written without it);
//   · POST /api/pantry/items and PATCH /api/pantry/items/:id are judged by validateItemCreate / validateItemPatch;
//   · PUT and DELETE /api/storage-locations/:id answer; the line search answers every arm; the jar GET carries
//     plant_id, source_kind, source_label.
// So a client test cannot be green on a body the server answers 400 to, or on a field the server drops.
// The fake's ids are short words, not uuids; an id it handed out is stood in for (as R1 did for a use), and
// every other rule is applied to the body exactly as it was sent.
// MUTATION: drop the judging of POST /api/preservation from the fake -> every "refuses" row of the first two
// describes reds.
// CI lane: `npm test` plus the TZ re-run. Nothing here reads a clock.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pantryFetch, jarRow, PLACES, JAR_CREATE_COLUMNS } from './helpers/pantryFake.js'
import { validateCreate } from '../../lambda/preservation/jarRules.js'
import { validateItemCreate, validateItemPatch } from '../../lambda/preservation/pantryItems.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const K = '11111111-1111-4222-8333-444444444444'
const send = (f, method, path, body) => f(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })
const refusal = async (p) => { try { await p } catch (e) { return e } return null }

const JAR = { idempotency_key: K, label: 'Peach jam', method: 'jam_preserve', preserved_at: '2026-09-30', preserved_at_precision: 'day',
  preserved_at_approx: false, package_count: 3, storage_location_id: 'loc-1' }
const ITEM = { idempotency_key: K, name: 'Oat milk', storage_location_id: 'loc-3', acquired_at: '2026-09-30', acquired_precision: 'day' }

describe('pantryFake — POST /api/preservation is judged by the Lambda\'s own validateCreate', () => {
  it('answers a body the server accepts exactly as it did before', async () => {
    const f = pantryFetch()
    expect(validateCreate(JAR)).toBeNull()
    expect(await send(f, 'POST', '/api/preservation', JAR)).toEqual({ id: 'jar-new-1', ...JAR, use_by_target: '2027-09-30', use_by_basis: 'table' })
    const full = { ...JAR, quantity_value: 1.5, quantity_unit: 'qt', source_kind: 'farm_stand', source_label: 'Warner Farms', is_raw: true,
      in_oil: true, notes: 'the low-sugar one', use_by_target: null }
    expect(await send(f, 'POST', '/api/preservation', full)).toEqual({ id: 'jar-new-2', ...full, use_by_target: '2027-09-30', use_by_basis: 'table' })
  })

  it.each([
    ['no method', { ...JAR, method: undefined }],
    ['a unit that is not a stored unit (quart)', { ...JAR, quantity_value: 1, quantity_unit: 'quart' }],
    ['half a quantity pair', { ...JAR, quantity_unit: 'qt' }],
    ['a planting with a source that is not the garden', { ...JAR, plant_id: 'pl-1', source_kind: 'farm_stand' }],
    ['Other with no name', { ...JAR, source_kind: 'other' }],
    ['texture on a method that is not dried', { ...JAR, texture: 'snaps' }],
    ['a key that is not a uuid', { ...JAR, idempotency_key: 'key-1' }],
  ])('refuses %s with a 400 carrying the server\'s own sentence', async (_what, body) => {
    const said = validateCreate(JSON.parse(JSON.stringify(body)))
    expect(typeof said).toBe('string')
    const f = pantryFetch()
    const e = await refusal(send(f, 'POST', '/api/preservation', body))
    expect(e?.status).toBe(400)
    expect(e.body).toEqual({ error: said })
    expect(e.message).toBe(said)
  })
})

describe('pantryFake — POST /api/preservation refuses a key the create INSERT does not write', () => {
  it('JAR_CREATE_COLUMNS is the INSERT\'s own column list, read from lambda/preservation/index.js', () => {
    const src = readFileSync(resolve(REPO, 'lambda/preservation/index.js'), 'utf8')
    const starts = [...src.matchAll(/INSERT INTO preservation_log \(/g)]
    expect(starts).toHaveLength(1)
    const at = starts[0].index + starts[0][0].length
    const columns = src.slice(at, src.indexOf(') VALUES (', at)).split(',').map(s => s.trim()).filter(Boolean)
    expect(columns.length).toBeGreaterThan(30)
    expect([...JAR_CREATE_COLUMNS]).toEqual(columns)
  })

  // QA evidence E3: each of these is ACCEPTED by validateCreate (the first assertion), and the server would
  // write the row without the field.
  it.each([
    ['photo_ID'], ['source_lable'], ['is_Raw'], ['inOil'], ['variety_Id'], ['size_value'], ['place'],
  ])('refuses the body key %s, which validateCreate alone lets through', async (key) => {
    const body = { ...JAR, [key]: 'x' }
    expect(validateCreate(body)).toBeNull()
    const f = pantryFetch()
    const e = await refusal(send(f, 'POST', '/api/preservation', body))
    expect(e?.status).toBe(400)
    expect(e.message).toBe(`unknown field(s): ${key}`)
  })

  it('every column the INSERT writes is taken as a key', async () => {
    const f = pantryFetch()
    for (const col of JAR_CREATE_COLUMNS) {
      if (col in JAR) continue
      const e = await refusal(send(f, 'POST', '/api/preservation', { ...JAR, [col]: null }))
      expect(`${col}: ${e?.message ?? 'accepted'}`).toBe(`${col}: accepted`)
    }
  })
})

describe('pantryFake — POST /api/pantry/items is judged by the Lambda\'s own validateItemCreate', () => {
  it('answers a body the server accepts exactly as it did before', async () => {
    const f = pantryFetch()
    expect(await send(f, 'POST', '/api/pantry/items', ITEM)).toEqual({ item: { id: 'item-new-1', ...ITEM } })
    const withPlace = { idempotency_key: K, name: 'Rice', place: { kind: 'pantry', label: 'Pantry shelf' }, acquired_precision: 'unknown' }
    expect(await send(f, 'POST', '/api/pantry/items', withPlace)).toEqual({ item: { id: 'item-new-2', ...withPlace } })
  })

  it('an id the fake handed out is judged as a well-formed id: a place id and a planting id', async () => {
    const f = pantryFetch()
    expect(validateItemCreate(ITEM)).toBe('storage_location_id must be a uuid')
    expect(await send(f, 'POST', '/api/pantry/items', { ...ITEM, storage_location_id: PLACES[2].id, plant_id: 'pl-9' }))
      .toMatchObject({ item: { storage_location_id: 'loc-3', plant_id: 'pl-9' } })
  })

  it.each([
    ['a misspelt key', { ...ITEM, nmae: 'Oat milk' }, 'unknown field(s): nmae'],
    ['a put-up-only key', { ...ITEM, package_count: 2 }, 'unknown field(s): package_count'],
    ['no name', { ...ITEM, name: '  ' }, 'name what it is'],
    ['a place id and a new place together', { ...ITEM, place: { kind: 'fridge', label: 'Fridge' } }, 'say where it lives: storage_location_id or place {kind, label}, one of them'],
    ['a kind of place that is not one', { ...ITEM, storage_location_id: undefined, place: { kind: 'garage', label: 'Garage' } }, null],
    ['a day with the precision "unknown"', { ...ITEM, acquired_precision: 'unknown' }, "'unknown' means there is no date — send no acquired_at with it"],
    ['a key that is not a uuid', { ...ITEM, idempotency_key: 'key-1' }, 'idempotency_key must be a uuid'],
  ])('refuses %s with a 400 carrying the server\'s own sentence', async (_what, body, sentence) => {
    const f = pantryFetch()
    const e = await refusal(send(f, 'POST', '/api/pantry/items', body))
    expect(e?.status).toBe(400)
    if (sentence) expect(e.message).toBe(sentence)
    else expect(e.message).toMatch(/^place\.kind must be one of: /)
    expect(e.body).toEqual({ error: e.message })
  })
})

describe('pantryFake — PATCH /api/pantry/items/:id is judged by the Lambda\'s own validateItemPatch', () => {
  it('answers a body the server accepts exactly as it did before', async () => {
    const f = pantryFetch()
    expect(await send(f, 'PATCH', '/api/pantry/items/item-1', { name: 'Oat milk, barista' })).toEqual({ item: { id: 'item-1', name: 'Oat milk, barista' } })
    expect(await send(f, 'PATCH', '/api/pantry/items/item-1', { used_up_at: 'now' })).toEqual({ item: { id: 'item-1', used_up_at: 'now' } })
    expect(validateItemPatch({ storage_location_id: 'loc-2' })).not.toBeNull()
    expect(await send(f, 'PATCH', '/api/pantry/items/item-1', { storage_location_id: 'loc-2' })).toEqual({ item: { id: 'item-1', storage_location_id: 'loc-2' } })
  })

  it.each([
    ['a key the PATCH does not take', { stock_mode: 'counted' }, 'these cannot be changed here: stock_mode'],
    ['nothing at all', {}, 'nothing to update'],
    ['a day without its precision', { acquired_at: '2026-09-30' }, 'acquired_at and acquired_precision are edited together'],
    ['used_up_at that is not "now" or null', { used_up_at: 'yesterday' }, 'used_up_at must be "now" or null'],
    ['a blank name', { name: '' }, 'name what it is'],
    ['no place at all', { storage_location_id: null }, 'storage_location_id must be a uuid — an item always lives somewhere'],
  ])('refuses %s with a 400 carrying the server\'s own sentence', async (_what, body, sentence) => {
    expect(validateItemPatch(body)).toBe(sentence)
    const f = pantryFetch()
    const e = await refusal(send(f, 'PATCH', '/api/pantry/items/item-1', body))
    expect(e?.status).toBe(400)
    expect(e.body).toEqual({ error: sentence })
  })
})

describe('pantryFake — an override still answers first, unjudged', () => {
  it('a route handed in through `overrides` sees the body as sent and its answer is the answer', async () => {
    const f = pantryFetch({ overrides: {
      'POST /api/preservation': ({ body }) => ({ id: 'mine', ...body }),
      'POST /api/pantry/items': () => ({ item: { id: 'mine' } }),
      'PATCH /api/pantry/items/*': () => ({ item: { id: 'mine' } }),
    } })
    expect(await send(f, 'POST', '/api/preservation', { not_a_column: 1 })).toEqual({ id: 'mine', not_a_column: 1 })
    expect(await send(f, 'POST', '/api/pantry/items', { nmae: 'x' })).toEqual({ item: { id: 'mine' } })
    expect(await send(f, 'PATCH', '/api/pantry/items/item-1', {})).toEqual({ item: { id: 'mine' } })
  })
})

describe('pantryFake — the places routes, the line search and the jar read', () => {
  it('PUT /api/storage-locations/:id answers the place with what was sent laid over it, the name trimmed', async () => {
    const f = pantryFetch()
    expect(await send(f, 'PUT', '/api/storage-locations/loc-1', { label: '  Garage freezer ' })).toEqual({ id: 'loc-1', label: 'Garage freezer', kind: 'deep_freezer' })
    expect(await send(f, 'PUT', '/api/storage-locations/loc-1', { kind: 'fridge_freezer' })).toEqual({ id: 'loc-1', label: 'Chest Freezer 1', kind: 'fridge_freezer' })
    expect(await send(f, 'PUT', '/api/storage-locations/loc-3', { label: 'Drinks fridge', kind: 'fridge' })).toEqual({ id: 'loc-3', label: 'Drinks fridge', kind: 'fridge' })
  })

  it('PUT rewrites nothing: the list read answers what it was given', async () => {
    const f = pantryFetch()
    await send(f, 'PUT', '/api/storage-locations/loc-1', { label: 'Garage freezer' })
    expect(await f('/api/storage-locations')).toBe(PLACES)
    expect(PLACES[0]).toEqual({ id: 'loc-1', label: 'Chest Freezer 1', kind: 'deep_freezer' })
  })

  it('PUT on a place the fake does not list answers what was sent, under that id', async () => {
    const f = pantryFetch()
    expect(await send(f, 'PUT', '/api/storage-locations/loc-new-7', { label: 'Cellar shelf', kind: 'cold_storage' })).toEqual({ id: 'loc-new-7', label: 'Cellar shelf', kind: 'cold_storage' })
  })

  it('DELETE /api/storage-locations/:id answers { ok: true }, and the call is recorded', async () => {
    const f = pantryFetch()
    expect(await send(f, 'DELETE', '/api/storage-locations/loc-2')).toEqual({ ok: true })
    expect(f.calls('DELETE', '/api/storage-locations/')).toEqual([{ path: '/api/storage-locations/loc-2', method: 'DELETE', body: undefined }])
  })

  it('the create of a place is as it was', async () => {
    const f = pantryFetch()
    expect(await send(f, 'POST', '/api/storage-locations', { label: 'Garage fridge', kind: 'fridge' })).toEqual({ id: 'loc-new-1', label: 'Garage fridge', kind: 'fridge' })
  })

  it('the line search answers every arm of the route by itself: empty lists, no hits, no crop', async () => {
    const f = pantryFetch()
    expect(await f('/api/kitchen-batches/line-search?q=tom')).toEqual({
      plantings: [], put_ups: [], pantry_items: [], crops: [], varieties: [], hits: [], resolved_crop: null,
    })
  })

  it('a line search handed in is answered whole, as before (no arm is added to it)', async () => {
    const mine = { plantings: [{ plant_id: 'pl-1', label: 'Sungold' }], put_ups: [] }
    const f = pantryFetch({ lineSearch: mine })
    expect(await f('/api/kitchen-batches/line-search?q=sun')).toBe(mine)
  })

  it('the jar read carries plant_id, source_kind and source_label (null) beside the nine it had', async () => {
    const f = pantryFetch({ rows: [jarRow({ stock_id: 'jar-1', name: 'Blueberries', count_made: 6 })] })
    expect(await f('/api/preservation/jar-1')).toEqual({
      id: 'jar-1', label: 'Blueberries', method: 'whole_freeze', package_count: 6, quantity_value: null, quantity_unit: null,
      notes: null, use_by_target: null, storage_location_id: 'loc-1', plant_id: null, source_kind: null, source_label: null,
    })
  })
})
