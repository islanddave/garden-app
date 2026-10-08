// Put-Up release 4 — the recipe library on real Postgres (the train's schema: 1b → F → 2 → 3 → v5-recipes-001),
// through the real preservation handler, DAVE + JEN one household and STRANGER outside it, per route (V4 §5.3:
// "proven by execution per route"). Written against the harness without a database in this lane; the orchestrator
// runs it in CI (integration-test.yml applies the train's 0a files to the ephemeral fork).
//
//   /api/recipes             GET list, POST keyed create (replay, key held elsewhere, link scheme, the CHECK)
//   /api/recipes/:id         GET detail (notes verbatim; batches with no reading), PATCH, DELETE (soft)
//   /api/recipes/types[/:id] built-ins (16), find-or-create, household scope, soft delete + restore, built-in 409
//   POST /api/recipes/from-batch/:batchId  every F §1.5 column across; the batch linked; replay
//   POST /api/kitchen-batches recipe_id (household-loaded); GET batch carries `recipe` without its notes
//
// Fixtures and teardown are _kitchenF.js's (read-only here) plus this file's own recipe teardown.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql } from './_harness.js'
import { settle } from './_cleanup.js'
import { makeHousehold, useHousehold, call, key, seedBatch, seedLine } from './_kitchenF.js'

const H = makeHousehold('rcp')
const { DAVE, JEN, STRANGER } = H
useHousehold(H, beforeAll, afterAll)
// Recipes go after the household's batches (kitchen_batch.recipe_id → recipe, NO ACTION): null the pointers first
// so this teardown is correct whichever afterAll runs first.
afterAll(async () => {
  const ids = [DAVE, JEN, STRANGER]
  await settle(`recipes teardown ${H.RUN}`, [
    () => directSql`UPDATE kitchen_batch SET recipe_id = NULL WHERE recipe_id IN (SELECT id FROM recipe WHERE user_id = ANY(${ids}))`,
    () => directSql`DELETE FROM recipe_ingredient WHERE recipe_id IN (SELECT id FROM recipe WHERE user_id = ANY(${ids}))`,
    () => directSql`DELETE FROM recipe WHERE user_id = ANY(${ids})`,
    () => directSql`DELETE FROM recipe_type WHERE user_id = ANY(${ids})`,
  ])
})

const HOT_SAUCE = '7ec1be00-0000-4000-8000-000000000001'
const NOTES = `Mojo ${H.RUN}\n\n**Steps**\n1. Blend.\n   Keep this spacing.\n\n**Finish**\n- Fridge 7 days  `
const body = (over = {}) => ({
  idempotency_key: key(), name: `Roll for Initiative ${H.RUN}`, kind: 'ferment', recipe_type_id: HOT_SAUCE,
  link_url: 'https://example.com/mojo', notes: NOTES, keeps: { n: 7, unit: 'day', storage_kind: 'fridge' },
  vessel_label: 'quart jar', vessel_size: '1', vessel_unit: 'qt', vessel_count: 1,
  bottle_label: '8 oz woozy', bottle_size: '8', bottle_unit: 'fl oz', bottle_cooked: true, made_text: '228 g',
  lines: [
    { name: 'jalapeño', amount_text: '170 g fresh jalapeño', qty: '170.0', qty_unit: 'g', form: 'fresh', shu_rating_low: 2500, shu_rating_high: 8000 },
    { name: 'salt', amount_text: '20 g salt', qty: '20', qty_unit: 'g', role: 'salt', salt_pct: '2.5', salt_base: 'all', base_g: '800', salt_method: 'brine', base_from: 'lines' },
    { name: 'onion', amount_text: '20 g onion', at_the_end: true },
  ],
  ...over,
})

