// batchbuilder-routes.int.test.js — Put-Up B′ release 3 (the batch builder) routes on the real train fork
// (1b + F + pantry + batchbuilder). The unit lane (lambda/preservation/batchBuilder.test.js) proves what each
// route SENDS; this file proves what the database keeps, reading every row back with directSql.
//
//   POST /api/kitchen-batches/from-jars   How it was made → (V4 §2.2, §5.1)
//   GET  /api/kitchen-batches?plant_id=   the planting read (V4 §2.5)
//   GET  /api/kitchen-batches/line-search the whole name search (V4 §2.5a): pantry items, crops
//   POST /:id/inputs                      a 'pantry' line by pantry_item_id
//   POST /:id/close                       the close sheet's When ("A make with nothing kept")
// DAVE and JEN share a household; STRANGER is outside it and gets 400/404 on every arm naming DAVE's rows.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql } from './_harness.js'
import {
  makeHousehold, useHousehold, call, key, seedBatch, seedJar, seedPlanting, seedPlace, readJar, usesOf, linesOf,
  readBatchRow, CROP,
} from './_kitchenF.js'

const H = makeHousehold('bbroute')
const { DAVE, JEN, STRANGER } = H
useHousehold(H, beforeAll, afterAll)
// pantry_item is release 2's table; the kitchen teardown does not know it. Registered AFTER useHousehold, so it
// runs FIRST (hooks unwind as a stack): lines that name an item go, then the items.
afterAll(async () => {
  const ids = [DAVE, JEN, STRANGER]
  await directSql`DELETE FROM kitchen_batch_input WHERE pantry_item_id IN (SELECT id FROM pantry_item WHERE user_id = ANY(${ids}))`
  await directSql`DELETE FROM pantry_item WHERE user_id = ANY(${ids})`
})

const FROM = '/api/kitchen-batches/from-jars'
async function seedItem(owner, { name = 'bb onions', plantId = null, notes = null } = {}) {
  const place = await seedPlace(owner, { kind: 'pantry' })
  const [r] = await directSql`
    INSERT INTO pantry_item (user_id, name, storage_location_id, plant_id, crop_type_slug, notes)
    VALUES (${owner}, ${name}, ${place}, ${plantId}, ${CROP}, ${notes}) RETURNING id`
  return r.id
}
// Write order. The one statement steps created_at 1 µs per row (batchBuilder.planFromJarsStages), except that
// put_up and finished share one instant, as Put it up writes them (Undo that put-up finds "the finished row
// this sitting wrote" by that equality) — so that one tie is broken by kind, put_up first.
const stagesOf = (b) => directSql`
  SELECT stage_kind, entered_at, entered_precision, note FROM kitchen_stage_log WHERE batch_id = ${b}
  ORDER BY created_at, (stage_kind = 'finished'), id`

describe('the fork carries release 2 and 3', () => {
  it('pantry_item and kitchen_batch_input.pantry_item_id exist, and 5.0.0-batchbuilder-001 is stamped', async () => {
    const [t] = await directSql`SELECT to_regclass('public.pantry_item') IS NOT NULL AS ok`
    expect(t.ok).toBe(true)
    const c = await directSql`SELECT 1 FROM information_schema.columns WHERE table_name = 'kitchen_batch_input' AND column_name = 'pantry_item_id'`
    expect(c).toHaveLength(1)
    expect(await directSql`SELECT 1 FROM schema_version WHERE version = '5.0.0-batchbuilder-001'`).toHaveLength(1)
  })
})

