// authz-matrix.int.test.js — 0A.5 authz harness applied per endpoint.
// The reusable 4-arm ownership matrix (see _authz.js) run against real Postgres. This is the
// compensating control for the RLS-off posture: it proves ownership predicates are enforced and
// fails the moment one is removed. Landed coverage: plants (full read+write+deleted_at), events
// (read + deleted_at + write-axis PATCH-resolve/DELETE-undo, below). Remaining endpoints are
// enumerated in _authz.js §COVERAGE (Phase-1 sweep).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, setTestUserId, testRunId } from './_harness.js'
import { describeAuthzMatrix } from './_authz.js'
import { handler as plantsHandler } from '../../lambda/plants/index.js'
import { handler as eventsHandler } from '../../lambda/events/index.js'
import { handler as locationsHandler } from '../../lambda/locations/index.js'

// ── plants /api/plants/:id — full matrix (read + write via PUT + deleted_at) ──────────────────
describeAuthzMatrix({
  name: 'plants /api/plants/:id',
  handler: plantsHandler,
  setupOwner: async (owner) => {
    const p = await directSql`
      INSERT INTO plant_projects (name, slug, created_by)
      VALUES (${'authz-plt-' + owner}, ${'authz-plt-' + owner}, ${owner}) RETURNING id
    `
    return { projectId: p[0].id }
  },
  seedResource: async (owner, ctx) => {
    const r = await directSql`
      INSERT INTO plants (project_id, name, created_by)
      VALUES (${ctx.projectId}, ${'authz-plant-' + owner}, ${owner}) RETURNING id
    `
    return r[0].id
  },
  read: (id) => ({ method: 'GET', path: `/api/plants/${id}` }),
  write: (id) => ({ method: 'PUT', path: `/api/plants/${id}`, body: { name: 'authz-mutated' } }),
  softDelete: async (id) => { await directSql`UPDATE plants SET deleted_at = NOW() WHERE id = ${id}` },
  readBack: async (id) => {
    const r = await directSql`SELECT name FROM plants WHERE id = ${id}`
    return r[0] ?? null
  },
  cleanup: async (ctx) => {
    // entity registry (planting_ref_id) FK is ON DELETE RESTRICT — clear before plants.
    await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id IN (SELECT id FROM plants WHERE created_by = ${ctx.__owner})`
    await directSql`DELETE FROM plants WHERE created_by = ${ctx.__owner}`
    await directSql`DELETE FROM plant_projects WHERE created_by = ${ctx.__owner}`
  },
})

// ── events /api/events/:id — read arms + deleted_at ───────────────────────────────────────────
// (write axis = PATCH resolve on a flagged event / DELETE undo — landed below as a custom block)
describeAuthzMatrix({
  name: 'events /api/events/:id',
  handler: eventsHandler,
  setupOwner: async (owner) => {
    const p = await directSql`
      INSERT INTO plant_projects (name, slug, created_by)
      VALUES (${'authz-evt-' + owner}, ${'authz-evt-' + owner}, ${owner}) RETURNING id
    `
    return { projectId: p[0].id }
  },
  seedResource: async (owner, ctx) => {
    const e = await directSql`
      INSERT INTO event_log (project_id, event_type, event_date, is_public, logged_by, created_by)
      VALUES (${ctx.projectId}, 'observation', NOW(), true, ${owner}, ${owner}) RETURNING id
    `
    return e[0].id
  },
  read: (id) => ({ method: 'GET', path: `/api/events/${id}` }),
  softDelete: async (id) => { await directSql`UPDATE event_log SET deleted_at = NOW() WHERE id = ${id}` },
  cleanup: async (ctx) => {
    await directSql`DELETE FROM event_log WHERE created_by = ${ctx.__owner}`
    await directSql`DELETE FROM plant_projects WHERE created_by = ${ctx.__owner}`
  },
})

// ── locations /api/locations/:id — full matrix (Phase-1 sweep; PHOTOLOCAUTHZ arm) ─────────────
// Locations are household-scoped directly (created_by = ANY(householdScope)); no project fixture.
// NB: read MUST be GET /:id (single object) — GET /api/locations returns an object, not an array.
// write MUST be PUT (DELETE returns 200 unconditionally — no RETURNING gate — so it can't signal denial).
describeAuthzMatrix({
  name: 'locations /api/locations/:id',
  handler: locationsHandler,
  seedResource: async (owner) => {
    const r = await directSql`
      INSERT INTO locations (name, slug, level, created_by)
      VALUES (${'authz-loc-' + owner}, ${'authz-loc-' + owner}, ${0}, ${owner}) RETURNING id
    `
    return r[0].id
  },
  read: (id) => ({ method: 'GET', path: `/api/locations/${id}` }),
  write: (id) => ({ method: 'PUT', path: `/api/locations/${id}`, body: { name: 'authz-mutated' } }),
  softDelete: async (id) => { await directSql`UPDATE locations SET deleted_at = NOW() WHERE id = ${id}` },
  readBack: async (id) => {
    const r = await directSql`SELECT name FROM locations WHERE id = ${id}`
    return r[0] ?? null
  },
  cleanup: async (ctx) => {
    await directSql`DELETE FROM locations WHERE created_by = ${ctx.__owner}`
  },
})

// ── events WRITE-AXIS /api/events/:id — custom: PATCH-resolve + DELETE-undo ownership (0A.5) ───
// The generic matrix above covers events READ + deleted_at. The WRITE axis needs custom arms: PATCH
// resolves a flagged_as_issue event ({resolved:true}) and DELETE soft-deletes (undo). Both gate on
// the same container join `pp.created_by = ANY(householdIds)` (lambda/events/index.js:683-700 PATCH,
// :844-854 DELETE) and return 404 (not 403) to a non-owner. The non-owner arms assert the target row
// is provably UNCHANGED (resolved_at / deleted_at still NULL) — the ownership-bypass regression guard
// that fails the moment the predicate is dropped.
describe('AUTHZ events write-axis /api/events/:id — PATCH-resolve + DELETE-undo (0A.5)', () => {
  const RUN = testRunId()
  const OWNER = `authz_evtw_owner_${RUN}`
  const FOREIGN = `authz_evtw_foreign_${RUN}`
  let projectId

  beforeAll(async () => {
    const p = await directSql`
      INSERT INTO plant_projects (name, slug, created_by)
      VALUES (${'authz-evtw-' + OWNER}, ${'authz-evtw-' + OWNER}, ${OWNER}) RETURNING id`
    projectId = p[0].id
  })

  afterAll(async () => {
    await directSql`DELETE FROM event_log WHERE created_by = ${OWNER}`
    await directSql`DELETE FROM plant_projects WHERE created_by = ${OWNER}`
  })

  // A fresh flagged issue event owned by OWNER. severity is smallint 1-3 (event_log_severity_check);
  // chk_event_log_severity_requires_flag permits a non-null severity only when flagged_as_issue.
  const seedFlagged = async () => {
    const e = await directSql`
      INSERT INTO event_log (project_id, event_type, event_date, flagged_as_issue, severity, is_public, logged_by, created_by)
      VALUES (${projectId}, 'observation', NOW(), true, ${2}, false, ${OWNER}, ${OWNER}) RETURNING id`
    return e[0].id
  }

  it('owner-resolve: PATCH {resolved:true} on own flagged event → 200, resolved_at set', async () => {
    const id = await seedFlagged()
    setTestUserId(OWNER)
    const { status, body } = await callHandler(eventsHandler, {
      method: 'PATCH', path: `/api/events/${id}`, body: { resolved: true },
    })
    expect(status).toBe(200)
    expect(body.resolved_at).toBeTruthy()
    const r = await directSql`SELECT resolved_at FROM event_log WHERE id = ${id}`
    expect(r[0].resolved_at).not.toBeNull()
  })

  it('non-owner-resolve: foreign PATCH {resolved:true} → 404, resolved_at still NULL', async () => {
    const id = await seedFlagged()
    setTestUserId(FOREIGN)
    const { status } = await callHandler(eventsHandler, {
      method: 'PATCH', path: `/api/events/${id}`, body: { resolved: true },
    })
    expect(status).toBe(404)
    const r = await directSql`SELECT resolved_at FROM event_log WHERE id = ${id}`
    expect(r[0].resolved_at).toBeNull() // ownership-bypass regression guard
  })

  it('owner-undo: DELETE own event → 200 undone, row soft-deleted', async () => {
    const id = await seedFlagged()
    setTestUserId(OWNER)
    const { status, body } = await callHandler(eventsHandler, { method: 'DELETE', path: `/api/events/${id}` })
    expect(status).toBe(200)
    expect(body.undone).toBe(true)
    const r = await directSql`SELECT deleted_at FROM event_log WHERE id = ${id}`
    expect(r[0].deleted_at).not.toBeNull()
  })

  it('non-owner-undo: foreign DELETE owner event → 404, row still live (deleted_at NULL)', async () => {
    const id = await seedFlagged()
    setTestUserId(FOREIGN)
    const { status } = await callHandler(eventsHandler, { method: 'DELETE', path: `/api/events/${id}` })
    expect(status).toBe(404)
    const r = await directSql`SELECT deleted_at FROM event_log WHERE id = ${id}`
    expect(r[0].deleted_at).toBeNull() // soft-delete-bypass regression guard
  })
})
