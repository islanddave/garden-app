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

  // Put-Up UX pass R1 amended this test: Went bad with a count was a 400 here ("Went bad is all that is left") and
  // wrote nothing; it is a 201 now and writes its use. fate 'batch' and STRANGER are still refused and write nothing.
  it('Gave it away takes a count, and so does Went bad (201); fate batch → 400; STRANGER → 404; the refusals write nothing', async () => {
    const jar = await seedJar(DAVE, { count: 4 })
    const g = await useTap(DAVE, { preservation_log_id: jar, count_used: 2, fate: 'given_away' })
    expect(g.status).toBe(201)
    expect((await readJar(jar)).remaining_count).toBe(2)
    expect((await useTap(DAVE, { preservation_log_id: jar, count_used: 1, fate: 'discarded' })).status).toBe(201)
    expect((await useTap(DAVE, { preservation_log_id: jar, count_used: 1, fate: 'batch' })).status).toBe(400)
    expect((await useTap(STRANGER, { preservation_log_id: jar, count_used: 1, fate: 'given_away' })).status).toBe(404)
    expect((await usesOf(jar)).map((u) => [u.count_used, u.fate])).toEqual([[2, 'given_away'], [1, 'discarded']])
    expect((await readJar(jar)).remaining_count).toBe(1)
  })

  it('over-use of a gift → 409 only_n_left', async () => {
    const jar = await seedJar(DAVE, { count: 2 })
    const r = await useTap(JEN, { preservation_log_id: jar, count_used: 3, fate: 'given_away' })
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ code: 'only_n_left', n: 2 })
  })
})