describe('POST /api/recipes + GET — household scope, replay, the link scheme', () => {
  let rid
  const k = key()
  it('DAVE creates (recipe + lines, one statement); JEN reads it; STRANGER gets not-found and an empty list', async () => {
    const c = await call(DAVE, 'POST', '/api/recipes', body({ idempotency_key: k }))
    expect(c.status, JSON.stringify(c.body)).toBe(201)
    rid = c.body.recipe.id
    expect(c.body.recipe).toMatchObject({ user_id: DAVE, type_label: 'Hot sauce', keeps_n: 7, keeps_unit: 'day', keeps_storage_kind: 'fridge', bottle_cooked: true })
    expect(c.body.recipe.lines.map((l) => [l.ordinal, l.name, l.at_the_end])).toEqual([[1, 'jalapeño', false], [2, 'salt', false], [3, 'onion', true]])
    const j = await call(JEN, 'GET', `/api/recipes/${rid}`)
    expect(j.status).toBe(200)
    expect(j.body.recipe.notes).toBe(NOTES)
    expect(j.body.recipe.lines[1]).toMatchObject({ role: 'salt', salt_base: 'all', salt_method: 'brine' })
    expect((await call(STRANGER, 'GET', `/api/recipes/${rid}`)).status).toBe(404)
    const sl = await call(STRANGER, 'GET', '/api/recipes')
    expect(sl.body.recipes.some((r) => r.id === rid)).toBe(false)
    const jl = await call(JEN, 'GET', '/api/recipes')
    const row = jl.body.recipes.find((r) => r.id === rid)
    expect(row).toMatchObject({ line_count: 3, batch_count: 0, type_label: 'Hot sauce' })
    expect(row).not.toHaveProperty('notes')
  })

  it('the same key again (JEN) is a replay: 200, the same recipe, one row; STRANGER with it → 409', async () => {
    const r = await call(JEN, 'POST', '/api/recipes', body({ idempotency_key: k, name: 'different' }))
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ replayed: true, recipe: { id: rid } })
    // BUG-PUTUPREPLAYDROPSEDIT-001: the two stamps the client reads off a replay are one instant on an untouched recipe.
    expect(Number.isFinite(new Date(r.body.recipe.created_at).getTime())).toBe(true)
    expect(new Date(r.body.recipe.updated_at).getTime()).toBe(new Date(r.body.recipe.created_at).getTime())
    const n = await directSql`SELECT count(*)::int AS n FROM recipe WHERE idempotency_key = ${k}::uuid`
    expect(n[0].n).toBe(1)
    const s = await call(STRANGER, 'POST', '/api/recipes', body({ idempotency_key: k }))
    expect(s.status).toBe(409)
    expect(s.body.code).toBe('key_conflict')
  })

  it('a javascript: / ftp: link → 400 from the route; the CHECK refuses it at the table too', async () => {
    for (const link_url of ['javascript:alert(1)', 'ftp://example.com/x', 'example.com']) {
      expect((await call(DAVE, 'POST', '/api/recipes', body({ link_url }))).status).toBe(400)
    }
    let err = null
    try { await directSql`INSERT INTO recipe (user_id, name, link_url) VALUES (${DAVE}, 'x', 'javascript:alert(1)')` } catch (e) { err = e }
    expect(String(err?.message ?? err?.sourceError?.message)).toMatch(/chk_recipe_link_url/)
  })

  it('a malformed key → 400; a STRANGER\'s type → 400', async () => {
    expect((await call(DAVE, 'POST', '/api/recipes', body({ idempotency_key: 'nope' }))).status).toBe(400)
    const t = await call(STRANGER, 'POST', '/api/recipes/types', { label: `Stranger type ${H.RUN}` })
    expect(t.status).toBe(201)
    expect((await call(DAVE, 'POST', '/api/recipes', body({ recipe_type_id: t.body.type.id }))).status).toBe(400)
  })

  it('JEN edits DAVE\'s recipe (presence-sentinel): keeps cleared, lines replaced, notes kept; the owner stays DAVE; STRANGER → 404', async () => {
    const p = await call(JEN, 'PATCH', `/api/recipes/${rid}`, { keeps: null, lines: [{ name: 'garlic', amount_text: '8 g garlic' }] })
    expect(p.status, JSON.stringify(p.body)).toBe(200)
    expect(p.body.recipe).toMatchObject({ user_id: DAVE, keeps_n: null, keeps_unit: null, keeps_storage_kind: null, notes: NOTES })
    expect(p.body.recipe.lines.map((l) => l.name)).toEqual(['garlic'])
    const all = await directSql`SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int AS live, count(*)::int AS n FROM recipe_ingredient WHERE recipe_id = ${rid}`
    expect(all[0]).toEqual({ live: 1, n: 4 })
    expect((await call(STRANGER, 'PATCH', `/api/recipes/${rid}`, { name: 'mine now' })).status).toBe(404)
    expect((await call(JEN, 'PATCH', `/api/recipes/${rid}`, { link_url: 'data:text/html,x' })).status).toBe(400)
  })

  it('DELETE is soft (the recipe and its lines); STRANGER → 404; then it is gone from reads', async () => {
    const d = await call(DAVE, 'POST', '/api/recipes', body())
    expect((await call(STRANGER, 'DELETE', `/api/recipes/${d.body.recipe.id}`)).status).toBe(404)
    expect((await call(JEN, 'DELETE', `/api/recipes/${d.body.recipe.id}`)).status).toBe(200)
    const [row] = await directSql`SELECT deleted_at FROM recipe WHERE id = ${d.body.recipe.id}`
    expect(row.deleted_at).not.toBeNull()
    const lines = await directSql`SELECT count(*)::int AS n FROM recipe_ingredient WHERE recipe_id = ${d.body.recipe.id} AND deleted_at IS NULL`
    expect(lines[0].n).toBe(0)
    expect((await call(DAVE, 'GET', `/api/recipes/${d.body.recipe.id}`)).status).toBe(404)
    expect((await call(DAVE, 'DELETE', `/api/recipes/${d.body.recipe.id}`)).status).toBe(404)
  })
})