describe('POST /api/kitchen-batches/from-jars — How it was made →', () => {
  it('DAVE: one write — a closed batch, its stages dated the jar\'s date, its lines and draws, the jar linked, its source untouched', async () => {
    const jar = await seedJar(DAVE, { count: 2, method: 'hot_sauce', sourceKind: 'own_garden', notes: 'Oct 8 · Next time: more carrot' })
    const other = await seedJar(DAVE, { count: 2, method: 'hot_sauce' })
    const carrots = await seedJar(DAVE, { count: 4 })
    const [before] = await directSql`SELECT preserved_at, source_kind, source_label, plant_id, crop_type_slug, variety_id FROM preservation_log WHERE id = ${jar}`
    const k = key()
    const res = await call(DAVE, 'POST', FROM, {
      idempotency_key: k, label: 'Megatron plain', started: { date: '2026-08-01', precision: 'day' }, kind: 'ferment',
      jar_ids: [jar, other], next_time: 'less salt',
      inputs: [
        { input_kind: 'other', label: 'jalapeño', qty: 412, qty_unit: 'g' },
        { input_kind: 'put_up', preservation_log_id: carrots, count_drawn: 1, qty: 150, qty_unit: 'g' },
      ],
    })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const b = res.body.id
    const row = await readBatchRow(b)
    expect(row).toMatchObject({ user_id: DAVE, label: 'Megatron plain', kind: 'ferment', outcome: 'put_up', start_precision: 'day', idempotency_key: k })
    expect(row.closed_at).not.toBeNull()
    const st = await stagesOf(b)
    expect(st.map((s) => s.stage_kind)).toEqual(['started', 'put_up', 'finished', 'noted', 'noted'])
    expect(st[1].entered_precision).toBe(st[2].entered_precision)
    expect(String(st[1].entered_at?.toISOString?.() ?? st[1].entered_at).slice(0, 10)).toBe(String(before.preserved_at?.toISOString?.() ?? before.preserved_at).slice(0, 10))
    expect(st.slice(3).map((s) => s.note)).toEqual(['Oct 8 · Next time: more carrot', 'less salt'])
    // The jars: linked by batch_id, never a sitting's put_up_stage_id, and their where-from untouched.
    const jars = await directSql`SELECT id, batch_id, put_up_stage_id, source_kind, source_label, plant_id, crop_type_slug, variety_id FROM preservation_log WHERE id IN (${jar}, ${other})`
    for (const j of jars) { expect(j.batch_id).toBe(b); expect(j.put_up_stage_id).toBeNull() }
    const after = jars.find((j) => j.id === jar)
    for (const c of ['source_kind', 'source_label', 'plant_id', 'crop_type_slug', 'variety_id']) expect(after[c]).toEqual(before[c])
    // The lines and the counted draw.
    const lines = await linesOf(b)
    expect(lines.map((l) => l.input_kind)).toEqual(['other', 'put_up'])
    expect((await readJar(carrots)).remaining_count).toBe(3)
    expect((await usesOf(carrots)).map((u) => [u.count_used, u.fate])).toEqual([[1, 'batch']])
    // The response is the batch detail.
    expect(res.body.outputs.map((o) => o.id).sort()).toEqual([jar, other].sort())
  })

  it('How many did you make? raises the made count and keeps what is left', async () => {
    const jar = await seedJar(DAVE, { count: 2, remaining: 1 })
    const res = await call(DAVE, 'POST', FROM, { idempotency_key: key(), label: 'Six made', started: { date: null, precision: 'unknown' }, jar_ids: [jar], made_count: 6 })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(await readJar(jar)).toMatchObject({ package_count: 6, remaining_count: 1 })
    const [s] = await stagesOf(res.body.id)
    expect(s).toMatchObject({ stage_kind: 'started', entered_at: null, entered_precision: 'unknown' })
  })

  it('a start on the jars\' own day: the batch reads finished (the view\'s current stage), and two Next time lines keep their order', async () => {
    const jar = await seedJar(DAVE, { count: 2, notes: 'Next time: less garlic' })
    const [{ day }] = await directSql`SELECT to_char(preserved_at, 'YYYY-MM-DD') AS day FROM preservation_log WHERE id = ${jar}`
    const res = await call(DAVE, 'POST', FROM, { idempotency_key: key(), label: 'Same day', started: { date: day, precision: 'day' }, jar_ids: [jar], next_time: 'more heat' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    // started, put_up and finished all carry that day; only the write order can say which is current.
    const [v] = await directSql`SELECT current_stage_kind FROM v_kitchen_batch_current WHERE id = ${res.body.id}`
    expect(v.current_stage_kind).toBe('finished')
    const notes = await directSql`
      SELECT note FROM kitchen_stage_log WHERE batch_id = ${res.body.id} AND stage_kind = 'noted' ORDER BY created_at, id`
    expect(notes.map((n) => n.note)).toEqual(['Next time: less garlic', 'more heat'])
  })

  it('JEN from DAVE\'s jar: allowed, recorded as JEN', async () => {
    const jar = await seedJar(DAVE, { count: 1 })
    const res = await call(JEN, 'POST', FROM, { idempotency_key: key(), label: 'Jen made it', started: { date: '2026-09-01', precision: 'day' }, jar_ids: [jar] })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect((await readBatchRow(res.body.id)).user_id).toBe(JEN)
  })

  it('STRANGER on DAVE\'s jar: 400, nothing written, the jar untouched', async () => {
    const jar = await seedJar(DAVE, { count: 1 })
    const k = key()
    const res = await call(STRANGER, 'POST', FROM, { idempotency_key: k, label: 'Not mine', started: { date: '2026-09-01', precision: 'day' }, jar_ids: [jar] })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('jar_not_found')
    expect(await directSql`SELECT id FROM kitchen_batch WHERE idempotency_key = ${k}`).toHaveLength(0)
    const [j] = await directSql`SELECT batch_id FROM preservation_log WHERE id = ${jar}`
    expect(j.batch_id).toBeNull()
  })

  it('a replay (same key) answers 200 replayed with the one batch; a jar with a batch under a new key → 409', async () => {
    const jar = await seedJar(DAVE, { count: 1 })
    const body = { idempotency_key: key(), label: 'Once', started: { date: '2026-09-01', precision: 'day' }, jar_ids: [jar] }
    const first = await call(DAVE, 'POST', FROM, body)
    expect(first.status).toBe(201)
    const again = await call(JEN, 'POST', FROM, body)
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ id: first.body.id, replayed: true })
    expect(await directSql`SELECT id FROM kitchen_batch WHERE idempotency_key = ${body.idempotency_key}`).toHaveLength(1)
    const other = await call(DAVE, 'POST', FROM, { ...body, idempotency_key: key() })
    expect(other.status).toBe(409)
    expect(other.body.code).toBe('jar_has_batch')
    // STRANGER replaying DAVE's key: the key is someone else's → 409, no payload of theirs.
    const s = await call(STRANGER, 'POST', FROM, { ...body, jar_ids: [await seedJar(STRANGER, { count: 1 })] })
    expect(s.status).toBe(409)
    expect(s.body.code).toBe('key_conflict')
  })

  it('all or nothing: an over-draw aborts the whole write — no batch, no link', async () => {
    const jar = await seedJar(DAVE, { count: 1 })
    // A COUNTED jar: two made. seedJar logs a jar in lb, and one container in a mass unit is WEIGHED (06 §1.4,
    // kitchenLines.jarIsWeighed) — a count_drawn on it is the 400 "say how many g", never an over-draw.
    const drawn = await seedJar(DAVE, { count: 2 })
    const k = key()
    const res = await call(DAVE, 'POST', FROM, {
      idempotency_key: k, label: 'Too much', started: { date: '2026-09-01', precision: 'day' }, jar_ids: [jar],
      inputs: [{ input_kind: 'put_up', preservation_log_id: drawn, count_drawn: 3 }],
    })
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body).toMatchObject({ code: 'only_n_left', n: 2 })
    expect(await usesOf(drawn)).toHaveLength(0)
    expect((await readJar(drawn)).remaining_count).toBeNull()
    expect(await directSql`SELECT id FROM kitchen_batch WHERE idempotency_key = ${k}`).toHaveLength(0)
    expect((await directSql`SELECT batch_id FROM preservation_log WHERE id = ${jar}`)[0].batch_id).toBeNull()
  })

  // Its put_up row owns no jars (they pre-existed the batch), so Undo that put-up is refused: voiding it
  // would reopen the batch with the jars still linked. STRANGER cannot see the batch at all.
  it('Undo that put-up on its sitting: 409 nothing_put_up_here, nothing written; STRANGER 404', async () => {
    const jar = await seedJar(DAVE, { count: 2 })
    const res = await call(DAVE, 'POST', FROM, { idempotency_key: key(), label: 'No undo', started: { date: '2026-09-01', precision: 'day' }, jar_ids: [jar] })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const b = res.body.id
    const [pu] = await directSql`SELECT id FROM kitchen_stage_log WHERE batch_id = ${b} AND stage_kind = 'put_up'`
    const path = `/api/kitchen-batches/${b}/put-up/${pu.id}/undo`
    for (const who of [DAVE, JEN]) {
      const u = await call(who, 'POST', path, {})
      expect(u.status, JSON.stringify(u.body)).toBe(409)
      expect(u.body.code).toBe('nothing_put_up_here')
    }
    expect((await call(STRANGER, 'POST', path, {})).status).toBe(404)
    // Batch detail flags it, so What came out offers no Undo there.
    const detail = await call(DAVE, 'GET', `/api/kitchen-batches/${b}`)
    expect(detail.body.stages.find((s) => s.id === pu.id).has_own_jars).toBe(false)
    expect(await directSql`SELECT id FROM kitchen_stage_log WHERE batch_id = ${b} AND stage_kind = 'void'`).toHaveLength(0)
    expect((await readBatchRow(b)).closed_at).not.toBeNull()
    expect((await directSql`SELECT batch_id, deleted_at FROM preservation_log WHERE id = ${jar}`)[0]).toMatchObject({ batch_id: b, deleted_at: null })
  })

  // Remove this batch on it: the jars were logged before the batch, so the one statement unlinks them (they stay,
  // live, batchless), soft-deletes the lines and gives back their draws. STRANGER 404, nothing touched.
  it('Remove this batch: 200 — its jars unlinked and kept, its lines out, their draws given back; STRANGER 404', async () => {
    const jar = await seedJar(DAVE, { count: 2 })
    const drawn = await seedJar(DAVE, { count: 3 })
    const res = await call(DAVE, 'POST', FROM, {
      idempotency_key: key(), label: 'Pieced', started: { date: '2026-09-01', precision: 'day' }, jar_ids: [jar],
      inputs: [{ input_kind: 'put_up', preservation_log_id: drawn, count_drawn: 1 }],
    })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const b = res.body.id
    expect((await readJar(drawn)).remaining_count).toBe(2)
    expect((await call(STRANGER, 'DELETE', `/api/kitchen-batches/${b}`)).status).toBe(404)
    expect((await readBatchRow(b)).deleted_at).toBeNull()
    const d = await call(JEN, 'DELETE', `/api/kitchen-batches/${b}`)
    expect(d.status, JSON.stringify(d.body)).toBe(200)
    expect((await readBatchRow(b)).deleted_at).not.toBeNull()
    expect((await directSql`SELECT batch_id, deleted_at FROM preservation_log WHERE id = ${jar}`)[0]).toMatchObject({ batch_id: null, deleted_at: null })
    expect((await linesOf(b)).every((l) => l.deleted_at != null)).toBe(true)
    expect((await readJar(drawn)).remaining_count).toBe(3)
    expect((await usesOf(drawn)).map((u) => u.count_used).sort()).toEqual([-1, 1])
    // Unlinked, the jar can be pieced into a batch again.
    const again = await call(DAVE, 'POST', FROM, { idempotency_key: key(), label: 'Pieced again', started: { date: '2026-09-01', precision: 'day' }, jar_ids: [jar] })
    expect(again.status, JSON.stringify(again.body)).toBe(201)
  })
})

