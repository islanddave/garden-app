// Put-Up release 1b — the 1b Lambda routes against REAL Postgres (the ephemeral branch the integration
// workflow creates, with the train's v5-putupmake-001 0a applied). The unit lane proves what each
// handler SENDS; this file proves the SQL runs and does what it claims on the 1b schema: the keyed
// put-up and its replay, the jars' totals and dates, the place find-or-create, Undo that put-up (the
// refusal, the voids, the reopen, the replay), the 1b stage kinds, the soft batch delete and its
// refusal, unlink's 409, the legacy PUT's "From 1b" rules, the jar PATCH and Move, and the audit
// actor on a preservation_log write.
//
// Lane L2a (lambda1b). L4's kitchen-*.int.test.js files own the F matrix; this file is the 1b half's
// own proof and cleans up only what it made (every row keyed on this run's user).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { directSql, callHandler, testRunId, setTestUserId } from './_harness.js'
import { handler } from '../../lambda/preservation/index.js'

const RUN = testRunId()
const USER = `user_int_pu1b_${RUN}`
const PLACE_LABEL = `pu1b fridge ${RUN}`

const call = (method, path, body) => callHandler(handler, { method, path, body, userId: USER })
const newBatch = async (label) => {
  const r = await call('POST', '/api/kitchen-batches', { label, idempotency_key: randomUUID() })
  expect(r.status).toBe(201)
  return r.body.id
}
const sitting = (over = {}) => ({
  idempotency_key: randomUUID(), when: { date: '2026-10-08T14:30:00.000Z', precision: 'exact' },
  method: 'hot_sauce', finish: true,
  rows: [
    { count: 2, container_label: '8 oz woozy', size_value: 8, size_unit: 'fl oz',
      place: { kind: 'fridge', label: ` ${PLACE_LABEL} ` }, name: 'Megatron plain', ph: '3.70' },
    { count: 2, container_label: '8 oz woozy', size_value: 8, size_unit: 'fl oz',
      place: { kind: 'fridge', label: PLACE_LABEL.toUpperCase() }, name: 'Megatron reaper',
      added_lines: [{ label: 'vinegar', qty: 72, qty_unit: 'g' }] },
  ],
  sitting_lines: [{ label: 'reserved brine', qty: 100, qty_unit: 'ml' }],
  made_g: 910, next_time: 'more carrot', ...over,
})

beforeAll(() => { setTestUserId(USER) })

afterAll(async () => {
  await directSql`DELETE FROM kitchen_batch_input WHERE created_by = ${USER}`
  await directSql`DELETE FROM preservation_log WHERE user_id = ${USER}`
  await directSql`DELETE FROM kitchen_stage_log WHERE batch_id IN (SELECT id FROM kitchen_batch WHERE user_id = ${USER})`
  await directSql`DELETE FROM kitchen_batch WHERE user_id = ${USER}`
  await directSql`DELETE FROM storage_location WHERE user_id = ${USER}`
  await directSql`DELETE FROM audit_events WHERE actor_clerk_sub = ${USER}`
})

