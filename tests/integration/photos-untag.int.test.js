// photos-untag.int.test.js — V4-PHOTOUNTAG-001 against REAL Postgres (ephemeral Neon branch off
// staging, which carries both live CHECKs: photos_intake_status_valid and the 7-clause
// photos_must_have_parent).
//
// WHY THIS FILE EXISTS. The whole lambda/photos/*.test.js suite is mock-sql: it executes the real
// extracted functions against a recording fake `sql` and asserts on the statement and parameters the
// handler EMITS. Nothing in it stores a row or lets Postgres evaluate a constraint, so "the emitted
// UPDATE satisfies photos_must_have_parent" was an INFERENCE from separately-read constraint text.
// This file is the observation.
//
// The bigger risk is not the new feature. V4-PHOTOUNTAG-001 lifted the ALREADY-SHIPPED re-tag UPDATE
// out of the route body into buildRetagUpdate(), so every user hitting the ordinary tag flow now runs
// through code that no database had ever executed. The first describe block is that regression guard
// and is deliberately the first thing here; the un-tag is second.
//
// Overlap with photos-intake.int.test.js is intentional and load-bearing, not redundancy: that file
// pins the V4-PHOTOBULK-001 drain behaviour, which is precisely the behaviour the refactor could
// silently break. Where it asserts the two columns it cared about, this file asserts the FULL
// persisted shape of the SET list, so a mangled or reordered assignment is caught rather than
// averaged out.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId, insertProject } from './_harness.js'
import { settle } from './_cleanup.js'

// The handler throws at MODULE LOAD if S3_PHOTOS_BUCKET is unset, and vi.mock factories + this block
// are hoisted above the import below.
vi.hoisted(() => {
  process.env.S3_PHOTOS_BUCKET = 'garden-photos-int-test'
  process.env.AWS_REGION = 'us-east-1'
})

// Deterministic presign — no AWS credentials in CI, and this route never signs anything anyway.
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async (_client, cmd) =>
    `https://stub-s3.invalid/${cmd?.input?.Key ?? 'unknown'}?signed=1`),
}))

const { handler } = await import('../../lambda/photos/index.js')

const RUN = testRunId()
const USER = `user_int_untag_${RUN}`
const FOREIGN_USER = `user_int_untag_foreign_${RUN}`

let projectId
let plantId
let plantIdB
let locationId

async function insertPhoto({ label, intake = null, plant = null, project = null, location = null, owner = USER }) {
  const rows = await directSql`
    INSERT INTO photos (storage_path, uploaded_by, created_by, intake_status, plant_id, project_id, location_id)
    VALUES (${`inbox/${owner}/${label}-${RUN}.jpg`}, ${owner}, ${owner}, ${intake}, ${plant}, ${project}, ${location})
    RETURNING id
  `
  return rows[0].id
}

// Read the row back from the DATABASE, never from the handler echo — a handler that returns the
// right JSON while persisting the wrong row is exactly the failure this file is here to catch.
async function readPhoto(id) {
  const rows = await directSql`
    SELECT intake_status, project_id, location_id, plant_id, caption, event_id, inventory_item_id
      FROM photos WHERE id = ${id}
  `
  return rows[0]
}

// `container` and `garden_node` are VIEWS over plant_projects and plants; fixtures are written
// against the BASE tables and the handler reads through the views, which is the path prod uses. The
// plant must hang off a project owned by USER or loadOwnedPlantingRef rejects the re-tag and the
// ordinary-tag test would 400 for a fixture reason rather than pass for a real one.
beforeAll(async () => {
  setTestUserId(USER)

  const proj = await insertProject({ name: `int-untag-proj-${RUN}`, createdBy: USER })
  projectId = proj.id

  const p1 = await directSql`
    INSERT INTO plants (name, project_id, created_by)
    VALUES (${`int-untag-plant-${RUN}`}, ${projectId}, ${USER}) RETURNING id`
  plantId = p1[0].id

  const p2 = await directSql`
    INSERT INTO plants (name, project_id, created_by)
    VALUES (${`int-untag-plantB-${RUN}`}, ${projectId}, ${USER}) RETURNING id`
  plantIdB = p2[0].id

  const loc = await directSql`
    INSERT INTO locations (name, slug, level, created_by)
    VALUES (${`int-untag-loc-${RUN}`}, ${`int-untag-loc-${RUN}`}, ${0}, ${USER}) RETURNING id`
  locationId = loc[0].id
})