describe('pantry lines — POST /:id/inputs with pantry_item_id', () => {
  it('JEN adds DAVE\'s bought onions to DAVE\'s batch; STRANGER cannot (404 on the batch)', async () => {
    const b = (await seedBatch(DAVE)).id
    const item = await seedItem(DAVE)
    const res = await call(JEN, 'POST', `/api/kitchen-batches/${b}/inputs`, { inputs: [{ input_kind: 'pantry', pantry_item_id: item, idempotency_key: key() }] })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const [line] = await linesOf(b)
    expect(line).toMatchObject({ input_kind: 'pantry', pantry_item_id: item, label: 'bb onions', crop_type_slug: CROP })
    const s = await call(STRANGER, 'POST', `/api/kitchen-batches/${b}/inputs`, { inputs: [{ input_kind: 'pantry', pantry_item_id: item, idempotency_key: key() }] })
    expect(s.status).toBe(404)
  })

  it('a foreign item on DAVE\'s batch is a 400', async () => {
    const b = (await seedBatch(DAVE)).id
    const theirs = await seedItem(STRANGER)
    const res = await call(DAVE, 'POST', `/api/kitchen-batches/${b}/inputs`, { inputs: [{ input_kind: 'pantry', pantry_item_id: theirs, idempotency_key: key() }] })
    expect(res.status).toBe(400)
    expect(await linesOf(b)).toHaveLength(0)
  })
})