describe('POST /api/kitchen-batches — 1b key', () => {
  it('a replay of the same key is the same batch, 200 replayed', async () => {
    const key = randomUUID()
    const a = await call('POST', '/api/kitchen-batches', { label: 'Petri Dish', idempotency_key: key, kind: 'other' })
    expect(a.status).toBe(201)
    expect(a.body.kind_other).toBeNull()
    const b = await call('POST', '/api/kitchen-batches', { label: 'Petri Dish', idempotency_key: key })
    expect(b.status).toBe(200)
    expect(b.body).toMatchObject({ id: a.body.id, replayed: true })
  })

  // BUG-PUTUPREPLAYREST-001 (QA I-2, I-3). What the Start sheet reads off a replayed batch
  // (src/components/kitchen/StartBatchSheet.jsx): the two stamps — ONE instant while nothing has written to the
  // batch, updated_at moved by any PUT — the fields its PUT carries, and recipe_id with the jar columns, which
  // decide whether the recipe's jar is still to be put on a batch a lost tap made.
  it('a replay answers the batch\'s two stamps as one instant while it is untouched, updated_at later after a PUT, and every field the Start sheet reads', async () => {
    const ms = (v) => new Date(v).getTime()
    const key = randomUUID()
    const a = await call('POST', '/api/kitchen-batches', { label: `stamps ${RUN}`, idempotency_key: key })
    expect(a.status, JSON.stringify(a.body)).toBe(201)
    let again = await call('POST', '/api/kitchen-batches', { label: 'another body', kind: 'ferment', idempotency_key: key })
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(again.body).toMatchObject({ id: a.body.id, replayed: true, label: `stamps ${RUN}`, kind: null, recipe_id: null, vessel_label: null })
    for (const k of ['label', 'kind', 'kind_other', 'recipe_ref', 'recipe_id', 'vessel_label', 'vessel_size', 'vessel_unit', 'vessel_count', 'created_at', 'updated_at']) {
      expect(`${k}: ${Object.prototype.hasOwnProperty.call(again.body, k)}`).toBe(`${k}: true`)
    }
    const made = ms(again.body.created_at)
    expect(Number.isFinite(made)).toBe(true)
    expect(ms(again.body.updated_at)).toBe(made)
    await new Promise((resolve) => setTimeout(resolve, 20))                   // the two stamps travel at millisecond precision
    const put = await call('PUT', `/api/kitchen-batches/${a.body.id}`, { vessel_label: 'Half-gallon jar' })
    expect(put.status, JSON.stringify(put.body)).toBe(200)
    again = await call('POST', '/api/kitchen-batches', { label: 'another body', idempotency_key: key })
    expect(again.body).toMatchObject({ id: a.body.id, replayed: true, label: `stamps ${RUN}`, vessel_label: 'Half-gallon jar' })
    expect(ms(again.body.created_at)).toBe(made)
    expect(ms(again.body.updated_at)).toBeGreaterThan(made)
  })

  it('"Not sure" writes an undated started row with precision unknown', async () => {
    const r = await call('POST', '/api/kitchen-batches', { label: 'Mystery crock', start_precision: 'unknown', idempotency_key: randomUUID() })
    expect(r.status).toBe(201)
    const s = await directSql`SELECT entered_at, entered_precision FROM kitchen_stage_log WHERE batch_id = ${r.body.id} AND stage_kind = 'started'`
    expect(s).toEqual([{ entered_at: null, entered_precision: 'unknown' }])
  })
})

