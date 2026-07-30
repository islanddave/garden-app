// authz-matrix.int.test.js — 0A.5 authz harness applied per endpoint.
// The reusable 4-arm ownership matrix (see _authz.js) run against real Postgres. This is the
// compensating control for the RLS-off posture: it proves ownership predicates are enforced and
// fails the moment one is removed. Landed coverage: plants (full read+write+deleted_at), events
// (read + deleted_at). Remaining endpoints are enumerated in _authz.js §COVERAGE (Phase-1 sweep).

import { directSql } from './_harness.js'
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
// (write axis = PATCH resolve on a flagged event / DELETE undo — added in the sweep, see _authz.js)
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