afterAll(async () => {
  // Hard delete is the sanctioned carve-out for fixtures. settle() runs every step even when an
  // earlier one throws — a bare await chain here is the BUG-INTFIXTURELEAK-001 defect itself.
  // Order: FKs point photos/evidence at the plants, featured_photo_id points the other way, and a
  // trigger auto-registers an `entity` row per planting with ON DELETE RESTRICT.
  await settle('photos-untag', [
    () => directSql`DELETE FROM evidence WHERE created_by IN (${USER}, ${FOREIGN_USER})`,
    () => directSql`DELETE FROM photos WHERE created_by IN (${USER}, ${FOREIGN_USER})`,
    () => directSql`UPDATE plants SET featured_photo_id = NULL WHERE project_id = ${projectId}`,
    () => directSql`UPDATE plant_projects SET featured_photo_id = NULL WHERE id = ${projectId}`,
    () => directSql`DELETE FROM entity WHERE entity_type = 'planting' AND planting_ref_id IN (${plantId}, ${plantIdB})`,
    () => directSql`DELETE FROM plants WHERE project_id = ${projectId}`,
    () => directSql`DELETE FROM plant_projects WHERE id = ${projectId}`,
    () => directSql`DELETE FROM locations WHERE id = ${locationId}`,
  ])
})

// CROSS-FILE ENV LEAK GUARD. SPACE_PHOTOS_ENABLED is toggled in-process by space-photos.int.test.js,
// vitest reuses workers across files, and process.env is per-worker. Every assertion below assumes
// the flag-OFF shape of setsParent (no space_id pre-read); inheriting a stale `true` would make the
// un-tag cases silently exercise a different branch while still claiming to test this one.
beforeEach(() => {
  expect(process.env.SPACE_PHOTOS_ENABLED, 'stale SPACE_PHOTOS_ENABLED leaked from another test file').toBeUndefined()
})

// ── 1. THE ORDINARY TAG — regression guard on the buildRetagUpdate() extraction ───────────────────
// Every shipped client hits this path; none can reach the un-tag branch. If the lift broke the SET
// list, the parameter order, or the CASE's first arm, it breaks here and only here.
describe('PUT /api/photos/:id — the ordinary tag still works after the lift', () => {
  it('a parentless pending_tag row takes a plant_id: status clears, parent persists', async () => {
    const id = await insertPhoto({ label: 'tag-plant', intake: 'pending_tag' })

    const res = await callHandler(handler, {
      method: 'PUT', path: `/api/photos/${id}`, body: { plant_id: plantId, caption: 'tagged by test' },
    })
    expect(res.status).toBe(200)

    const row = await readPhoto(id)
    expect(row.intake_status).toBeNull()
    expect(row.plant_id).toBe(plantId)
    expect(row.project_id).toBeNull()
    expect(row.location_id).toBeNull()
    expect(row.caption).toBe('tagged by test')

    // And it must leave the index the quick-tag carousel reads.
    const pending = await directSql`
      SELECT id FROM photos
       WHERE created_by = ${USER} AND deleted_at IS NULL AND intake_status = 'pending_tag' AND id = ${id}`
    expect(pending).toHaveLength(0)
  })

  it('lands all three parent columns the SET list owns, in the right ones', async () => {
    // A transposed assignment (plant_id <- body.location_id, say) survives every source-text guard
    // and every emitted-SQL assertion that reads the CASE rather than the SET list. Only a real row
    // distinguishes it, and only when the three ids differ.
    const id = await insertPhoto({ label: 'tag-all-three', intake: 'pending_tag' })

    const res = await callHandler(handler, {
      method: 'PUT', path: `/api/photos/${id}`,
      body: { project_id: projectId, location_id: locationId, plant_id: plantId },
    })
    expect(res.status).toBe(200)

    const row = await readPhoto(id)
    expect(row.project_id).toBe(projectId)
    expect(row.location_id).toBe(locationId)
    expect(row.plant_id).toBe(plantId)
    expect(row.intake_status).toBeNull()
  })

  it('a re-tag of an already-tagged row moves the parent and leaves the status NULL', async () => {
    const id = await insertPhoto({ label: 'retag-correction', plant: plantId })

    const res = await callHandler(handler, {
      method: 'PUT', path: `/api/photos/${id}`, body: { plant_id: plantIdB },
    })
    expect(res.status).toBe(200)

    const row = await readPhoto(id)
    expect(row.plant_id).toBe(plantIdB)
    expect(row.intake_status).toBeNull()
  })

  it('a parent set alongside an explicit pending_tag still drains — arm order is the contract', async () => {
    // A full-replace client that echoes the row's current intake_status back while tagging must not
    // be able to leave the photo in the inbox it just left. setsParent is tested first in the CASE;
    // this is that ordering observed against a stored row rather than read out of the SQL text.
    const id = await insertPhoto({ label: 'tag-echoes-status', intake: 'pending_tag' })

    const res = await callHandler(handler, {
      method: 'PUT', path: `/api/photos/${id}`,
      body: { plant_id: plantId, intake_status: 'pending_tag' },
    })
    expect(res.status).toBe(200)

    const row = await readPhoto(id)
    expect(row.plant_id).toBe(plantId)
    expect(row.intake_status).toBeNull()
  })
})