describe('GET /api/kitchen-batches/line-search — pantry items and crops in the one ranked list', () => {
  it('DAVE finds his pantry item ranked with the rest; STRANGER does not see it', async () => {
    const name = `bbsearch-${H.RUN}`
    await seedItem(DAVE, { name })
    const d = await call(DAVE, 'GET', `/api/kitchen-batches/line-search?q=${encodeURIComponent(name)}`)
    expect(d.status).toBe(200)
    expect(d.body.pantry_items.map((i) => i.label)).toEqual([name])
    expect(d.body.hits[0]).toMatchObject({ kind: 'pantry_item', tier: 'exact', label: name })
    const s = await call(STRANGER, 'GET', `/api/kitchen-batches/line-search?q=${encodeURIComponent(name)}`)
    expect(s.body.pantry_items).toEqual([])
    const [crop] = await directSql`SELECT slug, display_name FROM crop_types WHERE slug = ${CROP}`
    const c = await call(DAVE, 'GET', `/api/kitchen-batches/line-search?q=${encodeURIComponent(crop.display_name)}`)
    expect(c.body.hits.some((h) => h.kind === 'crop' && h.crop_type_slug === CROP)).toBe(true)
  })
})

describe('GET /api/kitchen-batches?plant_id= — the planting read', () => {
  it('lists batches that used it (a garden line; a drawn jar from it), and what is kept fresh; STRANGER 404', async () => {
    const p = await seedPlanting(DAVE, { name: 'bb-read' })
    const direct = (await seedBatch(DAVE, { label: 'bb direct' })).id
    await call(DAVE, 'POST', `/api/kitchen-batches/${direct}/inputs`, { inputs: [{ input_kind: 'garden', plant_id: p.plantId, idempotency_key: key() }] })
    await directSql`INSERT INTO kitchen_stage_log (batch_id, stage_kind, entered_at, entered_precision, note, created_by)
                    VALUES (${direct}, 'noted', now(), 'exact', 'Next time: more garlic', ${DAVE})`
    const frozen = await seedJar(DAVE, { count: 3, plantId: p.plantId })
    const indirect = (await seedBatch(DAVE, { label: 'bb indirect' })).id
    await call(DAVE, 'POST', `/api/kitchen-batches/${indirect}/inputs`, { inputs: [{ input_kind: 'put_up', preservation_log_id: frozen, count_drawn: 1, idempotency_key: key() }] })
    const unrelated = (await seedBatch(DAVE, { label: 'bb unrelated' })).id
    const item = await seedItem(DAVE, { name: 'bb fresh peppers', plantId: p.plantId, notes: 'Next time: pick earlier' })

    const r = await call(JEN, 'GET', `/api/kitchen-batches?plant_id=${p.plantId}`)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const byId = Object.fromEntries(r.body.batches.map((b) => [b.id, b]))
    expect(byId[direct]).toMatchObject({ used_via: 'garden', single_planting: true })
    expect(byId[direct].next_time.map((n) => n.note)).toEqual(['Next time: more garlic'])
    expect(byId[indirect]).toMatchObject({ used_via: 'jar' })
    expect(byId[unrelated]).toBeUndefined()
    expect(r.body.kept_fresh).toEqual([expect.objectContaining({ id: item, name: 'bb fresh peppers', next_time: ['Next time: pick earlier'] })])

    const s = await call(STRANGER, 'GET', `/api/kitchen-batches?plant_id=${p.plantId}`)
    expect(s.status).toBe(404)
  })
})

