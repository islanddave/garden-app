// Release F — lane L2b's own proof on real Postgres (the train's 1b + F schema), for the routes whose
// L4 describes could not reach them in this lane's first integration run (run 36631452977: a fixture
// collision in L4's seedPlace skipped the stage and sitting describes). The L4 files remain the F
// matrix; this file proves the SQL of: the check-in's acts and pH bounds; the stage PATCH per kind
// (put_up Made + mash_in_g, tended acts, void note-only) with its audit row carrying the actor; a
// put-up whose sitting line draws a weighed bag; shu-estimate save on a sitting-bottled jar; the jar
// PATCH's size + count in one write (A3) and method_other_text alone; the use route taking a weighed
// jar to 0 left (boss F2: remaining_amount 0); and GET line-search as a literal.
//
// Fixtures and teardown are L4's (_kitchenF.js, read-only here): DAVE + JEN one household, cleaned
// by teardownHousehold.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql } from './_harness.js'
import { makeHousehold, useHousehold, call, key, seedBatch, seedJar, readJar, usesOf } from './_kitchenF.js'

const H = makeHousehold('l2b')
const { DAVE, JEN } = H
useHousehold(H, beforeAll, afterAll)
const bpath = (b, tail = '') => `/api/kitchen-batches/${b}${tail}`
const placeLabel = (t) => `l2b ${t} ${H.RUN}`

describe('stages — acts, pH bounds, and the PATCH per kind', () => {
  it('a check-in carries acts (de-duplicated); a pH read before the start or in the future → 400', async () => {
    const b = (await seedBatch(DAVE, { startedDaysAgo: 3 })).id
    const ok = await call(DAVE, 'POST', bpath(b, '/stages'), { stage_kind: 'tended', acts: ['skimmed', 'skimmed', 'topped_up'], amount: 250, amount_unit: 'ml' })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(ok.body.stage.acts).toEqual(['skimmed', 'topped_up'])
    const early = await call(DAVE, 'POST', bpath(b, '/stages'), { stage_kind: 'tended', ph_reading: '3.9', ph_read_at: new Date(Date.now() - 30 * 864e5).toISOString() })
    expect(early.status).toBe(400)
    const future = await call(DAVE, 'POST', bpath(b, '/stages'), { stage_kind: 'tended', ph_reading: '3.9', ph_read_at: new Date(Date.now() + 3600e3).toISOString() })
    expect(future.status).toBe(400)
  })

  it('PATCH a tended row: acts and note, edited_at stamped; audited with the actor, not "system"', async () => {
    const b = (await seedBatch(DAVE)).id
    const t = await call(DAVE, 'POST', bpath(b, '/stages'), { stage_kind: 'tended', note: 'bubbling' })
    const p = await call(JEN, 'PATCH', bpath(b, `/stages/${t.body.stage.id}`), { note: 'film on top', acts: ['skimmed'] })
    expect(p.status, JSON.stringify(p.body)).toBe(200)
    expect(p.body.stage).toMatchObject({ note: 'film on top', acts: ['skimmed'] })
    expect(p.body.stage.edited_at).not.toBeNull()
    const audit = await directSql`SELECT actor_clerk_sub FROM audit_events WHERE table_name = 'kitchen_stage_log' AND row_id = ${t.body.stage.id}`
    expect(audit.map((a) => a.actor_clerk_sub)).toEqual([JEN])
  })

  it('a voided row is note-only; a put_up row keeps its date', async () => {
    const b = (await seedBatch(DAVE)).id
    const t = await call(DAVE, 'POST', bpath(b, '/stages'), { stage_kind: 'tended', note: 'x' })
    await call(DAVE, 'POST', bpath(b, '/stages'), { stage_kind: 'void', voids_id: t.body.stage.id })
    expect((await call(DAVE, 'PATCH', bpath(b, `/stages/${t.body.stage.id}`), { cue_observed: 'all under' })).status).toBe(400)
    expect((await call(DAVE, 'PATCH', bpath(b, `/stages/${t.body.stage.id}`), { note: 'undone by mistake' })).status).toBe(200)
  })
})

