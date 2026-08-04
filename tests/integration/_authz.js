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
// COVERAGE (0A.5 is a boss-sized workstream, Phase 0→1). Landed: plants (full), events (read +
// deleted_at + write-axis PATCH-resolve/DELETE-undo), locations (full, PHOTOLOCAUTHZ arm), plus
// public-share, /api/members, and entity-tags (own *.int.test.js files). NEXT SWEEP (each needs its
// own seed fixture; ride 0A.6 for the fixes):
//   - photos read paths (lambda/photos/index.js project_id :366-377 / unfiltered :379-389 /
//     view-url :318-322) deleted_at filters
//   - remaining write handlers (inventory-items, harvests, storage-location, preservation, favorites)
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

// ── SECOND HARNESS: body-supplied PARENT ids (BUG-PARENTOWN-001) ──────────────────────────────────
//
// WHY describeAuthzMatrix ABOVE CANNOT COVER THIS, which is exactly why the gap survived two
// per-site fixes. That matrix is RESOURCE-centric: it seeds a row owned by OWNER and proves FOREIGN
// cannot read or mutate THAT row. The defect class here is the opposite direction — the attacker
// creates a BRAND NEW row OF THEIR OWN and points its parent FK at the victim's container / planting
// / event / location / inventory item. Nothing owned by the victim is read or written, so every arm
// of the resource matrix passes while the hole is wide open. A DB foreign key proves the referenced
// row EXISTS; it never proves the caller OWNS it.
//
// This harness is the compensating control for that class, and it is deliberately generated PER FK
// COLUMN so instance N+1 fails CI by name instead of being found by audit.
//
// EACH COLUMN GETS TWO ARMS, and BOTH are load-bearing:
//   1. own-parent    → the SAME request with the caller's OWN parent id must still SUCCEED. Without
//                      this, a handler that blanket-rejects every parent id passes the security arm
//                      while breaking every real user. A predicate that quietly narrows legitimate
//                      access is worse than the bug.
//   2. foreign-parent→ 400, the error is GENERIC (no "not found" vs "forbidden" oracle), and the DB
//                      is proven to hold ZERO rows referencing the victim's id. Assert the DATABASE,
//                      never the handler's echo.
//
// cfg fields:
//   name             string label
//   handler          Lambda handler under test
//   columns          [string] — the body FK columns to generate arms for
//   seedParents      async (userId) => ({ [column]: parentId }) — one owned parent per column
//   request          (patch, ownIds) => { method, path, body } — a request that is otherwise VALID
//   countReferencing async (column, parentId, subs) => number — rows THE ATTACKER wrote against that
//                    parent id. subs = { VICTIM, ATTACKER }. Scope the count to the attacker's
//                    created_by: the victim's own fixtures legitimately reference their own parents,
//                    so an unscoped count is non-zero before the first request and asserts nothing.
//   okStatus         (opt) expected own-parent status, default 201
//   cleanup          (opt) async ({ VICTIM, ATTACKER, victimIds, attackerIds }) => void
export function describeForeignParentMatrix(cfg) {
  const RUN = testRunId()
  const VICTIM = cfg.victim ?? `authz_fp_victim_${RUN}`
  const ATTACKER = cfg.attacker ?? `authz_fp_attacker_${RUN}`
  const okStatus = cfg.okStatus ?? 201

  describe(`AUTHZ ${cfg.name} — body-supplied parent ids are household-gated (BUG-PARENTOWN-001)`, () => {
    let victimIds = {}
    let attackerIds = {}

    beforeAll(async () => {
      setTestUserId(VICTIM)
      victimIds = await cfg.seedParents(VICTIM)
      setTestUserId(ATTACKER)
      attackerIds = await cfg.seedParents(ATTACKER)
    })

    afterAll(async () => {
      if (cfg.cleanup) await cfg.cleanup({ VICTIM, ATTACKER, victimIds, attackerIds })
    })

    for (const column of cfg.columns) {
      it(`${column} — OWN parent still accepted (the gate must not narrow real access)`, async () => {
        setTestUserId(ATTACKER)
        const own = attackerIds[column]
        expect(own, `fixture bug: seedParents produced no ${column} for the attacker`).toBeTruthy()
        const { status, body } = await callHandler(cfg.handler, cfg.request({ [column]: own }, attackerIds))
        // Carry the response body: integration tests only run in CI, so a bare status number is a
        // failure that cannot name itself.
        expect(status, `${cfg.name} ${column}=own → ${status}: ${JSON.stringify(body)}`).toBe(okStatus)
      })

      it(`${column} — FOREIGN parent rejected 400, generically, and nothing is written`, async () => {
        setTestUserId(ATTACKER)
        const foreign = victimIds[column]
        expect(foreign, `fixture bug: seedParents produced no ${column} for the victim`).toBeTruthy()
        const { status, body } = await callHandler(cfg.handler, cfg.request({ [column]: foreign }, attackerIds))
        expect(status, `${cfg.name} ${column}=foreign → ${status}: ${JSON.stringify(body)} — ownership predicate missing?`).toBe(400)
        expect(
          String(body?.error ?? ''),
          `${cfg.name} ${column}: the 400 must not distinguish "not found" from "forbidden" — that distinction is itself an existence oracle. Got: ${JSON.stringify(body)}`,
        ).not.toMatch(/not found|forbidden|denied|no permission|unauthor/i)
        const leaked = await cfg.countReferencing(column, foreign, { VICTIM, ATTACKER })
        expect(
          leaked,
          `${cfg.name} ${column}: ${leaked} row(s) persisted against the victim's ${column} — the predicate did not hold (assert the DB, never the echo)`,
        ).toBe(0)
      })
    }
  })
}