describe('POST /:id/close with a When — a make with nothing kept, logged afterwards', () => {
  it('the finished row carries the chosen day and precision; Not sure stores no date', async () => {
    const b = (await seedBatch(DAVE, { label: 'bb gone at the event' })).id
    const r = await call(DAVE, 'POST', `/api/kitchen-batches/${b}/close`, { outcome: 'given_away', when: { date: '2026-10-09', precision: 'day' } })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const [f] = await directSql`SELECT entered_at, entered_precision FROM kitchen_stage_log WHERE batch_id = ${b} AND stage_kind = 'finished'`
    expect(f.entered_precision).toBe('day')
    expect(new Date(f.entered_at).toISOString()).toBe('2026-10-09T16:00:00.000Z')
    const b2 = (await seedBatch(DAVE)).id
    expect((await call(JEN, 'POST', `/api/kitchen-batches/${b2}/close`, { outcome: 'consumed', when: { date: null, precision: 'unknown' } })).status).toBe(200)
    const [f2] = await directSql`SELECT entered_at, entered_precision FROM kitchen_stage_log WHERE batch_id = ${b2} AND stage_kind = 'finished'`
    expect(f2).toMatchObject({ entered_at: null, entered_precision: 'unknown' })
    const b3 = (await seedBatch(DAVE)).id
    expect((await call(STRANGER, 'POST', `/api/kitchen-batches/${b3}/close`, { outcome: 'consumed' })).status).toBe(404)
  })
})