// ── Put-Up UX pass R1: Went bad may be a COUNT, not only all that is left ────────────────────────────────────────
// QA seat section 5(a), its cases 1 to 12, each on its own jar and each reading the stored rows back. Case 6 (the
// old client's body, { all_remaining: true, fate: 'discarded' }) is the first test of this file, unedited. The server
// has no weighed-specific rule: a weighed bag is one container, so a count of 1 is all of it and 2 is only_n_left.
describe('POST /api/pantry/uses — Went bad as a count (Put-Up UX pass R1)', () => {
  const discard = (user, jar, body) => useTap(user, { preservation_log_id: jar, fate: 'discarded', ...body })
  const listed = async (jar) => (await call(DAVE, 'GET', '/api/pantry')).body.rows.find((x) => x.stock_id === jar)

  it('1 · JEN discards one of Dave\'s four: 201, the use is hers, 3 left and not consumed, delta_at stamped, listed with 3', async () => {
    const jar = await seedJar(DAVE, { count: 4 })
    const r = await discard(JEN, jar, { count_used: 1 })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.use).toMatchObject({ count_used: 1, fate: 'discarded', created_by: JEN })
    expect((await usesOf(jar)).map((u) => [u.count_used, u.fate, u.created_by])).toEqual([[1, 'discarded', JEN]])
    const j = await readJar(jar)
    expect(j.remaining_count).toBe(3)
    expect(j.consumed_at).toBeNull()
    expect(j.delta_at).not.toBeNull()
    expect(await listed(jar)).toMatchObject({ stock_mode: 'counted', count_left: 3, count_made: 4 })
  })

  it('2 · that discard undone: 200, the reversing row (−1, discarded, reverses_use_id), 4 again; a second Undo under a new key → 409 already_undone', async () => {
    const jar = await seedJar(DAVE, { count: 4 })
    const u = await discard(JEN, jar, { count_used: 1 })
    expect(u.status, JSON.stringify(u.body)).toBe(201)
    const r = await undo(DAVE, u.body.use.id)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.use).toMatchObject({ count_used: -1, fate: 'discarded', reverses_use_id: u.body.use.id, created_by: DAVE })
    expect((await usesOf(jar)).map((x) => [x.count_used, x.fate, x.reverses_use_id]))
      .toEqual([[1, 'discarded', null], [-1, 'discarded', u.body.use.id]])
    expect(await readJar(jar)).toMatchObject({ remaining_count: 4, consumed_at: null })
    const twice = await undo(JEN, u.body.use.id)
    expect(twice.status).toBe(409)
    expect(twice.body.code).toBe('already_undone')
    expect((await readJar(jar)).remaining_count).toBe(4)
    expect(await usesOf(jar)).toHaveLength(2)
  })

  it('3 · a count that is all of it: 0 left, consumed, off the Pantry list; undone, it is back on the list with its count', async () => {
    const jar = await seedJar(DAVE, { count: 2 })
    const u = await discard(DAVE, jar, { count_used: 2 })
    expect(u.status, JSON.stringify(u.body)).toBe(201)
    expect(u.body.use).toMatchObject({ count_used: 2, fate: 'discarded' })
    let j = await readJar(jar)
    expect(j.remaining_count).toBe(0)
    expect(j.consumed_at).not.toBeNull()
    expect(await listed(jar)).toBeUndefined()
    const r = await undo(DAVE, u.body.use.id)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.use).toMatchObject({ count_used: -2, fate: 'discarded', reverses_use_id: u.body.use.id })
    j = await readJar(jar)
    expect(j).toMatchObject({ remaining_count: 2, consumed_at: null })
    expect(await listed(jar)).toMatchObject({ count_left: 2 })
  })

  it('4 · a single counted one, either body: count_used 1 and all_remaining each write a use of 1 and leave it consumed', async () => {
    for (const body of [{ count_used: 1 }, { all_remaining: true }]) {
      // One container in a COUNT unit. (One container in a mass unit is a weighed bag: case 5.)
      const jar = await seedJar(DAVE, { count: 1, qty: 1, unit: 'jar' })
      const r = await discard(DAVE, jar, body)
      expect(r.status, JSON.stringify(r.body)).toBe(201)
      expect((await usesOf(jar)).map((u) => [u.count_used, u.fate]), JSON.stringify(body)).toEqual([[1, 'discarded']])
      const j = await readJar(jar)
      expect(j.remaining_count, JSON.stringify(body)).toBe(0)
      expect(j.consumed_at, JSON.stringify(body)).not.toBeNull()
      expect(j.remaining_amount, 'a counted jar has no grams to zero').toBeNull()
    }
  })

  it('5 · a weighed bag: a count of 2 → 409 {n:1}, nothing written; a count of 1 empties it (0 g, consumed); undone, its grams are the bag less its live weighed draws', async () => {
    const bag = await seedJar(DAVE, { weighed: true })                       // 100 g, one container
    const b = (await seedBatch(DAVE)).id
    const d = await call(DAVE, 'POST', `/api/kitchen-batches/${b}/inputs`, { inputs: [{ input_kind: 'put_up', idempotency_key: key(), preservation_log_id: bag, qty: 30, qty_unit: 'g' }] })
    expect(d.status, JSON.stringify(d.body)).toBe(201)
    const before = await readJar(bag)
    expect(Number(before.remaining_amount)).toBe(70)
    const over = await discard(DAVE, bag, { count_used: 2 })
    expect(over.status).toBe(409)
    expect(over.body).toMatchObject({ code: 'only_n_left', n: 1 })
    expect(await usesOf(bag)).toHaveLength(0)
    expect(await readJar(bag)).toEqual(before)
    const u = await discard(DAVE, bag, { count_used: 1 })
    expect(u.status, JSON.stringify(u.body)).toBe(201)
    let j = await readJar(bag)
    expect(j.remaining_count).toBe(0)
    expect(Number(j.remaining_amount)).toBe(0)
    expect(j.consumed_at).not.toBeNull()
    const r = await undo(DAVE, u.body.use.id)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.use).toMatchObject({ count_used: -1, fate: 'discarded' })
    j = await readJar(bag)
    expect(Number(j.remaining_amount)).toBe(70)
    expect(j.remaining_count).toBe(1)
    expect(j.consumed_at).toBeNull()
  })

  it('7 · STRANGER sends the new body at Dave\'s jar: 404, no use written, the jar untouched', async () => {
    const jar = await seedJar(DAVE, { count: 3 })
    const before = await readJar(jar)
    const r = await discard(STRANGER, jar, { count_used: 1 })
    expect(r.status).toBe(404)
    expect(r.body.code).toBe('not_found')
    expect(await usesOf(jar)).toHaveLength(0)
    expect(await readJar(jar)).toEqual(before)
  })

  it('8 · more than is left (3 of the 2 left): 409 only_n_left {n:2}, nothing written', async () => {
    const jar = await seedJar(DAVE, { count: 3, remaining: 2 })
    const before = await readJar(jar)
    const r = await discard(DAVE, jar, { count_used: 3 })
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ code: 'only_n_left', n: 2 })
    expect(await usesOf(jar)).toHaveLength(0)
    expect(await readJar(jar)).toEqual(before)
  })

  it('9 · two partial discards, then the FIRST undone: the ledger composes in any order (5 − 1 − 2 + 1 = 3)', async () => {
    const jar = await seedJar(DAVE, { count: 5 })
    const a = await discard(DAVE, jar, { count_used: 1 })
    const b = await discard(JEN, jar, { count_used: 2 })
    expect([a.status, b.status]).toEqual([201, 201])
    expect((await readJar(jar)).remaining_count).toBe(2)
    const r = await undo(DAVE, a.body.use.id)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect((await readJar(jar)).remaining_count).toBe(3)
    expect((await usesOf(jar)).map((u) => [u.count_used, u.fate, u.reverses_use_id])).toEqual([
      [1, 'discarded', null], [2, 'discarded', null], [-1, 'discarded', a.body.use.id],
    ])
    // The second is still its own to undo, and the jar is whole again.
    expect((await undo(JEN, b.body.use.id)).status).toBe(200)
    expect(await readJar(jar)).toMatchObject({ remaining_count: 5, consumed_at: null })
  })

  it('10 · Remove after a partial discard: 409 jar_was_used with the count; both paths its sentence names still work', async () => {
    const jar = await seedJar(DAVE, { count: 3 })
    const u = await discard(DAVE, jar, { count_used: 1 })
    expect(u.status, JSON.stringify(u.body)).toBe(201)
    const r = await call(JEN, 'DELETE', `/api/preservation/${jar}`)
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ code: 'jar_was_used', n: 1 })
    expect(r.body.error).toBe('1 was used — mark the rest Went bad, or undo that use.')
    expect((await readJar(jar)).deleted_at).toBeNull()
    // "undo that use": then it removes.
    expect((await undo(DAVE, u.body.use.id)).status).toBe(200)
    expect((await call(JEN, 'DELETE', `/api/preservation/${jar}`)).status).toBe(200)
    expect((await readJar(jar)).deleted_at).not.toBeNull()
    // "mark the rest Went bad": on a second jar the rest goes in one tap, with the old client's body.
    const other = await seedJar(DAVE, { count: 3 })
    expect((await discard(DAVE, other, { count_used: 1 })).status).toBe(201)
    const rest = await discard(DAVE, other, { all_remaining: true })
    expect(rest.status, JSON.stringify(rest.body)).toBe(201)
    expect(rest.body.use).toMatchObject({ count_used: 2, fate: 'discarded' })
    expect((await readJar(other)).remaining_count).toBe(0)
  })

  it('11 · the same key twice: 201, then 200 replayed with the same use; one use row, the count moved once', async () => {
    const jar = await seedJar(DAVE, { count: 3 })
    const k = key()
    const first = await discard(DAVE, jar, { idempotency_key: k, count_used: 1 })
    expect(first.status, JSON.stringify(first.body)).toBe(201)
    const again = await discard(DAVE, jar, { idempotency_key: k, count_used: 1 })
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ replayed: true, use: { id: first.body.use.id, count_used: 1, fate: 'discarded' } })
    const uses = await usesOf(jar)
    expect(uses).toHaveLength(1)
    expect(uses[0]).toMatchObject({ count_used: 1, fate: 'discarded', idempotency_key: k })
    expect((await readJar(jar)).remaining_count).toBe(2)
  })

  it('12 · a jar a batch line drew from: draw 1 of 3, discard 1 → 1 left; the line taken out → 2; the discard undone → 3, never past what was made', async () => {
    const jar = await seedJar(DAVE, { count: 3 })
    const b = (await seedBatch(DAVE)).id
    const lineKey = key()
    const d = await call(DAVE, 'POST', `/api/kitchen-batches/${b}/inputs`, { inputs: [{ input_kind: 'put_up', idempotency_key: lineKey, preservation_log_id: jar, count_drawn: 1 }] })
    expect(d.status, JSON.stringify(d.body)).toBe(201)
    expect((await readJar(jar)).remaining_count).toBe(2)
    const u = await discard(JEN, jar, { count_used: 1 })
    expect(u.status, JSON.stringify(u.body)).toBe(201)
    expect((await readJar(jar)).remaining_count).toBe(1)
    const [line] = await directSql`SELECT id FROM kitchen_batch_input WHERE idempotency_key = ${lineKey}::uuid`
    const out = await call(DAVE, 'DELETE', `/api/kitchen-batches/${b}/inputs/${line.id}`)
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect((await readJar(jar)).remaining_count).toBe(2)
    // chk_preservation_log_remaining_within_package never trips: the two ledgers give back exactly what they took.
    const back = await undo(JEN, u.body.use.id)
    expect(back.status, JSON.stringify(back.body)).toBe(200)
    expect(await readJar(jar)).toMatchObject({ package_count: 3, remaining_count: 3, consumed_at: null })
    expect((await usesOf(jar)).map((x) => [x.count_used, x.fate]))
      .toEqual([[1, 'batch'], [1, 'discarded'], [-1, 'batch'], [-1, 'discarded']])
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
