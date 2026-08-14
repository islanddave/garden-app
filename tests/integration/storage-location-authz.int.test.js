// storage-location-authz.int.test.js — 0A.5 Phase-1 leak-lock for the storage-location Lambda
// (lambda/storage-location/index.js). Real handler vs an ephemeral Neon branch (harness stubs
// SecretsManager + Clerk; SQL is REAL). Compensating control for the RLS-off posture (see _authz.js).
//
// AUTH MODEL: household-scoped on `user_id = ANY(householdIds)` (owner column is user_id, NOT
// created_by) + `deleted_at IS NULL`, on PUT/:id (index.js:93-101), DELETE/:id (:106-121) and the
// list. There is NO GET /:id route — the read is the household-scoped LIST, so the matrix's array
// branch carries the read arms. Denied = 404 on BOTH write verbs (`if (!rows.length)` — PUT at
// :102, DELETE at :119).
//
// The generic matrix's write axis is PUT. That used to be FORCED: DELETE returned 200
// UNCONDITIONALLY (no RETURNING gate), so its status could not signal denial at all.
// BUG-DELNOOPOK-001 (2026-08-13) retired that constraint — DELETE now 404s on a foreign or
// unknown id like every other verb. PUT nonetheless STAYS the write axis, for a different and
// still-live reason: the matrix's `readBack` asserts the attempted mutation did NOT land
// ('authz-mutated' must not appear), which only a mutating-but-not-destroying verb can express.
// A DELETE axis would have nothing to read back but a deleted_at that must stay null — a weaker
// claim, on a row the matrix could then no longer reuse. The DELETE ownership property is pinned
// by the custom block below instead. Do not re-add the old rationale; it is now false.
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

// ── DELETE ownership — custom (0A.5). The generic matrix uses PUT for the readBack reason in the
// header; this block pins the DELETE path's ownership predicate directly. Since BUG-DELNOOPOK-001 a
// foreign DELETE returns 404 (was: a silent no-op 200 — a cosmetic weakness, never a leak) AND must
// leave the owner's row live. BOTH assertions are kept on purpose and they are separate claims: the
// 404 proves the RESPONSE was gated, only the deleted_at read-back proves the UPDATE never fired.
// A handler that 404s after mutating would pass the status check alone. The row-state assertion is
// the soft-delete-bypass guard — it goes red the moment `user_id = ANY(householdIds)` is dropped
// from the DELETE predicate; do not drop it as redundant now that the status is meaningful. ───────
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

  it('foreign DELETE owner storage_location → 404, row still live (deleted_at NULL)', async () => {
    setTestUserId(FOREIGN)
    const { status } = await callHandler(storageHandler, { method: 'DELETE', path: `/api/storage-locations/${locId}` })
    expect(status).toBe(404) // BUG-DELNOOPOK-001 RETURNING gate: 0 rows scoped ⇒ 404, not a no-op 200
    const r = await directSql`SELECT deleted_at FROM storage_location WHERE id = ${locId}`
    expect(r[0].deleted_at).toBeNull() // separate claim: assert the ROW, not the echo — see block header
  })

  it('owner DELETE own storage_location → 200 and row soft-deleted', async () => {
    setTestUserId(OWNER)
    const { status } = await callHandler(storageHandler, { method: 'DELETE', path: `/api/storage-locations/${locId}` })
    expect(status).toBe(200)
    const r = await directSql`SELECT deleted_at FROM storage_location WHERE id = ${locId}`
    expect(r[0].deleted_at).not.toBeNull()
  })
})
