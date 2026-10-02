// storage-location.int.test.js — integration coverage for the storage-location Lambda.
// Runs the REAL handler (lambda/storage-location/index.js) against an ephemeral Neon branch
// with SecretsManager + Clerk stubbed by the harness. Every assertion mirrors index.js, verified
// against the live staging schema (storage_location: user_id text NN, label text NN, kind CHECK).
//
// Surfaces: POST (label-required, kind-enum, create returns 201 + RETURNING *), GET list (BARE
// array, user-scoped, soft-delete excluded), PUT (COALESCE update, foreign-owner 404, kind-enum
// 400), DELETE (RETURNING-gated soft-delete, NOT idempotent -> 404).
//
// BUG-DELNOOPOK-001 (2026-08-13) changed the DELETE contract. It was "idempotent {ok:true}" — an
// unconditional 200 that made not-found, already-deleted and NOT-OWNED indistinguishable, and that
// forced storage-location-authz.int.test.js to pin the DELETE's ownership property by reading row
// state instead of status. It now RETURNING-gates and 404s, matching the PUT above it.
//
// Put-Up R2a (the last describe) adds the two refusals: a re-kind while the place holds put-ups whose
// dates were worked out from its kind, and a delete while anything is stored in it. The unit lane
// (lambda/storage-location/place-refusals.test.js) proves what the handler SENDS and what it answers;
// under its stub no SQL runs, so THIS is where each rule of the two counts is executed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId } from './_harness.js'
import { assertFixtureId, settle } from './_cleanup.js'
import { makeHousehold, teardownHousehold, seedJar, seedPlace, call as preservationCall } from './_kitchenF.js'
import { handler } from '../../lambda/storage-location/index.js'

const RUN = testRunId()
const USER = `user_int_stor_${RUN}`
const FOREIGN_USER = `user_int_stor_foreign_${RUN}`
let foreignId

beforeAll(async () => {
  setTestUserId(USER)
  const fl = await directSql`
    INSERT INTO storage_location (user_id, label, kind)
    VALUES (${FOREIGN_USER}, ${'foreign-freezer-' + RUN}, ${'deep_freezer'})
    RETURNING id
  `
  foreignId = fl[0].id
})

afterAll(async () => {
  await directSql`DELETE FROM storage_location WHERE user_id IN (${USER}, ${FOREIGN_USER})`
})

describe('POST /api/storage-locations — validation + create', () => {
  it('missing label -> 400', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/storage-locations', body: { kind: 'pantry' },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/label is required/i)
  })

  it('invalid kind -> 400', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/storage-locations', body: { label: 'x-' + RUN, kind: 'igloo' },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/kind must be one of/i)
  })

  it('valid POST -> 201, scoped to user_id, stored (write->read-back)', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/storage-locations', body: { label: 'Garage Freezer ' + RUN, kind: 'deep_freezer' },
    })
    expect(status).toBe(201)
    expect(body.id).toBeTruthy()
    expect(body.label).toBe('Garage Freezer ' + RUN)
    expect(body.kind).toBe('deep_freezer')
    expect(body.user_id).toBe(USER)
    const rows = await directSql`SELECT label, kind, user_id FROM storage_location WHERE id = ${body.id}`
    expect(rows[0].user_id).toBe(USER)
    expect(rows[0].kind).toBe('deep_freezer')
  })
})

describe('GET /api/storage-locations — list (bare array, user-scoped)', () => {
  it('returns a BARE ARRAY, foreign owner excluded, soft-deletes excluded', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/storage-locations', body: { label: 'Pantry ' + RUN, kind: 'pantry' },
    })
    const del = await callHandler(handler, {
      method: 'POST', path: '/api/storage-locations', body: { label: 'Gone ' + RUN, kind: 'fridge' },
    })
    await directSql`UPDATE storage_location SET deleted_at = NOW() WHERE id = ${del.body.id}`
    const { status, body } = await callHandler(handler, { method: 'GET', path: '/api/storage-locations' })
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    const ids = body.map((r) => r.id)
    expect(ids).toContain(created.body.id)
    expect(ids).not.toContain(foreignId)
    expect(ids).not.toContain(del.body.id)
  })
})