describe('Put it up → read back → Undo', () => {
  let batchId
  let first

  it('one keyed statement: put_up row, 2 jars (TOTAL contents), 1 place from two spellings, 2 lines, noted, finished, closed', async () => {
    batchId = await newBatch('Megatron mash')
    const body = sitting()
    const r = await call('POST', `/api/kitchen-batches/${batchId}/put-up`, body)
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    first = { body, res: r.body }
    expect(r.body.jars).toHaveLength(2)
    // One statement writes both jars, so they share created_at; find the row by its name, not position.
    const plain = r.body.jars.find((j) => j.label === 'Megatron plain')
    expect(plain).toMatchObject({
      label: 'Megatron plain', container_label: '8 oz woozy', quantity_unit: 'fl oz', package_count: 2,
      remaining_count: 2, preserved_at: '2026-10-08', use_by_basis: 'table', preserved_at_precision: 'exact',
      storage_label: PLACE_LABEL, put_up_stage_id: r.body.stage.id,
    })
    expect(Number(plain.quantity_value)).toBe(16)
    expect(String(plain.ph_reading)).toBe('3.70')
    expect(r.body.batch.closed_at).not.toBeNull()
    expect(r.body.batch.outcome).toBe('put_up')
    expect(r.body.inputs.map((i) => i.label).sort()).toEqual(['reserved brine', 'vinegar'])
    const places = await directSql`SELECT id FROM storage_location WHERE user_id = ${USER} AND lower(btrim(label)) = lower(${PLACE_LABEL})`
    expect(places).toHaveLength(1)
    const kinds = await directSql`SELECT stage_kind, note FROM kitchen_stage_log WHERE batch_id = ${batchId} ORDER BY created_at, stage_kind`
    expect(kinds.map((k) => k.stage_kind).sort()).toEqual(['finished', 'noted', 'put_up', 'started'])
    // use_by: hot_sauce in a fridge = 6 months from the ET day.
    const jar = await directSql`SELECT use_by_target::text AS d FROM preservation_log WHERE id = ${plain.id}`
    expect(jar[0].d).toBe('2027-04-08')
  })

  it('a retry with the same key is a replay: 200, nothing new written', async () => {
    const r = await call('POST', `/api/kitchen-batches/${batchId}/put-up`, first.body)
    // The sitting finished the batch; its retry is still ITS replay, never the closed-batch door.
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.replayed).toBe(true)
    const jars = await directSql`SELECT count(*)::int AS n FROM preservation_log WHERE batch_id = ${batchId}`
    expect(jars[0].n).toBe(2)
  })

  it('a closed batch refuses a new sitting with the door', async () => {
    const r = await call('POST', `/api/kitchen-batches/${batchId}/put-up`, sitting())
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ code: 'batch_closed', reopen: true })
  })

  it('unlinking a sitting jar → 409 put_up_jar (never the 23514)', async () => {
    const r = await call('DELETE', `/api/kitchen-batches/${batchId}/outputs/${first.res.jars[0].id}`)
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('put_up_jar')
  })

  it('removing a batch with live jars → 409 has_jars, nothing removed', async () => {
    const r = await call('DELETE', `/api/kitchen-batches/${batchId}`)
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('has_jars')
    const b = await directSql`SELECT deleted_at FROM kitchen_batch WHERE id = ${batchId}`
    expect(b[0].deleted_at).toBeNull()
  })

  it('the legacy PUT on a label-only sitting jar: Mark used → 200; a differing note → 409, unchanged', async () => {
    const jar = first.res.jars[0]
    const echo = {
      crop_type_slug: null, variety_id: null, plant_id: null, harvest_log_id: null, preserved_at: jar.preserved_at,
      preserved_at_approx: jar.preserved_at_approx, method: jar.method, method_other_text: null,
      quantity_value: jar.quantity_value, quantity_unit: jar.quantity_unit, package_count: 2,
      storage_location_id: jar.storage_location_id, use_by_target: '2027-04-08', remaining_count: 1,
      consumed_at: null, notes: null, photo_id: null, source_kind: null, source_label: null,
    }
    const ok = await call('PUT', `/api/preservation/${jar.id}`, echo)
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body.remaining_count).toBe(1)
    const stale = await call('PUT', `/api/preservation/${jar.id}`, { ...echo, notes: 'a stale tab', remaining_count: 0 })
    expect(stale.status).toBe(409)
    expect(stale.body.code).toBe('client_stale')
    const row = await directSql`SELECT remaining_count, notes FROM preservation_log WHERE id = ${jar.id}`
    expect(row[0]).toEqual({ remaining_count: 1, notes: null })
    // An absent remaining_count is UNCHANGED (1a wrote NULL).
    const { remaining_count: _r, consumed_at: _c, ...noCount } = echo
    const absent = await call('PUT', `/api/preservation/${jar.id}`, noCount)
    expect(absent.status).toBe(200)
    expect(absent.body.remaining_count).toBe(1)
    // The stale-tab race: a differing count WITH a differing remaining.
    const race = await call('PUT', `/api/preservation/${jar.id}`, { ...echo, package_count: 3, remaining_count: 0 })
    expect(race.status).toBe(409)
    expect(race.body.code).toBe('client_stale')
  })

  it('the Mark used was audited with the actor, not "system"', async () => {
    const a = await directSql`
      SELECT actor_clerk_sub FROM audit_events
      WHERE table_name = 'preservation_log' AND row_id = ${first.res.jars[0].id}
      ORDER BY 1`
    expect(a.length).toBeGreaterThan(0)
    expect(a.every((x) => x.actor_clerk_sub === USER)).toBe(true)
  })

  it('Undo is refused while a jar of the sitting is used → 409 put_up_in_use, nothing written', async () => {
    const r = await call('POST', `/api/kitchen-batches/${batchId}/put-up/${first.res.stage.id}/undo`, {})
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('put_up_in_use')
    expect(r.body.jar_ids).toEqual([first.res.jars[0].id])
    const v = await directSql`SELECT count(*)::int AS n FROM kitchen_stage_log WHERE batch_id = ${batchId} AND stage_kind = 'void'`
    expect(v[0].n).toBe(0)
  })

  it('Undo of an unused sitting: voids put_up + finished, removes jars and lines, reopens; a second Undo replays', async () => {
    const b2 = await newBatch('Settlers')
    const put = await call('POST', `/api/kitchen-batches/${b2}/put-up`, sitting())
    expect(put.status).toBe(201)
    const u = await call('POST', `/api/kitchen-batches/${b2}/put-up/${put.body.stage.id}/undo`, {})
    expect(u.status, JSON.stringify(u.body)).toBe(200)
    expect(u.body).toMatchObject({ ok: true, reopened: true })
    expect(u.body.batch.closed_at).toBeNull()
    const voids = await directSql`SELECT voids_id FROM kitchen_stage_log WHERE batch_id = ${b2} AND stage_kind = 'void'`
    expect(voids).toHaveLength(2)
    const live = await directSql`SELECT count(*)::int AS n FROM preservation_log WHERE batch_id = ${b2} AND deleted_at IS NULL`
    expect(live[0].n).toBe(0)
    const lines = await directSql`SELECT count(*)::int AS n FROM kitchen_batch_input WHERE batch_id = ${b2} AND deleted_at IS NULL`
    expect(lines[0].n).toBe(0)
    const again = await call('POST', `/api/kitchen-batches/${b2}/put-up/${put.body.stage.id}/undo`, {})
    expect(again.status).toBe(200)
    expect(again.body.replayed).toBe(true)
    // With its jars undone the batch can be removed; its lines stay soft-deleted.
    const del = await call('DELETE', `/api/kitchen-batches/${b2}`)
    expect(del.status).toBe(200)
  })

  it('"Not sure": the put_up row is undated, the jars take the batch\'s latest dated event, approx, precision after', async () => {
    const b3 = await newBatch('Kraut')
    const r = await call('POST', `/api/kitchen-batches/${b3}/put-up`, sitting({ when: { precision: 'unknown' }, finish: false, rows: [{ count: 1 }] }))
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.stage).toMatchObject({ entered_at: null, entered_precision: 'unknown' })
    expect(r.body.jars[0]).toMatchObject({ preserved_at_approx: true, preserved_at_precision: 'after', label: 'Kraut' })
    expect(r.body.batch.closed_at).toBeNull()
  })
})