describe('/api/recipes/types — built-ins, find-or-create, household scope', () => {
  const label = `Shrub ${H.RUN}`
  it('the sixteen built-ins come first, in Dave\'s order', async () => {
    const r = await call(DAVE, 'GET', '/api/recipes/types')
    const built = r.body.types.filter((t) => t.builtin).map((t) => t.label)
    expect(built.slice(0, 4)).toEqual(['Hot sauce', 'Chili paste', 'Sambal & chili relish', 'Salsa & chutney'])
    expect(built).toHaveLength(16)
  })

  it('a built-in by any case → that built-in; a new label → created; JEN\'s spelling of it → the same one; STRANGER gets their own', async () => {
    const b = await call(JEN, 'POST', '/api/recipes/types', { label: '  HOT   sauce ' })
    expect(b.status).toBe(200)
    expect(b.body).toMatchObject({ created: false, type: { id: HOT_SAUCE, builtin: true } })
    const m = await call(DAVE, 'POST', '/api/recipes/types', { label })
    expect(m.status).toBe(201)
    const again = await call(JEN, 'POST', '/api/recipes/types', { label: label.toUpperCase() })
    expect(again.status).toBe(200)
    expect(again.body.type.id).toBe(m.body.type.id)
    const s = await call(STRANGER, 'POST', '/api/recipes/types', { label })
    expect(s.status).toBe(201)
    expect(s.body.type.id).not.toBe(m.body.type.id)
    expect((await call(JEN, 'GET', '/api/recipes/types')).body.types.some((t) => t.id === s.body.type.id)).toBe(false)
  })

  it('a built-in cannot be removed (409); a household type is soft-deleted and restored by the next create', async () => {
    expect((await call(DAVE, 'DELETE', `/api/recipes/types/${HOT_SAUCE}`)).body.code).toBe('builtin_type')
    const t = (await call(DAVE, 'POST', '/api/recipes/types', { label: `Gone ${H.RUN}` })).body.type
    expect((await call(STRANGER, 'DELETE', `/api/recipes/types/${t.id}`)).status).toBe(404)
    expect((await call(JEN, 'DELETE', `/api/recipes/types/${t.id}`)).status).toBe(200)
    expect((await call(DAVE, 'GET', '/api/recipes/types')).body.types.some((x) => x.id === t.id)).toBe(false)
    const back = await call(DAVE, 'POST', '/api/recipes/types', { label: `gone ${H.RUN}` })
    expect(back.body).toMatchObject({ restored: true, type: { id: t.id } })
  })
})

