// tests/integration/restore-surface.int.test.js
// V4-RESTORESURFACE-001 — the recovery path for soft-deleted entities (audit finding I9).
//
// THE GAP. lambda/photos states the governing principle in-code: "A destructive control must not
// ship ahead of the recovery path it advertises." Photos honour it — soft delete, a
// GET /api/photos/deleted list, a POST /api/photos/:id/restore, and a Recently-deleted page. No
// other entity had any of it. Measured on live prod 2026-08-13, the rows with no way back were:
//   plants 33 · plant_varieties 13 · plant_projects 12 · locations 10   (photos: 1, restorable)
// "Never removes the row" was satisfied while "all data stays recoverable" was not — from the
// user's seat a soft-deleted location is indistinguishable from a hard-deleted one.
//
// This file pins the CONTRACT the new routes copy from photoDelete.js, so the remaining entities
// can be held to the same shape rather than to whatever each Lambda happened to do:
//   1. the deleted list is household-scoped and shows ONLY soft-deleted rows;
//   2. restore is IDEMPOTENT — restoring a live row is 200 + already_restored, not an error;
//   3. a foreign or unknown id is 404, never a leak and never a 500;
//   4. restore actually returns the row to the live list;
//   5. there is NO permanent-delete verb, and Soft-Delete-Only means there never will be.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, testRunId, setTestUserId, callHandler } from './_harness.js'
import { handler as locationsHandler } from '../../lambda/locations/index.js'

const RUN = testRunId()
const USER = `user_int_restore_${RUN}`
const FOREIGN_USER = `user_int_restore_foreign_${RUN}`

let deletedLocId, liveLocId, foreignDeletedLocId

beforeAll(async () => {
  setTestUserId(USER)

  const del = await directSql`
    INSERT INTO locations (name, slug, level, created_by, deleted_at)
    VALUES (${'restore-del-' + RUN}, ${'restore-del-' + RUN}, ${0}, ${USER}, NOW())
    RETURNING id`
  deletedLocId = del[0].id

  const live = await directSql`
    INSERT INTO locations (name, slug, level, created_by)
    VALUES (${'restore-live-' + RUN}, ${'restore-live-' + RUN}, ${0}, ${USER})
    RETURNING id`
  liveLocId = live[0].id

  // Someone else's deleted location — must never appear in this user's recovery list, and must not
  // be restorable by them. The recovery surface is a new READ of rows the app otherwise hides, so
  // its scoping deserves its own assertion rather than inheriting trust from the list route.
  const foreign = await directSql`
    INSERT INTO locations (name, slug, level, created_by, deleted_at)
    VALUES (${'restore-foreign-' + RUN}, ${'restore-foreign-' + RUN}, ${0}, ${FOREIGN_USER}, NOW())
    RETURNING id`
  foreignDeletedLocId = foreign[0].id
})

afterAll(async () => {
  await directSql`DELETE FROM locations WHERE created_by IN (${USER}, ${FOREIGN_USER})`
})

describe('V4-RESTORESURFACE-001 — GET /api/locations/deleted', () => {
  it('lists ONLY soft-deleted locations, and only the household\'s own', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(locationsHandler, {
      method: 'GET', path: '/api/locations/deleted',
    })
    expect(status).toBe(200)
    const ids = body.locations.map(l => l.id)
    expect(ids, 'the soft-deleted location must be recoverable').toContain(deletedLocId)
    expect(ids, 'a LIVE location is not a deletion').not.toContain(liveLocId)
    expect(ids, "another household's deleted row must not leak into this recovery list")
      .not.toContain(foreignDeletedLocId)
    for (const l of body.locations) expect(l.deleted_at).not.toBeNull()
  })

  it('does NOT get captured by the by-id route — the ordering hazard this route sits on', async () => {
    // `/api/locations/deleted` is a single trailing segment, so the bare-:id matcher would have
    // swallowed it and answered 404 from the by-id GET. The route is declared above it AND excluded
    // from idMatch; this asserts the result rather than the arrangement.
    setTestUserId(USER)
    const { status, body } = await callHandler(locationsHandler, {
      method: 'GET', path: '/api/locations/deleted',
    })
    expect(status).toBe(200)
    expect(Array.isArray(body.locations), 'a by-id 404 would not have a locations array').toBe(true)
  })
})

describe('V4-RESTORESURFACE-001 — POST /api/locations/:id/restore', () => {
  it('restores a soft-deleted location and returns it live', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(locationsHandler, {
      method: 'POST', path: `/api/locations/${deletedLocId}/restore`,
    })
    expect(status).toBe(200)
    expect(body.deleted_at).toBeNull()

    const [row] = await directSql`SELECT deleted_at FROM locations WHERE id = ${deletedLocId}`
    expect(row.deleted_at, 'the read-back is what proves it, not the handler echo').toBeNull()
  })

  it('is IDEMPOTENT — restoring an already-live row is 200 + already_restored, not an error', async () => {
    // Matches restorePhoto. A double-tap or a replayed request must not be something the user has
    // to interpret.
    setTestUserId(USER)
    const { status, body } = await callHandler(locationsHandler, {
      method: 'POST', path: `/api/locations/${liveLocId}/restore`,
    })
    expect(status).toBe(200)
    expect(body.already_restored).toBe(true)
    expect(body.deleted_at).toBeNull()
  })

  it("404s another household's deleted location — no leak, no 500", async () => {
    setTestUserId(USER)
    const { status } = await callHandler(locationsHandler, {
      method: 'POST', path: `/api/locations/${foreignDeletedLocId}/restore`,
    })
    expect(status).toBe(404)
    const [row] = await directSql`SELECT deleted_at FROM locations WHERE id = ${foreignDeletedLocId}`
    expect(row.deleted_at, 'and it must still be deleted').not.toBeNull()
  })

  it('404s a non-UUID id rather than reaching the database', async () => {
    setTestUserId(USER)
    const { status } = await callHandler(locationsHandler, {
      method: 'POST', path: '/api/locations/not-a-uuid/restore',
    })
    expect(status).toBe(404)
  })

  it('404s a well-formed but unknown id', async () => {
    setTestUserId(USER)
    const { status } = await callHandler(locationsHandler, {
      method: 'POST', path: '/api/locations/00000000-0000-4000-8000-000000000000/restore',
    })
    expect(status).toBe(404)
  })
})

describe('V4-RESTORESURFACE-001 — Soft-Delete-Only holds on the new surface', () => {
  it('the restored location is back in the normal list, and the deleted list is one shorter', async () => {
    setTestUserId(USER)
    const listed = await callHandler(locationsHandler, { method: 'GET', path: '/api/locations' })
    expect(listed.status).toBe(200)
    const live = JSON.stringify(listed.body)
    expect(live, 'a restore that does not return the row to the live list is not a restore')
      .toContain(deletedLocId)

    const after = await callHandler(locationsHandler, {
      method: 'GET', path: '/api/locations/deleted',
    })
    expect(after.body.locations.map(l => l.id)).not.toContain(deletedLocId)
  })

  it('there is no permanent-delete verb on the recovery path', async () => {
    // DELETE /api/locations/deleted must not resolve to a purge. It falls through to the bare-:id
    // arm, where 'deleted' is not a UUID — so the correct answer is a 404, and Soft-Delete-Only
    // means that stays true.
    setTestUserId(USER)
    const { status } = await callHandler(locationsHandler, {
      method: 'DELETE', path: '/api/locations/deleted',
    })
    expect(status).not.toBe(200)
  })
})