describe('stages — the 1b kinds', () => {
  it('a check-in, its Undo (void), a replayed Undo; pause and resume move the batch column', async () => {
    const b = await newBatch('Kimchi')
    const t = await call('POST', `/api/kitchen-batches/${b}/stages`, { stage_kind: 'tended', note: 'bubbling' })
    expect(t.status).toBe(201)
    const v = await call('POST', `/api/kitchen-batches/${b}/stages`, { stage_kind: 'void', voids_id: t.body.stage.id })
    expect(v.status, JSON.stringify(v.body)).toBe(201)
    const v2 = await call('POST', `/api/kitchen-batches/${b}/stages`, { stage_kind: 'void', voids_id: t.body.stage.id })
    expect(v2.status).toBe(200)
    expect(v2.body.replayed).toBe(true)
    const started = await directSql`SELECT id FROM kitchen_stage_log WHERE batch_id = ${b} AND stage_kind = 'started'`
    const bad = await call('POST', `/api/kitchen-batches/${b}/stages`, { stage_kind: 'void', voids_id: started[0].id })
    expect(bad.status).toBe(400)
    const p = await call('POST', `/api/kitchen-batches/${b}/stages`, { stage_kind: 'paused' })
    expect(p.status).toBe(201)
    expect(p.body.batch.suspended_at).not.toBeNull()
    const p2 = await call('POST', `/api/kitchen-batches/${b}/stages`, { stage_kind: 'paused' })
    expect(p2.status).toBe(409)
    const r = await call('POST', `/api/kitchen-batches/${b}/stages`, { stage_kind: 'resumed' })
    expect(r.status).toBe(201)
    expect(r.body.batch.suspended_at).toBeNull()
    const n = await call('POST', `/api/kitchen-batches/${b}/stages`, { stage_kind: 'noted', note: 'next time less salt' })
    expect(n.status).toBe(201)
    const detail = await call('GET', `/api/kitchen-batches/${b}`)
    expect(detail.status).toBe(200)
    expect(detail.body.stages.some((s) => s.stage_kind === 'void' && s.voids_id === t.body.stage.id)).toBe(true)
  })
})

