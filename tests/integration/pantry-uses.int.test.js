// Put-Up release 2 (B′) — the use fates, the use undo and Remove on a put-up, on real Postgres (the train's
// 1b + F + 2 schema): POST /api/pantry/uses with fate discarded / given_away, POST /api/pantry/uses/:id/undo,
// and DELETE /api/preservation/:id's refusals. DAVE + JEN one household, STRANGER outside, per route.
// Fixtures and teardown are _kitchenF.js's (no pantry_item rows are written here).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql } from './_harness.js'
import {
  makeHousehold, useHousehold, call, key, seedBatch, seedJar, seedLine, readJar, usesOf,
} from './_kitchenF.js'

const H = makeHousehold('pantry-uses')
const { DAVE, JEN, STRANGER } = H
useHousehold(H, beforeAll, afterAll)

const useTap = (user, body) => call(user, 'POST', '/api/pantry/uses', { idempotency_key: key(), ...body })
const undo = (user, useId, k = key()) => call(user, 'POST', `/api/pantry/uses/${useId}/undo`, { idempotency_key: k })

describe('POST /api/pantry/uses — Went bad and Gave it away', () => {
  it('JEN: Went bad on Dave\'s jar takes all that is left, fate discarded, consumed, delta_at stamped', async () => {
    const jar = await seedJar(DAVE, { count: 3, remaining: 2 })
    const r = await useTap(JEN, { preservation_log_id: jar, all_remaining: true, fate: 'discarded' })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.use).toMatchObject({ count_used: 2, fate: 'discarded', created_by: JEN })
    const j = await readJar(jar)
    expect(j.remaining_count).toBe(0)
    expect(j.consumed_at).not.toBeNull()
    expect(j.delta_at).not.toBeNull()
  })

  it('Gave it away takes a count; Went bad with a count → 400; STRANGER → 404; nothing written by the refusals', async () => {
    const jar = await seedJar(DAVE, { count: 4 })
    const g = await useTap(DAVE, { preservation_log_id: jar, count_used: 2, fate: 'given_away' })
    expect(g.status).toBe(201)
    expect((await readJar(jar)).remaining_count).toBe(2)
    expect((await useTap(DAVE, { preservation_log_id: jar, count_used: 1, fate: 'discarded' })).status).toBe(400)
    expect((await useTap(DAVE, { preservation_log_id: jar, count_used: 1, fate: 'batch' })).status).toBe(400)
    expect((await useTap(STRANGER, { preservation_log_id: jar, count_used: 1, fate: 'given_away' })).status).toBe(404)
    expect((await usesOf(jar)).map((u) => [u.count_used, u.fate])).toEqual([[2, 'given_away']])
  })

  it('over-use of a gift → 409 only_n_left', async () => {
    const jar = await seedJar(DAVE, { count: 2 })
    const r = await useTap(JEN, { preservation_log_id: jar, count_used: 3, fate: 'given_away' })
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ code: 'only_n_left', n: 2 })
  })
})

