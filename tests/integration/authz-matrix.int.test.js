// authz-matrix.int.test.js — 0A.5 authz harness applied per endpoint.
// The reusable 4-arm ownership matrix (see _authz.js) run against real Postgres. This is the
// compensating control for the RLS-off posture: it proves ownership predicates are enforced and
// fails the moment one is removed. Landed coverage: plants (full read+write+deleted_at), events
// (read + deleted_at + write-axis PATCH-resolve/DELETE-undo, below). Remaining endpoints are
// enumerated in _authz.js §COVERAGE (Phase-1 sweep).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { directSql, callHandler, setTestUserId, testRunId, insertProject } from './_harness.js'
import { describeAuthzMatrix, describeForeignParentMatrix } from './_authz.js'
import { handler as plantsHandler } from '../../lambda/plants/index.js'
import { handler as eventsHandler } from '../../lambda/events/index.js'
import { handler as locationsHandler } from '../../lambda/locations/index.js'

// lambda/photos throws at MODULE LOAD without S3_PHOTOS_BUCKET, so the env is hoisted above every
// import and the presigner stubbed (same treatment as photos-intake / photos-authz). The
// BUG-PARENTOWN-001 blocks at the bottom of this file are the only consumers.
// SPACE_PHOTOS_ENABLED is deliberately left unset: the space_id parent has been gated since
// V4-SPACEPHOTO-001 and is covered by space-photos.int.test.js.
vi.hoisted(() => {
  process.env.S3_PHOTOS_BUCKET = process.env.S3_PHOTOS_BUCKET ?? 'garden-photos-int-test'
  process.env.AWS_REGION = process.env.AWS_REGION ?? 'us-east-1'
})
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async (_c, cmd) => `https://stub-s3.invalid/${cmd?.input?.Key ?? 'unknown'}?signed=1`),
}))
const { handler: photosHandler } = await import('../../lambda/photos/index.js')

