// Put-Up release 4 — the recipe rung of the discard-by rule on real Postgres (V4 §3.1, §3.2, §3.4), through the real
// Put it up route and Move: a batch following a recipe whose keeps line is "Fridge · 7 days" puts up a fridge jar
// with basis 'recipe' and date = put-up day + 7; a freezer jar in the same sitting falls through to the table; a
// typed date beats the recipe; a Move to another storage kind nulls the recipe date, a move within the kind keeps
// it. DAVE + JEN one household (JEN puts up from DAVE's recipe); STRANGER cannot name the recipe on a batch.
// Put-Up UX pass R1 adds the same rung to PATCH /api/preservation/:id { discard_by: 'clear' }: moved → no date, else
// the recipe on a matching kind, else the engine. THE FILE IS ORDER-DEPENDENT: the move case moves the first sitting's
// fridge jar and the removal case deletes the recipe, so the clear cases sit before both, on jars of their own.
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

  // ── Put-Up UX pass R1: clearing a typed discard date re-derives through the recipe ────────────────────────────
  // PATCH /api/preservation/:id { discard_by: 'clear' } asked the engine only, so a fridge jar from this "Fridge · 7
  // days" recipe came back with the general six months. The order now: a moved jar → no date; else the recipe when
  // its storage kind is the jar's place kind; else the engine; else none. These cases run on jars of their OWN
  // sitting (DAVE puts up on JEN's batch, so the jars are DAVE's), BEFORE the move case and the recipe removal below,
  // and each reads the stored row back. The one that needs the recipe gone is the last test of this file.
  const TYPED = '2026-12-25'
  const FRIDGE = { kind: 'fridge', label: `rcpb fridge ${H.RUN}` }
  const FREEZER = { kind: 'deep_freezer', label: `rcpb freezer ${H.RUN}` }
  // name → the row it is put up as. "AsMade" rows carry no typed date: they are what CREATE gives that place.
  const OWN_ROWS = [
    ['fridge', { place: FRIDGE, discard_by: TYPED }],
    ['freezer', { place: FREEZER, discard_by: TYPED }],
    ['freezerAsMade', { place: FREEZER }],
    ['movedBack', { place: FRIDGE, discard_by: TYPED }],
    ['afterRemoval', { place: FRIDGE, discard_by: TYPED }],
    ['authz', { place: FRIDGE, discard_by: TYPED }],
    ['raw', { place: FRIDGE, discard_by: TYPED, is_raw: true }],
    ['rawAsMade', { place: FRIDGE, is_raw: true }],
    ['general', { place: FRIDGE }],
    ['house', { place: FRIDGE }],
    ['withMethod', { place: FRIDGE, discard_by: TYPED }],
    ['withMethodFreezer', { place: FREEZER, discard_by: TYPED }],
  ]
  let own
  const idOf = (name) => {
    // Set by the sitting below. Without it the path is /api/preservation/undefined, which no jar route claims
    // (uuid ids only) and which falls to the create POST's 400: a misleading second failure.
    expect(own?.[name], `the clear sitting did not yield its "${name}" jar`).toBeTruthy()
    return own[name]
  }
  const jarPath = (name) => `/api/preservation/${idOf(name)}`
  const clear = (user, name, more = {}) => call(user, 'PATCH', jarPath(name), { discard_by: 'clear', ...more })
  const stored = async (name) => (await directSql`
    SELECT p.user_id, p.method, p.is_raw, p.use_by_basis, to_char(p.use_by_target, 'YYYY-MM-DD') AS use_by,
           (p.storage_moved_at IS NOT NULL) AS moved, s.kind AS storage_kind
    FROM preservation_log p LEFT JOIN storage_location s ON s.id = p.storage_location_id
    WHERE p.id = ${idOf(name)}`)[0]
  const RECIPE_DATED = { use_by_basis: 'recipe', use_by: addDays(DAY, 7) }

  it('the clear sitting: DAVE puts up twelve rows on JEN\'s batch; typed rows are typed, the rest take the recipe (fridge, Raw included) or the table (freezer)', async () => {
    const put = await call(DAVE, 'POST', `/api/kitchen-batches/${batchId}/put-up`, {
      idempotency_key: key(), when: { date: DAY, precision: 'day' }, method: 'hot_sauce', finish: false,
      rows: OWN_ROWS.map(([, row]) => ({ count: 1, ...row })),
    })
    expect(put.status, JSON.stringify(put.body)).toBe(201)
    expect(put.body.jars).toHaveLength(OWN_ROWS.length)
    own = Object.fromEntries(OWN_ROWS.map(([name], i) => [name, put.body.jars[i].id]))
    for (const [name, row] of OWN_ROWS) {
      const s = await stored(name)
      expect(s, name).toMatchObject({ user_id: DAVE, method: 'hot_sauce', storage_kind: row.place.kind, moved: false, is_raw: row.is_raw ?? null })
      if (row.discard_by) expect(s, name).toMatchObject({ use_by_basis: 'typed', use_by: TYPED })
      else if (row.place === FRIDGE) expect(s, name).toMatchObject(RECIPE_DATED)
      else expect(s.use_by_basis, name).toBe('table')
    }
  })

  it('clear on a typed fridge jar → basis recipe, put-up day + 7: stored, and read back through GET /api/preservation/:id', async () => {
    const r = await clear(DAVE, 'fridge')
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.use_by_basis).toBe('recipe')
    expect(ymd(r.body.use_by_target)).toBe(addDays(DAY, 7))
    expect(await stored('fridge')).toMatchObject(RECIPE_DATED)
    const g = await call(JEN, 'GET', jarPath('fridge'))
    expect(g.status).toBe(200)
    expect(g.body.use_by_basis).toBe('recipe')
    expect(ymd(g.body.use_by_target)).toBe(addDays(DAY, 7))
  })

  it('clear on a typed freezer jar → the table, exactly what create gave a freezer row of the same sitting, and not day + 7', async () => {
    const r = await clear(DAVE, 'freezer')
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const s = await stored('freezer')
    const asMade = await stored('freezerAsMade')
    expect(s.use_by_basis).toBe('table')
    expect(s.use_by).not.toBe(addDays(DAY, 7))
    expect(s.use_by).toBe(asMade.use_by)
    expect(asMade.use_by).not.toBeNull()
  })

  it('clear on a jar that moved to another kind of place and back → no date, though the recipe names its place again', async () => {
    const out = await call(DAVE, 'POST', `${jarPath('movedBack')}/move`, { place: FREEZER })
    expect(out.status, JSON.stringify(out.body)).toBe(200)
    const back = await call(DAVE, 'POST', `${jarPath('movedBack')}/move`, { place: FRIDGE })
    expect(back.status, JSON.stringify(back.body)).toBe(200)
    // In a fridge again, its typed date kept through both moves: the recipe WOULD answer for it. The move outranks it.
    expect(await stored('movedBack')).toMatchObject({ storage_kind: 'fridge', moved: true, use_by_basis: 'typed', use_by: TYPED })
    const r = await clear(JEN, 'movedBack')
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toMatchObject({ use_by_target: null, use_by_basis: 'none' })
    expect(await stored('movedBack')).toMatchObject({ use_by_basis: 'none', use_by: null, moved: true })
  })

  it('STRANGER clears DAVE\'s jar → 404, nothing written; JEN clears it → 200, the recipe date', async () => {
    const before = await stored('authz')
    expect(before).toMatchObject({ user_id: DAVE, use_by_basis: 'typed', use_by: TYPED })
    const s = await clear(STRANGER, 'authz')
    expect(s.status).toBe(404)
    expect(await stored('authz')).toEqual(before)
    const j = await clear(JEN, 'authz')
    expect(j.status, JSON.stringify(j.body)).toBe(200)
    expect(await stored('authz')).toMatchObject(RECIPE_DATED)
  })

  // Pinned on purpose (regression seat Q2 case 7). The engine alone gives a Raw jar outside a freezer no date; the
  // recipe rung does not read Raw. Put it up gives a Raw fridge row on this batch the recipe date at create (the
  // "rawAsMade" row above), and a clear gives the same.
  it('a Raw jar in the fridge on a recipe batch: clear → the recipe date, as Put it up gave its Raw fridge row at create', async () => {
    expect(await stored('rawAsMade')).toMatchObject({ is_raw: true, ...RECIPE_DATED })
    const r = await clear(DAVE, 'raw')
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(await stored('raw')).toMatchObject({ is_raw: true, ...RECIPE_DATED })
  })

  // Regression seat M-14 / Q2 case 11: the Edit panel sends 'clear' whenever its date field is emptied, whatever the
  // stored basis. Two fridge jars are given a general and a house date by hand (a jar dated before its batch followed
  // the recipe); a clear does not read the stored basis, so both resolve by the ladder.
  it('clear on a general (table) date and on a house date → the recipe date for both', async () => {
    await directSql`UPDATE preservation_log SET use_by_basis = 'table', use_by_target = '2027-04-09' WHERE id = ${idOf('general')}`
    await directSql`UPDATE preservation_log SET use_by_basis = 'house', use_by_target = '2026-11-09' WHERE id = ${idOf('house')}`
    expect(await stored('general')).toMatchObject({ use_by_basis: 'table', use_by: '2027-04-09' })
    expect(await stored('house')).toMatchObject({ use_by_basis: 'house', use_by: '2026-11-09' })
    for (const name of ['general', 'house']) {
      const r = await clear(DAVE, name)
      expect(r.status, `${name}: ${JSON.stringify(r.body)}`).toBe(200)
      expect(await stored(name), name).toMatchObject(RECIPE_DATED)
    }
  })

  it('clear sent with a method correction in ONE PATCH: the method is stored; the fridge jar takes the recipe date, the freezer jar the engine date of the CORRECTED method', async () => {
    const a = await clear(DAVE, 'withMethod', { method: 'quick_pickle' })
    expect(a.status, JSON.stringify(a.body)).toBe(200)
    expect(await stored('withMethod')).toMatchObject({ method: 'quick_pickle', ...RECIPE_DATED })
    const b = await clear(DAVE, 'withMethodFreezer', { method: 'whole_freeze' })
    expect(b.status, JSON.stringify(b.body)).toBe(200)
    const s = await stored('withMethodFreezer')
    expect(s).toMatchObject({ method: 'whole_freeze', use_by_basis: 'table' })
    // whole_freeze in a deep freezer is 12 months (the cell the smoke's block N reads back too); the hot sauce the
    // jar was put up as is 6 there, which is what the "freezerAsMade" row holds. So the engine read the new method.
    expect(s.use_by).toBe('2027-10-09')
    expect(s.use_by).not.toBe((await stored('freezerAsMade')).use_by)
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

  // Put-Up UX pass R1, the last rung read: with the recipe removed (the case above), a clear on a typed fridge jar
  // of that batch reads no live recipe and falls to the engine. The jar is the clear sitting's "afterRemoval" row,
  // typed while the recipe was live and never moved.
  it('after the recipe is removed: clear on a typed fridge jar of that batch → the table, not the recipe', async () => {
    const [{ removed }] = await directSql`
      SELECT (r.deleted_at IS NOT NULL) AS removed FROM kitchen_batch b JOIN recipe r ON r.id = b.recipe_id WHERE b.id = ${batchId}`
    expect(removed, 'the removal case above did not remove the recipe').toBe(true)
    expect(await stored('afterRemoval')).toMatchObject({ storage_kind: 'fridge', moved: false, use_by_basis: 'typed', use_by: TYPED })
    const r = await clear(JEN, 'afterRemoval')
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const s = await stored('afterRemoval')
    expect(s.use_by_basis).toBe('table')
    expect(s.use_by).not.toBeNull()
    expect(s.use_by).not.toBe(addDays(DAY, 7))
  })
})