describe('POST /api/pantry/uses/:id/undo', () => {
  it('JEN undoes Dave\'s Used one: 200, the reversing row (−1, same fate, reverses_use_id), count back, delta_at stamped', async () => {
    const jar = await seedJar(DAVE, { count: 3 })
    const u = await useTap(DAVE, { preservation_log_id: jar, count_used: 1 })
    const k = key()
    const r = await undo(JEN, u.body.use.id, k)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.use).toMatchObject({ count_used: -1, fate: null, reverses_use_id: u.body.use.id, created_by: JEN })
    expect(r.body.jar).toMatchObject({ id: jar, remaining_count: 3, consumed_at: null })
    expect((await usesOf(jar)).map((x) => x.count_used)).toEqual([1, -1])
    // the same key again → a replay; another key → 409 already_undone; nothing moves twice
    const again = await undo(JEN, u.body.use.id, k)
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ replayed: true, use: { id: r.body.use.id } })
    const twice = await undo(DAVE, u.body.use.id)
    expect(twice.status).toBe(409)
    expect(twice.body.code).toBe('already_undone')
    expect((await readJar(jar)).remaining_count).toBe(3)
    expect(await usesOf(jar)).toHaveLength(2)
  })

  it('Went bad, undone: the jar is live again (consumed cleared) and back on the Pantry list', async () => {
    const jar = await seedJar(DAVE, { count: 2 })
    const u = await useTap(DAVE, { preservation_log_id: jar, all_remaining: true, fate: 'discarded' })
    let rows = (await call(DAVE, 'GET', '/api/pantry')).body.rows
    expect(rows.some((x) => x.stock_id === jar)).toBe(false)
    const r = await undo(DAVE, u.body.use.id)
    expect(r.status).toBe(200)
    expect(r.body.use.fate).toBe('discarded')
    const j = await readJar(jar)
    expect(j).toMatchObject({ remaining_count: 2, consumed_at: null })
    rows = (await call(DAVE, 'GET', '/api/pantry')).body.rows
    expect(rows.find((x) => x.stock_id === jar)).toMatchObject({ count_left: 2 })
  })

  it('Used up on a weighed bag, undone: its grams come back as the bag less its live weighed draws', async () => {
    const bag = await seedJar(DAVE, { weighed: true })                       // 100 g, never drawn
    const b = (await seedBatch(DAVE)).id
    const d = await call(DAVE, 'POST', `/api/kitchen-batches/${b}/inputs`, { inputs: [{ input_kind: 'put_up', idempotency_key: key(), preservation_log_id: bag, qty: 30, qty_unit: 'g' }] })
    expect(d.status, JSON.stringify(d.body)).toBe(201)
    expect(Number((await readJar(bag)).remaining_amount)).toBe(70)
    const u = await useTap(DAVE, { preservation_log_id: bag, all_remaining: true })
    expect(Number((await readJar(bag)).remaining_amount)).toBe(0)
    const r = await undo(DAVE, u.body.use.id)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const j = await readJar(bag)
    expect(Number(j.remaining_amount)).toBe(70)
    expect(j.remaining_count).toBe(1)
    expect(j.consumed_at).toBeNull()
  })

  it('a batch-linked use is refused (409 use_is_batch_line); a reversal cannot be undone; STRANGER → 404', async () => {
    const jar = await seedJar(DAVE, { count: 3 })
    const b = (await seedBatch(DAVE)).id
    const d = await call(DAVE, 'POST', `/api/kitchen-batches/${b}/inputs`, { inputs: [{ input_kind: 'put_up', idempotency_key: key(), preservation_log_id: jar, count_drawn: 1 }] })
    expect(d.status).toBe(201)
    const [batchUse] = await directSql`SELECT id FROM pantry_use WHERE preservation_log_id = ${jar} AND fate = 'batch'`
    const r = await undo(DAVE, batchUse.id)
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('use_is_batch_line')
    const u = await useTap(DAVE, { preservation_log_id: jar, count_used: 1 })
    expect((await undo(STRANGER, u.body.use.id)).status).toBe(404)
    const rev = await undo(JEN, u.body.use.id)
    expect((await undo(DAVE, rev.body.use.id)).body.code).toBe('use_is_reversal')
    expect((await readJar(jar)).remaining_count).toBe(2)
  })

  it('a count lowered below what the undo would give back → 409 count_changed, nothing written', async () => {
    const jar = await seedJar(DAVE, { count: 3 })
    const u = await useTap(DAVE, { preservation_log_id: jar, count_used: 1 })
    await directSql`UPDATE preservation_log SET package_count = 2 WHERE id = ${jar}`   // 2 of 2 left now
    const r = await undo(DAVE, u.body.use.id)
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('count_changed')
    expect(await usesOf(jar)).toHaveLength(1)
  })
})

describe('DELETE /api/preservation/:id — Remove on a put-up (V4 §2.5)', () => {
  it('a jar that was used → 409 jar_was_used with the path; undo the use and it removes', async () => {
    const jar = await seedJar(DAVE, { count: 3 })
    const u = await useTap(JEN, { preservation_log_id: jar, count_used: 1 })
    const r = await call(DAVE, 'DELETE', `/api/preservation/${jar}`)
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ code: 'jar_was_used', n: 1 })
    expect(r.body.error).toMatch(/Went bad, or undo that use/)
    expect((await readJar(jar)).deleted_at).toBeNull()
    await undo(JEN, u.body.use.id)
    expect((await call(DAVE, 'DELETE', `/api/preservation/${jar}`)).status).toBe(200)
    expect((await readJar(jar)).deleted_at).not.toBeNull()
  })

  it('a jar a live line draws from → 409 jar_in_batch naming the batch; take the line out and it removes', async () => {
    const b = (await seedBatch(DAVE, { label: `pantry remove ${H.RUN}` })).id
    const jar = await seedJar(DAVE, { count: 3 })
    const line = await seedLine(DAVE, b, { kind: 'put_up', jarId: jar })
    const r = await call(JEN, 'DELETE', `/api/preservation/${jar}`)
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('jar_in_batch')
    expect(r.body.error).toContain(`pantry remove ${H.RUN}`)
    await directSql`UPDATE kitchen_batch_input SET deleted_at = now() WHERE id = ${line}`
    expect((await call(JEN, 'DELETE', `/api/preservation/${jar}`)).status).toBe(200)
  })

  it('an untouched jar removes (200, soft); STRANGER → 404; a second DELETE → 404', async () => {
    const jar = await seedJar(DAVE, { count: 2 })
    expect((await call(STRANGER, 'DELETE', `/api/preservation/${jar}`)).status).toBe(404)
    expect((await call(DAVE, 'DELETE', `/api/preservation/${jar}`)).status).toBe(200)
    expect((await call(DAVE, 'DELETE', `/api/preservation/${jar}`)).status).toBe(404)
    const [row] = await directSql`SELECT deleted_at FROM preservation_log WHERE id = ${jar}`
    expect(row.deleted_at).not.toBeNull()
  })
})