// ── plants /api/plants/:id — full matrix (read + write via PUT + deleted_at) ──────────────────
describeAuthzMatrix({
  name: 'plants /api/plants/:id',
  handler: plantsHandler,
  setupOwner: async (owner) => {
    const p = await insertProject({ name: 'authz-plt-' + owner, createdBy: owner })
    return { projectId: p.id }
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
    // V4-SOFTDELCASCADE-001: event_log.project_id is ON DELETE RESTRICT once 0c lands. This matrix
    // is green today only because its write body never sends `status` (no event rows created) —
    // that is a property, not a guarantee. Clear project-anchored events before plant_projects.
    await directSql`DELETE FROM event_log WHERE project_id IN (SELECT id FROM plant_projects WHERE created_by = ${ctx.__owner})`
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
    const p = await insertProject({ name: 'authz-evt-' + owner, createdBy: owner })
    return { projectId: p.id }
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
// write is PUT. That used to be FORCED: DELETE returned 200 unconditionally — no RETURNING gate —
// so it could not signal denial at all. BUG-DELNOOPOK-001 (2026-08-13) retired that constraint;
// DELETE now 404s on a foreign id like every other verb. PUT nonetheless STAYS the write axis, for
// a different and still-live reason: this matrix's `readBack` asserts that the attempted mutation
// did NOT land ('authz-mutated' must not appear), which only a mutating-but-not-destroying verb can
// express. A DELETE axis would have nothing to read back except a deleted_at that must stay null —
// a weaker claim on a row the matrix then could not reuse. The locations DELETE denial is pinned
// directly in locations.int.test.js instead. Do not re-add the old rationale; it is now false.
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
    projectId = (await insertProject({ name: 'authz-evtw-' + OWNER, createdBy: OWNER })).id
  })

  afterAll(async () => {
    // The write-axis arms go through the events handler, which emits an app_events telemetry row.
    await directSql`DELETE FROM app_events WHERE user_clerk_sub IN (${OWNER}, ${FOREIGN})`
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

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// BUG-PARENTOWN-001 — body-supplied PARENT-id ownership, one case per protected path.
//
// THE ARGUMENT FOR THESE CASES. This is the same defect five times over: entity-tags
// (BUG-TAGENTOWN-001), photos auto-promote locations (BUG-PHOTOLOCAUTHZ-001), events POST, photos
// POST and plants POST. All three earlier instances were fixed PER SITE, and each per-site fix left
// the next one standing — because the resource-centric matrix above structurally cannot see this
// class (see the long comment on describeForeignParentMatrix in _authz.js). These arms are what
// makes instance six fail CI by name instead of turning up in the next audit, and they are the point
// of the ticket rather than an accessory to it.
//
// NOT COVERED HERE, deliberately: POST /api/events (project_id, plant_id) — same class, same
// remedy, owned by the events lane. When that fix lands it belongs in this file as a third
// describeForeignParentMatrix block, seeding a container + planting per user exactly as below.
// ══════════════════════════════════════════════════════════════════════════════════════════════════

const FP_RUN = testRunId()

// Seed one owned parent of every kind for a given user. Shared by both blocks so the two paths are
// proven against identical fixtures.
async function seedAllParents(user) {
  const proj = await insertProject({ name: `fp-${user}`, createdBy: user })
  const loc = await directSql`
    INSERT INTO locations (name, slug, level, created_by)
    VALUES (${'fp-loc-' + user}, ${'fp-loc-' + user}, ${0}, ${user}) RETURNING id`
  const parent = await directSql`
    INSERT INTO plants (project_id, name, created_by)
    VALUES (${proj.id}, ${'fp-parent-' + user}, ${user}) RETURNING id`
  const succ = await directSql`
    INSERT INTO plants (project_id, name, created_by)
    VALUES (${proj.id}, ${'fp-succ-' + user}, ${user}) RETURNING id`
  const inv = await directSql`
    INSERT INTO inventory_items (user_id, created_by, type, name, category, quantity)
    VALUES (${user}, ${user}, 'durable', ${'fp-inv-' + user}, 'tools', ${1}) RETURNING id`
  const evt = await directSql`
    INSERT INTO event_log (project_id, event_type, event_date, is_public, logged_by, created_by)
    VALUES (${proj.id}, 'observation', NOW(), true, ${user}, ${user}) RETURNING id`
  return {
    project_id: proj.id,
    location_id: loc[0].id,
    parent_plant_id: parent[0].id,
    succession_group_id: succ[0].id,
    source_inventory_item_id: inv[0].id,
    plant_id: parent[0].id,
    inventory_item_id: inv[0].id,
    event_id: evt[0].id,
  }
}

// Teardown for seedAllParents + anything the arms created. Order is NOT cosmetic — three FK
// behaviours have to be unwound by hand (mirrors the afterAll in plants.int.test.js):
//   • photos.project_id is ON DELETE CASCADE and *.featured_photo_id points BACK at photos, so the
//     featured pointers must be nulled before photos go (auto-promote sets them on the own-parent arms).
//   • event_log.plant_id is ON DELETE RESTRICT (V4-EVTANCHORDEL-001), so any event anchored to a
//     fixture planting blocks the delete outright — the event_log sweeps below are REQUIRED, not
//     defensive, and the plant_id-scoped one cannot be folded into the created_by one (an event
//     logged by a different user still anchors to the planting). It was SET NULL until 2026-08-04,
//     which contradicted event_log_has_anchor and made a project-less planting undeletable with a
//     23514 that named a CHECK rather than the DELETE that caused it.
//   • photos.plant_id and photos.location_id are ON DELETE RESTRICT for the same reason
//     (photos_must_have_parent), so the photos sweep must precede plants AND locations.
//   • entity_memory.plant_id and entity.planting_ref_id are ON DELETE RESTRICT.
//   • plants.source_inventory_item_id is ON DELETE RESTRICT → inventory_items AFTER plants.
async function purgeParentFixtures(subs) {
  const users = [subs.VICTIM, subs.ATTACKER]
  await directSql`UPDATE plant_projects   SET featured_photo_id = NULL WHERE created_by = ANY(${users})`
  await directSql`UPDATE plants           SET featured_photo_id = NULL, featured_image_id = NULL WHERE created_by = ANY(${users})`
  await directSql`UPDATE locations        SET featured_photo_id = NULL WHERE created_by = ANY(${users})`
  await directSql`UPDATE inventory_items  SET featured_photo_id = NULL WHERE created_by = ANY(${users})`
  await directSql`DELETE FROM evidence    WHERE created_by = ANY(${users})`
  await directSql`DELETE FROM photos      WHERE created_by = ANY(${users})`
  await directSql`DELETE FROM event_log   WHERE created_by = ANY(${users})`
  await directSql`DELETE FROM event_log   WHERE plant_id IN (SELECT id FROM plants WHERE created_by = ANY(${users}))`
  await directSql`DELETE FROM entity_memory WHERE plant_id IN (SELECT id FROM plants WHERE created_by = ANY(${users}))`
  await directSql`DELETE FROM entity      WHERE entity_type='planting' AND planting_ref_id IN (SELECT id FROM plants WHERE created_by = ANY(${users}))`
  await directSql`DELETE FROM app_events  WHERE user_clerk_sub = ANY(${users})`
  await directSql`DELETE FROM plants      WHERE created_by = ANY(${users})`
  await directSql`DELETE FROM inventory_items WHERE created_by = ANY(${users})`
  await directSql`DELETE FROM locations   WHERE created_by = ANY(${users})`
  await directSql`DELETE FROM plant_projects WHERE created_by = ANY(${users})`
}

// ── POST /api/plants — 5 body FK columns (5th instance + the succession_group_id column the
//    V4-AUTHZSWEEP-001 pass missed on BOTH verbs) ────────────────────────────────────────────────
describeForeignParentMatrix({
  name: 'plants POST /api/plants',
  handler: plantsHandler,
  columns: ['project_id', 'location_id', 'parent_plant_id', 'source_inventory_item_id', 'succession_group_id'],
  seedParents: seedAllParents,
  request: (patch) => ({
    method: 'POST',
    path: '/api/plants',
    body: { name: `fp-plant-${FP_RUN}`, ...patch },
  }),
  countReferencing: async (column, id, subs) => {
    const by = subs.ATTACKER
    const q = {
      project_id: () => directSql`SELECT count(*)::int AS n FROM plants WHERE created_by = ${by} AND project_id = ${id}`,
      location_id: () => directSql`SELECT count(*)::int AS n FROM plants WHERE created_by = ${by} AND location_id = ${id}`,
      parent_plant_id: () => directSql`SELECT count(*)::int AS n FROM plants WHERE created_by = ${by} AND parent_plant_id = ${id}`,
      source_inventory_item_id: () => directSql`SELECT count(*)::int AS n FROM plants WHERE created_by = ${by} AND source_inventory_item_id = ${id}`,
      succession_group_id: () => directSql`SELECT count(*)::int AS n FROM plants WHERE created_by = ${by} AND succession_group_id = ${id}`,
    }[column]
    return (await q())[0].n
  },
  cleanup: purgeParentFixtures,
})

// ── POST /api/photos — 5 body FK columns (4th instance). space_id is already gated
//    (V4-AUTHZSWEEP-001) and is covered by space-photos.int.test.js. ────────────────────────────
describeForeignParentMatrix({
  name: 'photos POST /api/photos',
  handler: photosHandler,
  columns: ['project_id', 'plant_id', 'event_id', 'location_id', 'inventory_item_id'],
  seedParents: seedAllParents,
  // A distinct storage_path per call: no content_hash is sent, so the ON CONFLICT dedupe path
  // (which answers 200 + duplicate:true, not 201) is never reached.
  request: (patch) => ({
    method: 'POST',
    path: '/api/photos',
    body: { storage_path: `inbox/fp/${FP_RUN}-${Object.keys(patch)[0]}-${Math.random().toString(36).slice(2, 8)}.jpg`, ...patch },
  }),
  countReferencing: async (column, id, subs) => {
    const by = subs.ATTACKER
    const q = {
      project_id: () => directSql`SELECT count(*)::int AS n FROM photos WHERE created_by = ${by} AND project_id = ${id}`,
      plant_id: () => directSql`SELECT count(*)::int AS n FROM photos WHERE created_by = ${by} AND plant_id = ${id}`,
      event_id: () => directSql`SELECT count(*)::int AS n FROM photos WHERE created_by = ${by} AND event_id = ${id}`,
      location_id: () => directSql`SELECT count(*)::int AS n FROM photos WHERE created_by = ${by} AND location_id = ${id}`,
      inventory_item_id: () => directSql`SELECT count(*)::int AS n FROM photos WHERE created_by = ${by} AND inventory_item_id = ${id}`,
    }[column]
    return (await q())[0].n
  },
  cleanup: purgeParentFixtures,
})

// ── PUT /api/photos/:id — the re-tag verb RE-PARENTS from the body, so gating POST alone would have
//    left the identical hole reachable in two requests instead of one. Own photo, foreign target. ─
describe('AUTHZ photos PUT /api/photos/:id — re-tag cannot move a photo into another household (BUG-PARENTOWN-001)', () => {
  const VICTIM = `authz_fpput_victim_${FP_RUN}`
  const ATTACKER = `authz_fpput_attacker_${FP_RUN}`
  let victimIds, attackerIds, photoId

  beforeAll(async () => {
    victimIds = await seedAllParents(VICTIM)
    attackerIds = await seedAllParents(ATTACKER)
    const ph = await directSql`
      INSERT INTO photos (project_id, storage_path, uploaded_by, created_by)
      VALUES (${attackerIds.project_id}, ${`plants/fpput/${FP_RUN}.jpg`}, ${ATTACKER}, ${ATTACKER})
      RETURNING id`
    photoId = ph[0].id
  })

  afterAll(async () => { await purgeParentFixtures({ VICTIM, ATTACKER }) })

  for (const column of ['project_id', 'plant_id', 'location_id']) {
    it(`${column} — re-tag to an OWN ${column} still succeeds`, async () => {
      setTestUserId(ATTACKER)
      const { status, body } = await callHandler(photosHandler, {
        method: 'PUT', path: `/api/photos/${photoId}`, body: { [column]: attackerIds[column] },
      })
      expect(status, `PUT ${column}=own → ${status}: ${JSON.stringify(body)}`).toBe(200)
      expect(body[column]).toBe(attackerIds[column])
    })

    it(`${column} — re-tag to a FOREIGN ${column} → 400 and the row is UNCHANGED`, async () => {
      const before = (await directSql`SELECT project_id, plant_id, location_id FROM photos WHERE id = ${photoId}`)[0]
      setTestUserId(ATTACKER)
      const { status, body } = await callHandler(photosHandler, {
        method: 'PUT', path: `/api/photos/${photoId}`, body: { [column]: victimIds[column] },
      })
      expect(status, `PUT ${column}=foreign → ${status}: ${JSON.stringify(body)} — ownership predicate missing?`).toBe(400)
      // Assert the DATABASE. A rejected re-tag must not have run the UPDATE at all — this route has
      // full-replace semantics, so a half-applied one would also silently CLEAR the other parents.
      const after = (await directSql`SELECT project_id, plant_id, location_id FROM photos WHERE id = ${photoId}`)[0]
      expect(after, `rejected re-tag mutated the row: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`).toEqual(before)
    })
  }
})