describe('batches and recipes: create with recipe_id, the batch read, Save as recipe', () => {
  let rid
  beforeAll(async () => { rid = (await call(DAVE, 'POST', '/api/recipes', body())).body.recipe.id })

  it('JEN starts a batch following DAVE\'s recipe; STRANGER naming it → 400; the batch read carries the recipe, never its notes', async () => {
    const c = await call(JEN, 'POST', '/api/kitchen-batches', { label: 'Mojo', recipe_id: rid, recipe_ref: 'the card', idempotency_key: key() })
    expect(c.status, JSON.stringify(c.body)).toBe(201)
    expect(c.body).toMatchObject({ recipe_id: rid, recipe_ref: 'the card' })
    expect((await call(STRANGER, 'POST', '/api/kitchen-batches', { label: 'x', recipe_id: rid })).status).toBe(400)
    const g = await call(DAVE, 'GET', `/api/kitchen-batches/${c.body.id}`)
    expect(g.status).toBe(200)
    expect(g.body.recipe).toMatchObject({ id: rid, keeps_storage_kind: 'fridge', bottle_label: '8 oz woozy' })
    expect(g.body.recipe.lines).toHaveLength(3)
    expect(g.body.recipe).not.toHaveProperty('notes')
    const detail = await call(JEN, 'GET', `/api/recipes/${rid}`)
    expect(detail.body.recipe.batches.map((b) => b.id)).toContain(c.body.id)
    for (const b of detail.body.recipe.batches) expect(Object.keys(b).filter((x) => /ph/.test(x))).toEqual([])
  })

  it('the view carries recipe_id at position 41', async () => {
    const [c] = await directSql`
      SELECT a.attnum FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'v_kitchen_batch_current' AND a.attname = 'recipe_id' AND NOT a.attisdropped`
    expect(c.attnum).toBe(41)
  })

  it('Save as recipe (JEN, DAVE\'s batch): every line, amount, sitting membership, the jar, Made, mash in and the first bottle — and links the batch', async () => {
    const b = await seedBatch(DAVE, { label: `Settlers ${H.RUN}` })
    await directSql`UPDATE kitchen_batch SET notes = 'Blend on day 13.', vessel_label = 'quart jar', vessel_size = 1, vessel_unit = 'qt', vessel_count = 1 WHERE id = ${b.id}`
    const l1 = await seedLine(DAVE, b.id, { label: 'cayenne', qty: 650, unit: 'g' })
    await directSql`UPDATE kitchen_batch_input SET form = 'fresh', shu_rating_low = 30000, shu_rating_high = 50000, brand = 'own', ordinal = 1 WHERE id = ${l1}`
    const [st] = await directSql`
      INSERT INTO kitchen_stage_log (batch_id, stage_kind, entered_at, entered_precision, amount, amount_unit, mash_in_g, created_by)
      VALUES (${b.id}, 'put_up', now(), 'exact', 256, 'g', 180, ${DAVE}) RETURNING id`
    await directSql`
      INSERT INTO kitchen_batch_input (batch_id, input_kind, label, put_up_stage_id, ordinal, created_by)
      VALUES (${b.id}, 'other', 'butter', ${st.id}, 2, ${DAVE})`
    await directSql`
      INSERT INTO preservation_log (user_id, batch_id, put_up_stage_id, label, method, preserved_at, preserved_at_precision,
                                    quantity_value, quantity_unit, package_count, remaining_count, container_label, cooked, use_by_basis)
      VALUES (${DAVE}, ${b.id}, ${st.id}, 'Settlers', 'hot_sauce', now()::date, 'day', 15, 'fl oz', 3, 3, '5 oz woozy', true, 'none')`
    const k = key()
    const r = await call(JEN, 'POST', `/api/recipes/from-batch/${b.id}`, { idempotency_key: k })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.batch_linked).toBe(true)
    expect(r.body.recipe).toMatchObject({ user_id: JEN, name: `Settlers ${H.RUN}`, kind: 'ferment', vessel_label: 'quart jar',
      bottle_label: '5 oz woozy', bottle_unit: 'fl oz', bottle_cooked: true })
    expect(Number(r.body.recipe.made_g)).toBe(256)
    expect(Number(r.body.recipe.mash_in_g)).toBe(180)
    expect(Number(r.body.recipe.bottle_size)).toBe(5)
    expect(r.body.recipe.notes).toBe('Blend on day 13.')
    expect(r.body.recipe.lines.map((l) => [l.name, l.at_the_end])).toEqual([['cayenne', false], ['butter', true]])
    expect(r.body.recipe.lines[0]).toMatchObject({ qty_unit: 'g', form: 'fresh', brand: 'own', shu_rating_low: 30000, amount_text: '650 g' })
    const [kb] = await directSql`SELECT recipe_id FROM kitchen_batch WHERE id = ${b.id}`
    expect(kb.recipe_id).toBe(r.body.recipe.id)
    const again = await call(JEN, 'POST', `/api/recipes/from-batch/${b.id}`, { idempotency_key: k })
    expect(again).toMatchObject({ status: 200, body: { replayed: true } })
    expect((await call(STRANGER, 'POST', `/api/recipes/from-batch/${b.id}`, { idempotency_key: key() })).status).toBe(404)
  })
})