describe('jars — POST additions, PATCH, Move', () => {
  let jarId

  it('POST: a label-only jar with no size, the engine basis, and a key replay', async () => {
    const key = randomUUID()
    const body = { label: 'Pickled onions', method: 'quick_pickle', preserved_at: '2026-10-01', idempotency_key: key }
    const a = await call('POST', '/api/preservation', body)
    expect(a.status, JSON.stringify(a.body)).toBe(201)
    expect(a.body).toMatchObject({ label: 'Pickled onions', quantity_value: null, use_by_basis: 'table' })
    jarId = a.body.id
    const b = await call('POST', '/api/preservation', body)
    expect(b.status).toBe(200)
    expect(b.body).toMatchObject({ id: jarId, replayed: true })
  })

  it('PATCH: a correction re-derives; discard_by is typed; an unknown key is refused', async () => {
    const raw = await call('PATCH', `/api/preservation/${jarId}`, { method: 'hot_sauce' })
    expect(raw.status, JSON.stringify(raw.body)).toBe(200)
    expect(raw.body).toMatchObject({ method: 'hot_sauce', use_by_basis: 'table', use_by_target: '2027-04-01' })
    const typed = await call('PATCH', `/api/preservation/${jarId}`, { discard_by: '2026-12-25', notes_append: 'from the farm stand' })
    expect(typed.status).toBe(200)
    expect(typed.body).toMatchObject({ use_by_target: '2026-12-25', use_by_basis: 'typed', notes: 'from the farm stand' })
    const q = await call('PATCH', `/api/preservation/${jarId}`, { quantity_value: 2.5, quantity_unit: 'quarts' })
    expect(q.status).toBe(200)
    expect(q.body.quantity_unit).toBe('qt')
    const nope = await call('PATCH', `/api/preservation/${jarId}`, { remaining_count: 0 })
    expect(nope.status).toBe(400)
  })

  it('Move: a new place found-or-created; a change of kind stamps the move; a typed date survives', async () => {
    const m = await call('POST', `/api/preservation/${jarId}/move`, { place: { kind: 'deep_freezer', label: `pu1b freezer ${RUN}` }, when: '2026-10-20' })
    expect(m.status, JSON.stringify(m.body)).toBe(200)
    expect(m.body.use_by_target).toBe('2026-12-25')
    expect(m.body.use_by_basis).toBe('typed')
    expect(m.body.storage_moved_at).not.toBeNull()
    const again = await call('POST', `/api/preservation/${jarId}/move`, { place: { kind: 'deep_freezer', label: ` PU1B FREEZER ${RUN}` } })
    expect(again.status).toBe(200)
    const places = await directSql`SELECT count(*)::int AS n FROM storage_location WHERE user_id = ${USER} AND kind = 'deep_freezer'`
    expect(places[0].n).toBe(1)
  })

  it('Move of a table-dated jar to another kind nulls the date (basis none)', async () => {
    const a = await call('POST', '/api/preservation', { label: 'Salsa', method: 'can_water_bath', preserved_at: '2026-09-01', idempotency_key: randomUUID() })
    expect(a.status).toBe(201)
    expect(a.body.use_by_basis).toBe('table')
    const m = await call('POST', `/api/preservation/${a.body.id}/move`, { place: { kind: 'fridge', label: PLACE_LABEL } })
    expect(m.status, JSON.stringify(m.body)).toBe(200)
    expect(m.body).toMatchObject({ use_by_target: null, use_by_basis: 'none' })
  })

  // BUG-PUTUPREPLAYREST-001, QA B-1 — the jar twin of pantry-items.int.test.js "a replay answers the item's two
  // stamps". The client's retry rule (src/components/kitchen/idempotencyKey.js rowIsThisSittings) reads a jar's
  // stamps to tell one it just made from one written to since. BY SOURCE a jar is NOT like an item: updated_at
  // is nullable with no default (migrations/v4-putup-001/0a:97), the create's INSERT does not name it, and only
  // the BEFORE UPDATE trigger (v5-putupmake-001/0a:418-421) writes it — so a fresh jar answers updated_at NULL,
  // and the client reads NULL beside a real created_at as "untouched" FOR THIS TABLE ONLY. This case is the
  // database's own word on that.
  // IT ASSERTS WHAT THE CLIENT NEEDS, NOT THE MECHANISM (re-review I-D). rowIsThisSittings reads a jar as untouched
  // when updated_at is NULL *or* is created_at's own instant, so the three checks before the PATCH take either:
  // "nothing has written to it since its create". By the migration files it is NULL. A default on the live table
  // that those files do not show would make it equal instead — the client is fine with that, and a harmless
  // difference between a database and its files must not stop a promote. A stamp that is SET AND NOT created_at's
  // is the one state that changes behaviour (the client then refuses every repair), and it still goes red.
  it('a replay answers the jar\'s two stamps and every field the client compares: updated_at NULL (or created_at\'s own instant) while nothing has written to it, set and later than created_at after any PATCH', async () => {
    const ms = (v) => new Date(v).getTime()
    const untouched = (v, made) => (v === null ? 'null' : ms(v) === made ? 'equal to created_at' : `set and not created_at's: ${v}`)
    const k = randomUUID()
    const body = {
      label: `stamps ${RUN}`, method: 'quick_pickle', preserved_at: '2026-10-01', preserved_at_precision: 'day',
      package_count: 2, quantity_value: 16, quantity_unit: 'oz', notes: 'first', idempotency_key: k,
    }
    const first = await call('POST', '/api/preservation', body)
    expect(first.status, JSON.stringify(first.body)).toBe(201)
    const made = ms(first.body.created_at)
    expect(Number.isFinite(made)).toBe(true)
    expect(Math.abs(Date.now() - made)).toBeLessThan(5 * 60 * 1000)          // the database's clock, near this one
    expect(untouched(first.body.updated_at, made)).toMatch(/^(null|equal to created_at)$/)
    let again = await call('POST', '/api/preservation', { ...body, label: 'another body', notes: 'second' })
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(again.body).toMatchObject({ id: first.body.id, replayed: true, label: `stamps ${RUN}`, notes: 'first' })
    expect(ms(again.body.created_at)).toBe(made)
    expect(untouched(again.body.updated_at, made)).toMatch(/^(null|equal to created_at)$/)
    expect((await directSql`SELECT (updated_at IS NULL OR updated_at = created_at) AS untouched FROM preservation_log WHERE id = ${first.body.id}`)[0].untouched).toBe(true)
    // The replay is the raw row: every key the client's reading of it names is there (a missing one would read
    // as "nothing" and let a difference through), and the date it compares by its first ten characters is the day.
    for (const key of ['id', 'label', 'method', 'package_count', 'quantity_value', 'quantity_unit', 'remaining_amount',
      'storage_location_id', 'plant_id', 'crop_type_slug', 'variety_id', 'preserved_at', 'preserved_at_precision',
      'use_by_target', 'use_by_basis', 'is_raw', 'in_oil', 'texture', 'notes', 'source_kind', 'source_label',
      'created_at', 'updated_at', 'deleted_at']) {
      expect(`${key}: ${Object.prototype.hasOwnProperty.call(again.body, key)}`).toBe(`${key}: true`)
    }
    expect(String(again.body.preserved_at).slice(0, 10)).toBe('2026-10-01')
    expect(Number(again.body.package_count)).toBe(2)
    expect([Number(again.body.quantity_value), again.body.quantity_unit]).toEqual([16, 'oz'])
    expect(again.body.use_by_basis).not.toBe('typed')
    await new Promise((resolve) => setTimeout(resolve, 20))                   // the two stamps travel at millisecond precision
    const patch = await call('PATCH', `/api/preservation/${first.body.id}`, { notes: 'touched' })
    expect(patch.status, JSON.stringify(patch.body)).toBe(200)
    again = await call('POST', '/api/preservation', { ...body, label: 'another body' })
    expect(again.body).toMatchObject({ id: first.body.id, replayed: true, notes: 'touched' })
    expect(ms(again.body.created_at)).toBe(made)
    expect(again.body.updated_at).not.toBeNull()
    expect(ms(again.body.updated_at)).toBeGreaterThan(made)
  })
})