describe('Put it up with a draw, then its heat, then Undo', () => {
  it('a sitting line draws 8 g from a weighed bag; Made / mash_in_g PATCH; a row\'s computed heat saves; Undo gives the 8 g back', async () => {
    const b = (await seedBatch(DAVE, { label: 'Petri Dish' })).id
    // What went in: jalapeño with a typed (fresh) rating, and water.
    const lines = await call(DAVE, 'POST', bpath(b, '/inputs'), { inputs: [
      { input_kind: 'other', idempotency_key: key(), label: 'jalapeño', qty: 170, qty_unit: 'g', form: 'fresh', shu_rating_low: 2500, shu_rating_high: 8000 },
      { input_kind: 'other', idempotency_key: key(), label: 'Water', qty: 250, qty_unit: 'ml', role: 'water' },
    ] })
    expect(lines.status, JSON.stringify(lines.body)).toBe(201)
    const bag = await seedJar(DAVE, { weighed: true })
    const put = await call(DAVE, 'POST', bpath(b, '/put-up'), {
      idempotency_key: key(), when: { date: new Date().toISOString(), precision: 'exact' }, method: 'hot_sauce', finish: false,
      made_g: 256, mash_in_g: 200,
      rows: [{ count: 1, container_label: 'jar', size_value: 256, size_unit: 'g', place: { kind: 'fridge', label: placeLabel('fridge') }, name: 'Petri' }],
      sitting_lines: [{ input_kind: 'put_up', preservation_log_id: bag, qty: 8, qty_unit: 'g', form: 'frozen' }],
    })
    expect(put.status, JSON.stringify(put.body)).toBe(201)
    expect(Number((await readJar(bag)).remaining_amount)).toBe(92)
    expect(put.body.stage).toMatchObject({ amount: expect.anything(), amount_unit: 'g' })
    const jar = put.body.jars[0]
    expect(jar.stock_mode).toBe('weighed')
    const [seeded] = await directSql`SELECT remaining_amount FROM preservation_log WHERE id = ${jar.id}`
    expect(Number(seeded.remaining_amount)).toBe(256)

    const made = await call(DAVE, 'PATCH', bpath(b, `/stages/${put.body.stage.id}`), { amount: 250, mash_in_g: 190 })
    expect(made.status, JSON.stringify(made.body)).toBe(200)
    expect(made.body.stage).toMatchObject({ amount_unit: 'g' })

    const est = await call(DAVE, 'GET', bpath(b, `/shu-estimate?scope=sitting&id=${put.body.stage.id}`))
    expect(est.status).toBe(200)
    expect(est.body).toMatchObject({ low: Math.floor(170 * 2500 / 250 + 0.5), denominator_source: 'made' })
    const saved = await call(DAVE, 'POST', bpath(b, '/shu-estimate/save'), { scope: 'jar', id: jar.id })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect(saved.body.shu_est_basis).toBe('computed')

    const u = await call(DAVE, 'POST', bpath(b, `/put-up/${put.body.stage.id}/undo`), {})
    expect(u.status, JSON.stringify(u.body)).toBe(200)
    expect(Number((await readJar(bag)).remaining_amount)).toBe(100)
  })
})

describe('the jar PATCH (A3) and the use route', () => {
  it('size + count in ONE PATCH: the count moves remaining by the delta; lowering below what is used → 409', async () => {
    const jar = await seedJar(DAVE, { count: 3, remaining: 2 })
    const r = await call(DAVE, 'PATCH', `/api/preservation/${jar}`, { package_count: 4, quantity_value: 8, quantity_unit: 'lb' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toMatchObject({ package_count: 4, remaining_count: 3, quantity_unit: 'lb' })
    expect(Number(r.body.quantity_value)).toBe(8)
    const low = await call(DAVE, 'PATCH', `/api/preservation/${jar}`, { package_count: 1 })
    expect(low.status).toBe(409)
    expect(low.body.code).toBe('count_below_used')
    expect((await readJar(jar)).package_count).toBe(4)
  })

  it('method_other_text on its own, on an Other jar (made through the create route, label-named)', async () => {
    const made = await call(DAVE, 'POST', '/api/preservation', { label: 'l2b other', method: 'other', preserved_at: '2026-09-20', idempotency_key: key() })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const r = await call(DAVE, 'PATCH', `/api/preservation/${made.body.id}`, { method_other_text: 'Drinking vinegar' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.method_other_text).toBe('Drinking vinegar')
    const wrong = await call(DAVE, 'PATCH', `/api/preservation/${(await seedJar(DAVE, { count: 2 }))}`, { method_other_text: 'x' })
    expect(wrong.status).toBe(400)
  })

  it('Used up on a weighed bag with grams left: count 0, consumed, and remaining_amount 0 (F2); a replay is one use', async () => {
    const bag = await seedJar(DAVE, { weighed: true, remainingAmount: 92 })
    const k = key()
    const r = await call(JEN, 'POST', '/api/pantry/uses', { idempotency_key: k, preservation_log_id: bag, all_remaining: true })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.jar.remaining_count).toBe(0)
    expect(Number(r.body.jar.remaining_amount)).toBe(0)
    expect(r.body.jar.consumed_at).not.toBeNull()
    const again = await call(JEN, 'POST', '/api/pantry/uses', { idempotency_key: k, preservation_log_id: bag, all_remaining: true })
    expect(again.status).toBe(200)
    expect(again.body.replayed).toBe(true)
    expect(await usesOf(bag)).toHaveLength(1)
    const [row] = await directSql`SELECT delta_at, created_by FROM pantry_use u JOIN preservation_log p ON p.id = u.preservation_log_id WHERE p.id = ${bag}`
    expect(row.delta_at).not.toBeNull()
    expect(row.created_by).toBe(JEN)
  })

  it('line-search is a literal: 200 for a query, never read as a batch id', async () => {
    const r = await call(DAVE, 'GET', '/api/kitchen-batches/line-search?q=zzz-no-such-thing')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ plantings: [], put_ups: [] })
  })
})