// ── 2. THE UN-TAG — the new branch, round-tripped ─────────────────────────────────────────────────
describe('PUT /api/photos/:id — returning a photo to the untagged inbox', () => {
  it('clears every parent and restores pending_tag without violating photos_must_have_parent', async () => {
    const id = await insertPhoto({ label: 'untag-basic', plant: plantId })

    const res = await callHandler(handler, {
      method: 'PUT', path: `/api/photos/${id}`,
      body: { project_id: null, location_id: null, plant_id: null, intake_status: 'pending_tag' },
    })
    expect(res.status).toBe(200)

    const row = await readPhoto(id)
    expect(row.intake_status).toBe('pending_tag')
    expect(row.plant_id).toBeNull()
    expect(row.project_id).toBeNull()
    expect(row.location_id).toBeNull()

    // The point of the feature: it is back in the carousel's index.
    const pending = await directSql`
      SELECT id FROM photos
       WHERE created_by = ${USER} AND deleted_at IS NULL AND intake_status = 'pending_tag' AND id = ${id}`
    expect(pending).toHaveLength(1)
  })

  it('survives a tag -> un-tag -> re-tag round trip', async () => {
    // Drain-only was a one-way door. Proving the door swings both ways twice is what makes this a
    // round trip rather than two independent single-shot writes.
    const id = await insertPhoto({ label: 'untag-roundtrip', intake: 'pending_tag' })

    await callHandler(handler, { method: 'PUT', path: `/api/photos/${id}`, body: { plant_id: plantId } })
    expect((await readPhoto(id)).intake_status).toBeNull()

    await callHandler(handler, {
      method: 'PUT', path: `/api/photos/${id}`,
      body: { project_id: null, location_id: null, plant_id: null, intake_status: 'pending_tag' },
    })
    const untagged = await readPhoto(id)
    expect(untagged.intake_status).toBe('pending_tag')
    expect(untagged.plant_id).toBeNull()

    await callHandler(handler, { method: 'PUT', path: `/api/photos/${id}`, body: { plant_id: plantIdB } })
    const retagged = await readPhoto(id)
    expect(retagged.intake_status).toBeNull()
    expect(retagged.plant_id).toBe(plantIdB)
  })

  it('404s an un-tag of another household\'s photo and leaves that row untouched', async () => {
    // The prev CTE is the un-tag's ONLY ownership gate — the UPDATE carries no created_by predicate
    // of its own. Asserted here against a stored row, not against the emitted text.
    const id = await insertPhoto({ label: 'untag-foreign', plant: null, owner: FOREIGN_USER, intake: 'pending_tag' })

    const res = await callHandler(handler, {
      method: 'PUT', path: `/api/photos/${id}`,
      body: { project_id: null, location_id: null, plant_id: null, intake_status: 'pending_tag' },
    })
    expect(res.status).toBe(404)

    const row = await readPhoto(id)
    expect(row.intake_status).toBe('pending_tag')
    expect(row.plant_id).toBeNull()
  })
})