describe('PUT /api/storage-locations/:id — update', () => {
  it('foreign-owner -> 404', async () => {
    setTestUserId(USER)
    const { status } = await callHandler(handler, {
      method: 'PUT', path: `/api/storage-locations/${foreignId}`, body: { label: 'hijack' },
    })
    expect(status).toBe(404)
  })

  it('COALESCE update -> 200, label changed, kind preserved', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/storage-locations', body: { label: 'Before ' + RUN, kind: 'cold_storage' },
    })
    const { status, body } = await callHandler(handler, {
      method: 'PUT', path: `/api/storage-locations/${created.body.id}`, body: { label: 'After ' + RUN },
    })
    expect(status).toBe(200)
    expect(body.label).toBe('After ' + RUN)
    expect(body.kind).toBe('cold_storage') // COALESCE: null kind in body -> keep existing
  })

  it('invalid kind in PUT -> 400', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/storage-locations', body: { label: 'Kind Edit ' + RUN, kind: 'fridge' },
    })
    const { status, body } = await callHandler(handler, {
      method: 'PUT', path: `/api/storage-locations/${created.body.id}`, body: { kind: 'wormhole' },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/kind must be one of/i)
  })
})

describe('DELETE /api/storage-locations/:id — soft-delete (idempotent)', () => {
  it('own DELETE -> 200 {ok:true}; deleted_at set; excluded from list', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/storage-locations', body: { label: 'Del ' + RUN, kind: 'other' },
    })
    const id = created.body.id
    const { status, body } = await callHandler(handler, { method: 'DELETE', path: `/api/storage-locations/${id}` })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    const rows = await directSql`SELECT deleted_at FROM storage_location WHERE id = ${id}`
    expect(rows[0].deleted_at).toBeTruthy()
  })

  // BUG-DELNOOPOK-001 REVERSED this test's intent. It asserted 200 {ok:true} on a non-existent id
  // and called it idempotence; it was the absence of a RETURNING-gate. Still mirrors locations —
  // both routes moved to 404 in the same change. Do not restore the old assertion.
  it('DELETE non-existent -> 404 (NOT idempotent, mirrors locations)', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'DELETE', path: `/api/storage-locations/00000000-0000-4000-8000-0000000000dd`,
    })
    expect(status).toBe(404)
    expect(body.error).toBe('Not found')
  })

  // The foreign-owner arm, which the old contract could not express at all: with the gate in
  // place, a not-owned DELETE is the same 404 as an unknown id — deliberately collapsed so the
  // status never reveals that the row exists. storage-location-authz.int.test.js:39 additionally
  // reads the row back; both claims matter, and neither replaces the other.
  it("DELETE another user's storage_location -> 404, row untouched", async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'DELETE', path: `/api/storage-locations/${foreignId}`,
    })
    expect(status, `foreign DELETE → ${JSON.stringify(body)}`).toBe(404)
    expect(body.error).toBe('Not found')
    const rows = await directSql`SELECT deleted_at FROM storage_location WHERE id = ${foreignId}`
    expect(rows[0].deleted_at).toBeNull()
  })
})

