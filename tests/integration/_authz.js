// _authz.js — reusable 4-arm ownership-matrix harness (devops plan 0A.5).
//
// WHY THIS EXISTS: garden-app has NO enforced Postgres RLS (the ~50 policies are decorative — the
// owner role is rolbypassrls=true and app.user_id is never set). Real authz is ~120 hand-written
// predicates inside the Lambda handlers (`created_by = ANY(householdIds)` /
// `pp.created_by = ANY(householdIds)` etc.). This harness is the LOAD-BEARING COMPENSATING CONTROL
// for that posture (D3a): it asserts, per endpoint, that ownership is actually enforced — and by
// construction it FAILS the moment a predicate is removed (the non-owner arms flip owner-only data
// to reachable). That "an intentionally-broken predicate fails the suite" property is the whole
// point (spec 0A.5 verification); do not weaken the non-owner assertions into soft checks.
//
// SUBSTRATE: the existing integration harness (_harness.js) — real Postgres via INT_DATABASE_URL
// (integration-test.yml provisions an ephemeral Neon branch per CI run), two identities via
// setTestUserId(sub), Clerk verifyToken stubbed. No new infra; this is a thin layer over it.
//
// FOUR ARMS + deleted_at, per endpoint:
//   1. owner-read      → allowed (200, resource returned)
//   2. non-owner-read  → DENIED  (denied status, or a list 200 that must NOT contain the id)
//   3. owner-write     → allowed (200/201/204)                              [only if cfg.write]
//   4. non-owner-write → DENIED  and the row is provably UNCHANGED          [only if cfg.write]
//   5. deleted_at      → a soft-deleted resource is excluded from owner reads [only if cfg.softDelete]
//
// USAGE: call describeAuthzMatrix({...}) at the top level of an *.int.test.js file. Arms run in
// declaration order on a single seeded resource (owner-write mutates it, deleted_at soft-deletes it
// last), which is intentional and deterministic under vitest.
//
// VERIFY IT BITES: temporarily delete a `created_by = ANY(${householdIds})` predicate from a
// handler and run the matrix — the corresponding non-owner arm must go red. (Do NOT commit that.)
//
// COVERAGE (0A.5 is a boss-sized workstream, Phase 0→1). Landed here: plants (full), events
// (read + deleted_at). NEXT SWEEP (each needs its own seed fixture; ride 0A.6 for the fixes):
//   - events write axis (PATCH resolve on a flagged event; DELETE undo ownership pre-check)
//   - the 4 known-leak endpoints locked in v3.74 — entity-tags (garden-tags upsert scope),
//     locations (PHOTOLOCAUTHZ arm), public share page (is_public gate), /api/members (household
//     scope + email drop)
//   - photos read paths (lambda/photos/index.js project_id :366-377 / unfiltered :379-389 /
//     view-url :318-322) deleted_at filters
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { callHandler, setTestUserId, testRunId } from './_harness.js'

// cfg fields:
//   name         string label for the describe block
//   handler      the Lambda handler under test
//   owner        (opt) owner clerk sub — defaults to a unique per-matrix id
//   foreign      (opt) non-owner clerk sub — defaults to a unique per-matrix id
//   setupOwner   (opt) async (ownerId) => ctx   — seed owner prerequisites (project etc.)
//   setupForeign (opt) async (foreignId) => any — seed foreign prerequisites if the read needs them
//   seedResource async (ownerId, ctx) => resourceId — create a resource owned by ownerId
//   read         (id) => { method:'GET', path } — single-resource (or scoped-list) read
//   write        (opt) (id) => { method, path, body } — a mutation
//   softDelete   (opt) async (id) => void — soft-delete the resource (directSql)
//   readBack     (opt) async (id) => row|null — proves the row is unchanged after a denied write
//   denied       (opt) expected denied status — default 404
//   cleanup      (opt) async (ctx) => void — teardown (FK-safe)
export function describeAuthzMatrix(cfg) {
  const RUN = testRunId()
  const OWNER = cfg.owner ?? `authz_owner_${RUN}`
  const FOREIGN = cfg.foreign ?? `authz_foreign_${RUN}`
  const denied = cfg.denied ?? 404

  describe(`AUTHZ ${cfg.name} — 4-arm ownership matrix + deleted_at (0A.5)`, () => {
    let ctx = {}
    let resourceId

    beforeAll(async () => {
      setTestUserId(OWNER)
      ctx = (await cfg.setupOwner?.(OWNER)) ?? {}
      ctx.__owner = OWNER
      ctx.__foreign = FOREIGN
      if (cfg.setupForeign) ctx.__foreignCtx = await cfg.setupForeign(FOREIGN)
      resourceId = await cfg.seedResource(OWNER, ctx)
    })

    afterAll(async () => { if (cfg.cleanup) await cfg.cleanup(ctx) })

    it('owner-read → allowed (200, resource returned)', async () => {
      setTestUserId(OWNER)
      const { status, body } = await callHandler(cfg.handler, cfg.read(resourceId))
      expect(status).toBe(200)
      const seen = Array.isArray(body) ? body.map((r) => r.id) : [body?.id]
      expect(seen).toContain(resourceId)
    })

    it('non-owner-read → DENIED (resource not leaked)', async () => {
      setTestUserId(FOREIGN)
      const { status, body } = await callHandler(cfg.handler, cfg.read(resourceId))
      if (status === 200 && Array.isArray(body)) {
        expect(body.map((r) => r.id)).not.toContain(resourceId) // scoped-list read: id must be absent
      } else {
        expect(status).toBe(denied)
      }
    })

    if (cfg.write) {
      it('owner-write → allowed', async () => {
        setTestUserId(OWNER)
        const { status } = await callHandler(cfg.handler, cfg.write(resourceId))
        expect([200, 201, 204]).toContain(status)
      })

      it('non-owner-write → DENIED and row UNCHANGED', async () => {
        const before = cfg.readBack ? await cfg.readBack(resourceId) : null
        setTestUserId(FOREIGN)
        const { status } = await callHandler(cfg.handler, cfg.write(resourceId))
        expect(status).toBe(denied)
        if (cfg.readBack) {
          const after = await cfg.readBack(resourceId)
          expect(after).toEqual(before) // the denied write must not have mutated the row
        }
      })
    }

    if (cfg.softDelete) {
      it('deleted_at → soft-deleted resource excluded from owner reads', async () => {
        await cfg.softDelete(resourceId)
        setTestUserId(OWNER)
        const { status, body } = await callHandler(cfg.handler, cfg.read(resourceId))
        if (status === 200 && Array.isArray(body)) {
          expect(body.map((r) => r.id)).not.toContain(resourceId)
        } else {
          expect(status).toBe(denied)
        }
      })
    }
  })
}