// ── 3. REJECTION BEFORE ANY WRITE ─────────────────────────────────────────────────────────────────
// resolveIntakeRequest runs ahead of all three ownership loaders and the UPDATE, so a rejected body
// must cost nothing. "Costs nothing" is only observable as a row that did not move.
describe('PUT /api/photos/:id — an intake_status outside the contract is refused before the write', () => {
  const REJECTED = ['upload_failed', 'tagged', 'PENDING_TAG', 'pending_tag ', '', 0, false, {}]

  it.each(REJECTED)('400s intake_status=%o and leaves the row exactly as it was', async (value) => {
    const id = await insertPhoto({ label: `reject-${Math.random().toString(36).slice(2, 7)}`, plant: plantId })

    const res = await callHandler(handler, {
      method: 'PUT', path: `/api/photos/${id}`,
      body: { project_id: null, location_id: null, plant_id: null, intake_status: value },
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/intake_status/)

    // The body ALSO asked to clear every parent. If the guard ran after the UPDATE instead of before
    // it, the row would be parentless here — or gone to a 23514 — rather than untouched.
    const row = await readPhoto(id)
    expect(row.plant_id).toBe(plantId)
    expect(row.intake_status).toBeNull()
  })

  it("'upload_failed' is refused even though POST accepts it", async () => {
    // Deliberately narrower than the module's INTAKE_STATUSES: it is valid under
    // photos_intake_status_valid but photos_must_have_parent still demands a parent for it, so on the
    // un-tag it would most plausibly accompany it is a guaranteed 23514. Pinned so a later "tidy" to
    // reuse INTAKE_STATUSES here fails loudly.
    const post = await callHandler(handler, {
      method: 'POST', path: '/api/photos',
      body: { storage_path: `inbox/${USER}/uf-${RUN}.jpg`, plant_id: plantId, intake_status: 'upload_failed' },
    })
    expect(post.status).toBe(201)

    const put = await callHandler(handler, {
      method: 'PUT', path: `/api/photos/${post.body.id}`,
      body: { plant_id: plantId, intake_status: 'upload_failed' },
    })
    expect(put.status).toBe(400)
  })
})

// ── 4. THE FAILURE THE WHOLE ITEM EXISTS BECAUSE OF ───────────────────────────────────────────────
// A parentless row may carry 'pending_tag' AND NOTHING ELSE. Clearing every parent without asking for
// 'pending_tag' therefore must not be able to leave a parentless NULL-status row behind. The route
// does NOT prevent it: the CASE falls to `ELSE p.intake_status`, so an already-tagged row keeps its
// NULL and Postgres is what refuses the write. That is the pre-existing behaviour V4-PHOTOUNTAG-001
// gives the client a way around, and the reason the un-tag must send 'pending_tag' explicitly.
describe('photos_must_have_parent is real and armed, not quoted', () => {
  it('refuses the raw UPDATE with 23514 naming the constraint (the CHECK, observed)', async () => {
    const id = await insertPhoto({ label: 'check-direct', plant: plantId })

    let caught = null
    try {
      await directSql`UPDATE photos SET plant_id = NULL, project_id = NULL, location_id = NULL WHERE id = ${id}`
    } catch (e) {
      caught = e
    }
    expect(caught, 'Postgres accepted a parentless NULL-status photo — the CHECK is missing or NOT VALID').not.toBeNull()

    const detail = `${caught.code ?? ''} ${caught.constraint ?? ''} ${caught.message ?? ''}`
    expect(detail).toMatch(/23514/)
    expect(detail).toMatch(/photos_must_have_parent/)

    // Single statement, so the rejection is atomic: nothing partially applied.
    expect((await readPhoto(id)).plant_id).toBe(plantId)
  })

  it('the route cannot produce a parentless NULL-status row — the write is rejected whole', async () => {
    const id = await insertPhoto({ label: 'check-route', plant: plantId })

    const res = await callHandler(handler, {
      method: 'PUT', path: `/api/photos/${id}`,
      body: { project_id: null, location_id: null, plant_id: null, caption: 'orphaning attempt' },
    })
    // isUpstream() does not classify a constraint violation, so it surfaces as 500 rather than 503.
    expect(res.status).toBe(500)

    const row = await readPhoto(id)
    expect(row.plant_id).toBe(plantId)
    expect(row.intake_status).toBeNull()
    expect(row.caption).toBeNull()
  })

  it('an explicitly-null intake_status means "not requested", not "clear it"', async () => {
    // Lane B chose the POST guard's `!= null` idiom over inventing a dialect where explicit null is a
    // third state. If that ever flipped to "requested", this body would null the status on a
    // parentless row and 23514 differently — or, worse, succeed and orphan it.
    const id = await insertPhoto({ label: 'check-explicit-null', plant: plantId })

    const res = await callHandler(handler, {
      method: 'PUT', path: `/api/photos/${id}`,
      body: { project_id: null, location_id: null, plant_id: null, intake_status: null },
    })
    expect(res.status).toBe(500)
    expect((await readPhoto(id)).plant_id).toBe(plantId)
  })

  it('leaves no parentless non-pending row anywhere in this run\'s fixtures', async () => {
    // The invariant stated positively, over every row every test above touched. The six columns are
    // the ones photos_must_have_parent names; this route can only write three of them, so the other
    // three are asserted null to prove the surviving rows are genuinely parentless and not merely
    // parentless-as-far-as-the-route-can-see.
    const orphans = await directSql`
      SELECT id, intake_status FROM photos
       WHERE created_by IN (${USER}, ${FOREIGN_USER})
         AND project_id IS NULL AND location_id IS NULL AND plant_id IS NULL
         AND event_id IS NULL AND inventory_item_id IS NULL AND space_id IS NULL
         AND intake_status IS DISTINCT FROM 'pending_tag'`
    expect(orphans).toEqual([])
  })
})