// ── Put-Up R2a: the re-kind and delete refusals (contracts 1 and 2) ────────────────────────────────
// DAVE + JEN one household, STRANGER outside. Every case makes its own place, so no case reads another's
// stock. Put-ups are seeded by direct SQL (_kitchenF.js seedJar: the route under test is never its own
// fixture) and then given the place, the date and the basis the case is about.
describe('Put-Up R2a — a place refuses a re-kind over worked-out dates, and a delete while in use', () => {
  const H = makeHousehold('stor-r2a')
  const { DAVE, JEN, STRANGER } = H
  const SINGULAR = '1 put-up in this place has a date worked out from the kind of place it is now. Set its date by hand, or move it somewhere else, then change the kind.'
  let savedIds

  beforeAll(() => { savedIds = process.env.GARDEN_HOUSEHOLD_IDS; process.env.GARDEN_HOUSEHOLD_IDS = `${DAVE},${JEN}` })
  afterAll(async () => {
    if (savedIds === undefined) delete process.env.GARDEN_HOUSEHOLD_IDS; else process.env.GARDEN_HOUSEHOLD_IDS = savedIds
    const ids = assertFixtureId(DAVE, JEN, STRANGER)
    // Items name a place, and the household teardown removes places: items first.
    await settle(`storage-location r2a teardown ${H.RUN}`, [
      () => directSql`DELETE FROM pantry_item WHERE user_id = ANY(${ids})`,
    ])
    await teardownHousehold(H)
  })

  const as = (userId, method, id, body) => {
    setTestUserId(userId)
    return callHandler(handler, { method, path: `/api/storage-locations/${id}`, body, userId })
  }
  const readPlace = async (id) => (await directSql`SELECT label, kind, deleted_at FROM storage_location WHERE id = ${id}`)[0]
  // A put-up at a place. Defaults: three containers, all left, a date worked out from a general figure.
  const jarAt = async (owner, placeId, { date = '2027-06-01', basis = 'table', ...seed } = {}) => {
    const id = await seedJar(owner, seed)
    await directSql`
      UPDATE preservation_log
      SET storage_location_id = ${placeId}, use_by_target = ${date}::date, use_by_basis = ${basis}
      WHERE id = ${id}`
    return id
  }
  const itemAt = async (owner, placeId, { usedUp = false, removed = false } = {}) => {
    const [it] = await directSql`
      INSERT INTO pantry_item (user_id, name, storage_location_id)
      VALUES (${owner}, ${'stor-r2a item ' + H.RUN}, ${placeId}) RETURNING id`
    if (usedUp) await directSql`UPDATE pantry_item SET used_up_at = now() WHERE id = ${it.id}`
    if (removed) await directSql`UPDATE pantry_item SET deleted_at = now() WHERE id = ${it.id}`
    return it.id
  }

  describe('PUT — re-kind', () => {
    it('a rename at a place with a dated jar → 200 (the shipped editor\'s body: both keys, the kind unchanged)', async () => {
      const place = await seedPlace(DAVE, { kind: 'pantry' })
      await jarAt(DAVE, place)
      const label = `stor-r2a renamed ${H.RUN}`
      const { status, body } = await as(DAVE, 'PUT', place, { label, kind: 'pantry' })
      expect(status, JSON.stringify(body)).toBe(200)
      expect(body).toMatchObject({ id: place, label, kind: 'pantry', user_id: DAVE, deleted_at: null })
      // The answer is the place alone: the statement's own columns stay inside the handler.
      expect(Object.keys(body).sort()).toEqual(['created_at', 'deleted_at', 'id', 'kind', 'label', 'user_id'])
      expect(await readPlace(place)).toMatchObject({ label, kind: 'pantry' })
    })

    it('a re-kind → 409 place_has_dated_jars, and neither the kind nor the name moved', async () => {
      const place = await seedPlace(DAVE, { kind: 'pantry' })
      await jarAt(DAVE, place)
      const before = await readPlace(place)
      const { status, body } = await as(DAVE, 'PUT', place, { label: `stor-r2a must not land ${H.RUN}`, kind: 'fridge' })
      expect(status, JSON.stringify(body)).toBe(409)
      expect(body).toEqual({ error: SINGULAR, message: SINGULAR, code: 'place_has_dated_jars', n: 1 })
      expect(await readPlace(place)).toEqual(before)
    })

    it('a re-kind with only typed or undated jars → 200: they are not worked out from the kind', async () => {
      const place = await seedPlace(DAVE, { kind: 'pantry' })
      await jarAt(DAVE, place, { date: '2027-06-01', basis: 'typed' })   // his own date
      await jarAt(DAVE, place, { date: null, basis: 'typed' })           // his own "no date"
      await jarAt(DAVE, place, { date: null, basis: 'none' })            // no figure, no date
      await jarAt(DAVE, place, { date: null, basis: null })              // a pre-1b row that never had a date
      const { status, body } = await as(DAVE, 'PUT', place, { kind: 'fridge' })
      expect(status, JSON.stringify(body)).toBe(200)
      expect((await readPlace(place)).kind).toBe('fridge')
    })

    it('house and recipe dates count as the general figure does, and n counts each put-up once', async () => {
      const place = await seedPlace(DAVE, { kind: 'pantry' })
      await jarAt(DAVE, place, { basis: 'table' })
      await jarAt(DAVE, place, { basis: 'house' })
      await jarAt(DAVE, place, { basis: 'recipe' })
      await jarAt(DAVE, place, { basis: 'typed' })
      const { status, body } = await as(DAVE, 'PUT', place, { kind: 'fridge' })
      expect(status).toBe(409)
      expect(body.n).toBe(3)
      expect(body.message).toBe('3 put-ups in this place have dates worked out from the kind of place it is now. Set those dates by hand, or move them somewhere else, then change the kind.')
      expect(body.error).toBe(body.message)
    })

    it('a dated row with no basis blocks: an unrecorded basis is not read as his own date', async () => {
      const place = await seedPlace(DAVE, { kind: 'pantry' })
      await jarAt(DAVE, place, { basis: null })
      const { status, body } = await as(DAVE, 'PUT', place, { kind: 'fridge' })
      expect(status).toBe(409)
      expect(body).toMatchObject({ code: 'place_has_dated_jars', n: 1 })
    })

    it.each([
      ['a removed jar', { deleted: true }],
      ['a consumed jar', { consumed: true }],
      ['a jar with nothing left', { remaining: 0 }],
    ])('%s does not block: the Pantry does not show it either', async (_, seed) => {
      const place = await seedPlace(DAVE, { kind: 'pantry' })
      await jarAt(DAVE, place, seed)
      const { status, body } = await as(DAVE, 'PUT', place, { kind: 'fridge' })
      expect(status, JSON.stringify(body)).toBe(200)
      expect((await readPlace(place)).kind).toBe('fridge')
    })

    it('Jen\'s dated jar in Dave\'s place blocks Dave; a jar from outside the household does not', async () => {
      const shared = await seedPlace(DAVE, { kind: 'pantry' })
      await jarAt(JEN, shared)
      const refused = await as(DAVE, 'PUT', shared, { kind: 'fridge' })
      expect(refused.status).toBe(409)
      expect(refused.body.n).toBe(1)
      // Not reachable through any route (a create refuses a place outside the household); written by
      // hand to prove the count is the household's and nothing wider.
      const alone = await seedPlace(DAVE, { kind: 'pantry' })
      await jarAt(STRANGER, alone)
      const ok = await as(DAVE, 'PUT', alone, { kind: 'fridge' })
      expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    })

    it('a stranger\'s place → 404, never a 409, whatever it holds', async () => {
      const theirs = await seedPlace(STRANGER, { kind: 'pantry' })
      await jarAt(STRANGER, theirs)
      const { status, body } = await as(DAVE, 'PUT', theirs, { kind: 'fridge' })
      expect(status).toBe(404)
      expect(body).toEqual({ error: 'Not found' })
      expect((await readPlace(theirs)).kind).toBe('pantry')
    })

    it('refused → the date is set by hand in Edit (the same date) → basis typed → the same re-kind answers 200', async () => {
      const place = await seedPlace(DAVE, { kind: 'pantry' })
      const jar = await jarAt(DAVE, place, { date: '2027-06-01', basis: 'table' })
      expect((await as(DAVE, 'PUT', place, { kind: 'fridge' })).status).toBe(409)
      const patched = await preservationCall(DAVE, 'PATCH', `/api/preservation/${jar}`, { discard_by: '2027-06-01' })
      expect(patched.status, JSON.stringify(patched.body)).toBe(200)
      const [row] = await directSql`SELECT use_by_target::text AS d, use_by_basis FROM preservation_log WHERE id = ${jar}`
      expect(row).toEqual({ d: '2027-06-01', use_by_basis: 'typed' })
      const again = await as(DAVE, 'PUT', place, { kind: 'fridge' })
      expect(again.status, JSON.stringify(again.body)).toBe(200)
      expect((await readPlace(place)).kind).toBe('fridge')
    })
  })

  describe('DELETE — in use', () => {
    const IN_USE_ONE = '1 thing is stored in this place. Move it first, then delete it.'

    it('a place holding a live put-up → 409 place_in_use, n: 1, deleted_at still null (an undated jar blocks too)', async () => {
      const place = await seedPlace(DAVE, { kind: 'pantry' })
      await jarAt(DAVE, place, { date: null, basis: 'none' })
      const { status, body } = await as(DAVE, 'DELETE', place)
      expect(status, JSON.stringify(body)).toBe(409)
      expect(body).toEqual({ error: IN_USE_ONE, message: IN_USE_ONE, code: 'place_in_use', n: 1 })
      expect((await readPlace(place)).deleted_at).toBeNull()
    })

    it('a place holding only a pantry item is refused', async () => {
      const place = await seedPlace(DAVE, { kind: 'pantry' })
      await itemAt(DAVE, place)
      const { status, body } = await as(DAVE, 'DELETE', place)
      expect(status).toBe(409)
      expect(body).toMatchObject({ code: 'place_in_use', n: 1 })
      expect((await readPlace(place)).deleted_at).toBeNull()
    })

    it('two jars and one item: n is 3', async () => {
      const place = await seedPlace(DAVE, { kind: 'pantry' })
      await jarAt(DAVE, place, { basis: 'typed' })
      await jarAt(JEN, place)          // a peer's put-up counts
      await itemAt(JEN, place)
      const { status, body } = await as(DAVE, 'DELETE', place)
      expect(status).toBe(409)
      expect(body.n).toBe(3)
      expect(body.message).toBe('3 things are stored in this place. Move them first, then delete it.')
      expect(body.error).toBe(body.message)
    })

    it.each([
      ['a used-up item', (place) => itemAt(DAVE, place, { usedUp: true })],
      ['a removed item', (place) => itemAt(DAVE, place, { removed: true })],
      ['a consumed jar', (place) => jarAt(DAVE, place, { consumed: true })],
      ['a removed jar', (place) => jarAt(DAVE, place, { deleted: true })],
      ['a jar with nothing left', (place) => jarAt(DAVE, place, { remaining: 0 })],
    ])('a place holding only %s deletes: 200, deleted_at set', async (_, stock) => {
      const place = await seedPlace(DAVE, { kind: 'pantry' })
      await stock(place)
      const { status, body } = await as(DAVE, 'DELETE', place)
      expect(status, JSON.stringify(body)).toBe(200)
      expect(body).toEqual({ ok: true })
      expect((await readPlace(place)).deleted_at).toBeTruthy()
    })

    it('an empty place deletes; a second DELETE → 404', async () => {
      const place = await seedPlace(DAVE, { kind: 'other' })
      expect((await as(DAVE, 'DELETE', place)).status).toBe(200)
      const again = await as(DAVE, 'DELETE', place)
      expect(again.status).toBe(404)
      expect(again.body).toEqual({ error: 'Not found' })
    })

    it('a stranger\'s place in use → 404, never a 409, and it is not removed', async () => {
      const theirs = await seedPlace(STRANGER, { kind: 'pantry' })
      await jarAt(STRANGER, theirs)
      const { status, body } = await as(DAVE, 'DELETE', theirs)
      expect(status).toBe(404)
      expect(body).toEqual({ error: 'Not found' })
      expect((await readPlace(theirs)).deleted_at).toBeNull()
    })
  })
})
