// Put-Up release 4 — the recipe rung of the discard-by rule on real Postgres (V4 §3.1, §3.2, §3.4), through the real
// Put it up route and Move: a batch following a recipe whose keeps line is "Fridge · 7 days" puts up a fridge jar
// with basis 'recipe' and date = put-up day + 7; a freezer jar in the same sitting falls through to the table; a
// typed date beats the recipe; a Move to another storage kind nulls the recipe date, a move within the kind keeps
// it. DAVE + JEN one household (JEN puts up from DAVE's recipe); STRANGER cannot name the recipe on a batch.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql } from './_harness.js'
import { settle } from './_cleanup.js'
import { makeHousehold, useHousehold, call, key } from './_kitchenF.js'

const H = makeHousehold('rcpb')
const { DAVE, JEN, STRANGER } = H
useHousehold(H, beforeAll, afterAll)
afterAll(async () => {
  const ids = [DAVE, JEN, STRANGER]
  await settle(`recipes-basis teardown ${H.RUN}`, [
    () => directSql`UPDATE kitchen_batch SET recipe_id = NULL WHERE recipe_id IN (SELECT id FROM recipe WHERE user_id = ANY(${ids}))`,
    () => directSql`DELETE FROM recipe_ingredient WHERE recipe_id IN (SELECT id FROM recipe WHERE user_id = ANY(${ids}))`,
    () => directSql`DELETE FROM recipe WHERE user_id = ANY(${ids})`,
  ])
})

const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10) }
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10))

describe('Put it up from a batch that follows a recipe', () => {
  let batchId
  let fridgeJar
  const DAY = '2026-10-09'
  beforeAll(async () => {
    const r = await call(DAVE, 'POST', '/api/recipes', {
      idempotency_key: key(), name: `Roll for Initiative ${H.RUN}`, keeps: { n: 7, unit: 'day', storage_kind: 'fridge' },
    })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    const b = await call(JEN, 'POST', '/api/kitchen-batches', {
      label: `Mojo ${H.RUN}`, recipe_id: r.body.recipe.id, started_at: '2026-10-01T16:00:00.000Z', start_precision: 'day', idempotency_key: key(),
    })
    expect(b.status, JSON.stringify(b.body)).toBe(201)
    batchId = b.body.id
    expect((await call(STRANGER, 'POST', '/api/kitchen-batches', { label: 'x', recipe_id: r.body.recipe.id })).status).toBe(400)
  })

  it('fridge row → basis recipe, day + 7; freezer row → the table; a typed row → typed', async () => {
    const put = await call(JEN, 'POST', `/api/kitchen-batches/${batchId}/put-up`, {
      idempotency_key: key(), when: { date: DAY, precision: 'day' }, method: 'hot_sauce', finish: false,
      rows: [
        { count: 1, container_label: '8 oz woozy', size_value: 8, size_unit: 'fl oz', place: { kind: 'fridge', label: `rcpb fridge ${H.RUN}` } },
        { count: 1, place: { kind: 'deep_freezer', label: `rcpb freezer ${H.RUN}` } },
        { count: 1, place: { kind: 'fridge', label: `rcpb fridge ${H.RUN}` }, discard_by: '2026-10-12' },
      ],
    })
    expect(put.status, JSON.stringify(put.body)).toBe(201)
    // The jars come back in the rows' order: the jars CTE steps created_at 1 µs per row and readSitting orders
    // by it (one statement's shared now() used to hand them back in uuid order).
    const jars = put.body.jars
    expect(jars.map((j) => j.storage_kind)).toEqual(['fridge', 'deep_freezer', 'fridge'])
    expect(jars[0]).toMatchObject({ use_by_basis: 'recipe' })
    expect(ymd(jars[0].use_by_target)).toBe(addDays(DAY, 7))
    expect(jars[1].use_by_basis).toBe('table')
    expect(ymd(jars[1].use_by_target)).not.toBe(addDays(DAY, 7))
    expect(jars[2]).toMatchObject({ use_by_basis: 'typed' })
    expect(ymd(jars[2].use_by_target)).toBe('2026-10-12')
    fridgeJar = jars[0].id
  })

  it('a move within the fridge kind keeps the recipe date; a move to the freezer nulls it (basis none)', async () => {
    // Set by the case above. Without it the path is /api/preservation/undefined/move, which no jar route
    // claims (uuid ids only) and which falls to the create POST's 400 — a misleading second failure.
    expect(fridgeJar, 'the put-up case above did not yield its fridge jar').toBeTruthy()
    const within = await call(DAVE, 'POST', `/api/preservation/${fridgeJar}/move`, { place: { kind: 'fridge', label: `rcpb fridge two ${H.RUN}` } })
    expect(within.status, JSON.stringify(within.body)).toBe(200)
    expect(within.body.use_by_basis).toBe('recipe')
    expect(ymd(within.body.use_by_target)).toBe(addDays(DAY, 7))
    const out = await call(JEN, 'POST', `/api/preservation/${fridgeJar}/move`, { place: { kind: 'deep_freezer', label: `rcpb freezer ${H.RUN}` } })
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    expect(out.body).toMatchObject({ use_by_target: null, use_by_basis: 'none' })
  })

  it('a removed recipe no longer decides new jars (the rung reads live recipes only)', async () => {
    const [{ recipe_id: rid }] = await directSql`SELECT recipe_id FROM kitchen_batch WHERE id = ${batchId}`
    expect((await call(DAVE, 'DELETE', `/api/recipes/${rid}`)).status).toBe(200)
    const put = await call(JEN, 'POST', `/api/kitchen-batches/${batchId}/put-up`, {
      idempotency_key: key(), when: { date: DAY, precision: 'day' }, method: 'hot_sauce', finish: false,
      rows: [{ count: 1, place: { kind: 'fridge', label: `rcpb fridge ${H.RUN}` } }],
    })
    expect(put.status, JSON.stringify(put.body)).toBe(201)
    expect(put.body.jars[0].use_by_basis).not.toBe('recipe')
  })
})
