// storage-location-authz.int.test.js — 0A.5 Phase-1 leak-lock for the storage-location Lambda
// (lambda/storage-location/index.js). Real handler vs an ephemeral Neon branch (harness stubs
// SecretsManager + Clerk; SQL is REAL). Compensating control for the RLS-off posture (see _authz.js).
//
// AUTH MODEL: household-scoped on `user_id = ANY(householdIds)` (owner column is user_id, NOT
// created_by) + `deleted_at IS NULL`, on PUT/:id (index.js:92-94), DELETE/:id (:105-107) and the
// list (:119). There is NO GET /:id route — the read is the household-scoped LIST, so the matrix's
// array branch carries the read arms. Denied = 404 (PUT's `if (!rows.length)` gate).
//
// The generic matrix's write axis MUST be PUT: DELETE returns 200 UNCONDITIONALLY (no RETURNING
// gate, index.js:102-109), so its status can't signal denial — same shape as the locations handler.
// The DELETE ownership property is instead pinned by the custom block below (row-state, not status).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, setTestUserId, testRunId } from './_harness.js'
import { describeAuthzMatrix } from './_authz.js'
import { handler as storageHandler } from '../../lambda/storage-location/index.js'

describeAuthzMatrix({
  name: 'storage-location /api/storage-locations',
  handler: storageHandler,
  seedResource: async (owner) => {
    const r = await directSql`
      INSERT INTO storage_location (user_id, label, kind)
      VALUES (${owner}, ${'authz-sl-' + owner}, 'pantry') RETURNING id`
    return r[0].id
  },
  read: () => ({ method: 'GET', path: `/api/storage-locations` }), // scoped-list (array) branch
  write: (id) => ({ method: 'PUT', path: `/api/storage-locations/${id}`, body: { label: 'authz-mutated' } }),
  softDelete: async (id) => { await directSql`UPDATE storage_location SET deleted_at = NOW() WHERE id = ${id}` },
  readBack: async (id) => {
    const r = await directSql`SELECT label FROM storage_location WHERE id = ${id}`
    return r[0] ?? null
  },
  cleanup: async (ctx) => {
    await directSql`DELETE FROM storage_location WHERE user_id = ${ctx.__owner}`
  },
})

// ── DELETE ownership — custom (0A.5). The generic matrix uses PUT because DELETE returns 200 with no
// RETURNING gate. This block pins the DELETE path's ownership predicate directly: a foreign DELETE
// returns 200 (the documented cosmetic weakness — a silent no-op success, NOT a leak) but must leave
// the owner's row live. That non-mutation is the regression guard — it goes red the moment the
// `user_id = ANY(householdIds)` predicate is dropped from the DELETE. ──────────────────────────────
describe('AUTHZ storage-location DELETE /api/storage-locations/:id — ownership (0A.5)', () => {
  const RUN = testRunId()
  const OWNER = `authz_sldel_owner_${RUN}`
  const FOREIGN = `authz_sldel_foreign_${RUN}`
  let locId

  beforeAll(async () => {
    const r = await directSql`
      INSERT INTO storage_location (user_id, label, kind)
      VALUES (${OWNER}, ${'authz-sldel-' + RUN}, 'fridge') RETURNING id`
    locId = r[0].id
  })

  afterAll(async () => {
    await directSql`DELETE FROM storage_location WHERE user_id IN (${OWNER}, ${FOREIGN})`
  })

  it('foreign DELETE owner storage_location → 200 but row still live (deleted_at NULL)', async () => {
    setTestUserId(FOREIGN)
    const { status } = await callHandler(storageHandler, { method: 'DELETE', path: `/api/storage-locations/${locId}` })
    expect(status).toBe(200) // handler is unconditionally 200 on DELETE — status alone cannot prove denial
    const r = await directSql`SELECT deleted_at FROM storage_location WHERE id = ${locId}`
    expect(r[0].deleted_at).toBeNull() // soft-delete-bypass regression guard
  })

  it('owner DELETE own storage_location → 200 and row soft-deleted', async () => {
    setTestUserId(OWNER)
    const { status } = await callHandler(storageHandler, { method: 'DELETE', path: `/api/storage-locations/${locId}` })
    expect(status).toBe(200)
    const r = await directSql`SELECT deleted_at FROM storage_location WHERE id = ${locId}`
    expect(r[0].deleted_at).not.toBeNull()
  })
})
