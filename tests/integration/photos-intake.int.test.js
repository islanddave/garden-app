// photos-intake.int.test.js — integration coverage for the V4-PHOTOBULK-001 intake surface of the
// photos Lambda. Runs the REAL handler (lambda/photos/index.js) against an ephemeral Neon branch;
// SecretsManager + Clerk are stubbed by the harness, S3 presigning is stubbed here (no AWS creds in
// CI, and getSignedUrl is a local HMAC we do not need to exercise for real).
//
// Before this file the photos Lambda had NO behavioral coverage at all — its sibling tests
// (lambda/photos/*.test.js) readFileSync() index.js and assert on SOURCE TEXT, because the handler
// was not importable from repo root. That is why `photos` is now in integration-test.yml's lambda
// dep-install loop.
//
// The three surfaces under test, and the specific defect each one pins:
//   PUT  /api/photos/:id   — tagging must CLEAR intake_status (the inbox could never drain), but
//                            ONLY when a parent is actually set (a full-replace un-tag that blindly
//                            nulled it would violate photos_must_have_parent -> 500), and must
//                            auto-promote a featured photo ONLY when the row WAS pending_tag.
//   POST /api/photos       — must persist the capture-metadata columns and must treat a repeat
//                            content_hash as a duplicate (200) instead of a 23505 -> opaque 500,
//                            without appending a second evidence row.
//   POST /api/photos/batch — must derive inbox/{userId}/{uuid}.{ext} server-side and accept no
//                            caller-supplied key.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId } from './_harness.js'

// The handler throws at MODULE LOAD if S3_PHOTOS_BUCKET is unset, and vi.mock factories + this
// block are hoisted above the import below.
vi.hoisted(() => {
  process.env.S3_PHOTOS_BUCKET = 'garden-photos-int-test'
  process.env.AWS_REGION = 'us-east-1'
})

// Deterministic presign — asserting on a real signature would test AWS, not us. The KEY is the
// security-relevant output, so it is echoed back verbatim for inspection.
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async (_client, cmd) =>
    `https://stub-s3.invalid/${cmd?.input?.Key ?? 'unknown'}?signed=1`),
}))

const { handler } = await import('../../lambda/photos/index.js')

const RUN = testRunId()
const USER = `user_int_photos_${RUN}`
const FOREIGN_USER = `user_int_photos_foreign_${RUN}`

let plantId
let plantIdB
let projectId

async function insertPhoto({ storagePath, intakeStatus = null, plant = null, owner = USER, contentHash = null }) {
  const rows = await directSql`
    INSERT INTO photos (storage_path, uploaded_by, created_by, intake_status, plant_id, content_hash)
    VALUES (${storagePath}, ${owner}, ${owner}, ${intakeStatus}, ${plant}, ${contentHash})
    RETURNING id
  `
  return rows[0].id
}

// `container` and `garden_node` are VIEWS over the base tables `plant_projects` and `plants`
// (container.id <- plant_projects.id, garden_node.container_id <- plants.project_id). Fixtures are
// written against the BASE tables; the handler reads/writes through the views, which is exactly the
// path prod uses. The plant must hang off a project owned by USER because the plant auto-promote
// joins container.created_by for its ownership check — a project-less plant would never promote and
// the test would pass for the wrong reason.
beforeAll(async () => {
  setTestUserId(USER)

  const proj = await directSql`
    INSERT INTO plant_projects (name, slug, created_by)
    VALUES (${'int-photos-proj-' + RUN}, ${'int-photos-proj-' + RUN}, ${USER})
    RETURNING id
  `
  projectId = proj[0].id

  const p1 = await directSql`
    INSERT INTO plants (name, project_id, created_by)
    VALUES (${'int-photos-plant-' + RUN}, ${projectId}, ${USER})
    RETURNING id
  `
  plantId = p1[0].id

  const p2 = await directSql`
    INSERT INTO plants (name, project_id, created_by)
    VALUES (${'int-photos-plantB-' + RUN}, ${projectId}, ${USER})
    RETURNING id
  `
  plantIdB = p2[0].id
})

afterAll(async () => {
  // Hard-delete is correct here: these are test fixtures, an explicit carve-out to Soft-Delete-Only.
  // Order matters — FKs point photos/evidence at the plants, and a trigger auto-registers an
  // `entity` row per planting with ON DELETE RESTRICT.
  await directSql`DELETE FROM evidence WHERE created_by IN (${USER}, ${FOREIGN_USER})`
  await directSql`DELETE FROM photos WHERE created_by IN (${USER}, ${FOREIGN_USER})`
  await directSql`UPDATE plants SET featured_photo_id = NULL WHERE project_id = ${projectId}`
  await directSql`UPDATE plant_projects SET featured_photo_id = NULL WHERE id = ${projectId}`
  await directSql`DELETE FROM entity WHERE entity_type = 'planting' AND planting_ref_id IN (${plantId}, ${plantIdB})`
  await directSql`DELETE FROM plants WHERE project_id = ${projectId}`
  await directSql`DELETE FROM plant_projects WHERE id = ${projectId}`
})

describe('PUT /api/photos/:id — bulk-intake tag path', () => {
  it('clears intake_status when a parent is set, so the inbox actually drains', async () => {
    const id = await insertPhoto({ storagePath: `inbox/${USER}/drain-${RUN}.jpg`, intakeStatus: 'pending_tag' })

    const res = await callHandler(handler, {
      method: 'PUT', path: `/api/photos/${id}`, body: { plant_id: plantId },
    })
    expect(res.status).toBe(200)

    // Read back from the DB, not the handler echo.
    const [row] = await directSql`SELECT intake_status, plant_id FROM photos WHERE id = ${id}`
    expect(row.intake_status).toBeNull()
    expect(row.plant_id).toBe(plantId)

    // And it must no longer match the index the carousel reads.
    const pending = await directSql`
      SELECT id FROM photos
       WHERE created_by = ${USER} AND deleted_at IS NULL AND intake_status = 'pending_tag' AND id = ${id}
    `
    expect(pending).toHaveLength(0)
  })

  it('KEEPS pending_tag when a full-replace PUT clears every parent (the CHECK would reject NULL)', async () => {
    const id = await insertPhoto({ storagePath: `inbox/${USER}/untag-${RUN}.jpg`, intakeStatus: 'pending_tag' })

    // No parent fields at all == "cleared" under this route's full-replace semantics.
    const res = await callHandler(handler, { method: 'PUT', path: `/api/photos/${id}`, body: { caption: 'no parent' } })

    // The naive fix (unconditional intake_status = NULL) makes this row parentless AND non-pending,
    // which photos_must_have_parent rejects -> 500. Staying pending_tag is the whole point.
    expect(res.status).toBe(200)
    const [row] = await directSql`SELECT intake_status, plant_id, caption FROM photos WHERE id = ${id}`
    expect(row.intake_status).toBe('pending_tag')
    expect(row.plant_id).toBeNull()
    expect(row.caption).toBe('no parent')
  })

  it('auto-promotes a featured photo when the row WAS pending_tag (a bulk tag is a first deposit)', async () => {
    const id = await insertPhoto({ storagePath: `inbox/${USER}/promote-${RUN}.jpg`, intakeStatus: 'pending_tag' })
    await directSql`UPDATE plants SET featured_photo_id = NULL WHERE id = ${plantId}`

    await callHandler(handler, { method: 'PUT', path: `/api/photos/${id}`, body: { plant_id: plantId } })

    const [plant] = await directSql`SELECT featured_photo_id FROM garden_node WHERE id = ${plantId}`
    expect(plant.featured_photo_id).toBe(id)
  })

  it('does NOT auto-promote when the row was already tagged (a re-tag is a correction)', async () => {
    // intake_status NULL from the start == a legacy/normal photo, already parented.
    const id = await insertPhoto({ storagePath: `plants/${plantIdB}/legacy-${RUN}.jpg`, plant: plantIdB })
    await directSql`UPDATE plants SET featured_photo_id = NULL WHERE id = ${plantIdB}`

    await callHandler(handler, { method: 'PUT', path: `/api/photos/${id}`, body: { plant_id: plantIdB } })

    const [plant] = await directSql`SELECT featured_photo_id FROM garden_node WHERE id = ${plantIdB}`
    expect(plant.featured_photo_id).toBeNull()
  })

  it('does not leak the internal prev_intake_status field to the client', async () => {
    const id = await insertPhoto({ storagePath: `inbox/${USER}/leak-${RUN}.jpg`, intakeStatus: 'pending_tag' })
    const res = await callHandler(handler, { method: 'PUT', path: `/api/photos/${id}`, body: { plant_id: plantId } })
    expect(res.body).not.toHaveProperty('prev_intake_status')
    expect(res.body).toHaveProperty('id', id)
  })

  it('404s on another household\'s photo instead of tagging it', async () => {
    const id = await insertPhoto({ storagePath: `inbox/x/foreign-${RUN}.jpg`, intakeStatus: 'pending_tag', owner: FOREIGN_USER })
    const res = await callHandler(handler, { method: 'PUT', path: `/api/photos/${id}`, body: { plant_id: plantId } })
    expect(res.status).toBe(404)

    const [row] = await directSql`SELECT intake_status, plant_id FROM photos WHERE id = ${id}`
    expect(row.intake_status).toBe('pending_tag')
    expect(row.plant_id).toBeNull()
  })
})

describe('POST /api/photos — capture metadata + duplicate handling', () => {
  it('persists the capture-metadata columns', async () => {
    const hash = `hash-meta-${RUN}`
    const res = await callHandler(handler, {
      method: 'POST',
      path: '/api/photos',
      body: {
        storage_path: `inbox/${USER}/meta-${RUN}.jpg`,
        plant_id: plantId,
        taken_at: '2026-06-06T12:45:00.000Z',
        content_hash: hash,
        file_size_bytes: 987654,
        mime_type: 'image/jpeg',
        original_filename: 'IMG_20260606_084500.jpg',
        gps_lat: null,
        gps_lon: null,
        intake_status: null,
      },
    })
    expect(res.status).toBe(201)

    const [row] = await directSql`
      SELECT taken_at, content_hash, file_size_bytes, mime_type, original_filename
        FROM photos WHERE content_hash = ${hash}
    `
    expect(row.content_hash).toBe(hash)
    expect(row.file_size_bytes).toBe(987654)
    expect(row.mime_type).toBe('image/jpeg')
    expect(row.original_filename).toBe('IMG_20260606_084500.jpg')
    expect(new Date(row.taken_at).toISOString()).toBe('2026-06-06T12:45:00.000Z')
  })

  it('returns 200 {duplicate:true} on a repeat content_hash rather than a 500, and writes no second row', async () => {
    const hash = `hash-dupe-${RUN}`
    const body = {
      storage_path: `inbox/${USER}/dupe-a-${RUN}.jpg`,
      plant_id: plantId,
      content_hash: hash,
      mime_type: 'image/jpeg',
    }

    const first = await callHandler(handler, { method: 'POST', path: '/api/photos', body })
    expect(first.status).toBe(201)
    expect(first.body.duplicate).toBeUndefined()

    const second = await callHandler(handler, {
      method: 'POST', path: '/api/photos',
      body: { ...body, storage_path: `inbox/${USER}/dupe-b-${RUN}.jpg` },
    })
    expect(second.status).toBe(200)
    expect(second.body.duplicate).toBe(true)
    // The EXISTING row is returned — not the re-uploaded key.
    expect(second.body.storage_path).toBe(`inbox/${USER}/dupe-a-${RUN}.jpg`)
    expect(second.body.id).toBe(first.body.id)

    const rows = await directSql`SELECT id FROM photos WHERE content_hash = ${hash}`
    expect(rows).toHaveLength(1)
  })

  it('does not append a second evidence row for a duplicate upload (DrG confidence poisoning)', async () => {
    const hash = `hash-eviptr-${RUN}`
    const body = {
      storage_path: `inbox/${USER}/ev-${RUN}.jpg`,
      plant_id: plantId,
      content_hash: hash,
      caption: `evidence probe ${RUN}`,
    }

    const first = await callHandler(handler, { method: 'POST', path: '/api/photos', body })
    expect(first.status).toBe(201)
    const photoId = first.body.id

    const afterFirst = await directSql`SELECT id FROM evidence WHERE photo_ref = ${photoId}`

    await callHandler(handler, { method: 'POST', path: '/api/photos', body })
    const afterSecond = await directSql`SELECT id FROM evidence WHERE photo_ref = ${photoId}`

    expect(afterSecond.length).toBe(afterFirst.length)
  })

  it('treats NULL content_hash rows as never colliding (every legacy caller sends none)', async () => {
    const a = await callHandler(handler, {
      method: 'POST', path: '/api/photos',
      body: { storage_path: `plants/${plantId}/legacy-a-${RUN}.jpg`, plant_id: plantId },
    })
    const b = await callHandler(handler, {
      method: 'POST', path: '/api/photos',
      body: { storage_path: `plants/${plantId}/legacy-b-${RUN}.jpg`, plant_id: plantId },
    })
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    expect(a.body.duplicate).toBeUndefined()
    expect(b.body.duplicate).toBeUndefined()
    expect(a.body.id).not.toBe(b.body.id)
  })
})

describe('POST /api/photos/batch — server-derived presign', () => {
  it('derives inbox/{userId}/{uuid}.{ext} and ignores any caller-supplied key', async () => {
    const res = await callHandler(handler, {
      method: 'POST', path: '/api/photos/batch',
      body: { files: [{ ext: 'jpg', content_type: 'image/jpeg', key: '../../etc/passwd' }] },
    })
    expect(res.status).toBe(200)
    expect(res.body.uploads).toHaveLength(1)

    const { key, upload_url } = res.body.uploads[0]
    expect(key).toMatch(new RegExp(`^inbox/${USER}/[0-9a-f-]{36}\\.jpg$`))
    expect(key).not.toContain('etc/passwd')
    expect(key).not.toContain('..')
    expect(upload_url).toContain(key)
  })

  it('issues distinct keys across a batch', async () => {
    const res = await callHandler(handler, {
      method: 'POST', path: '/api/photos/batch',
      body: { files: [{ ext: 'jpg' }, { ext: 'png' }, { ext: 'jpg' }] },
    })
    expect(res.status).toBe(200)
    const keys = res.body.uploads.map((u) => u.key)
    expect(new Set(keys).size).toBe(3)
    expect(keys[1]).toMatch(/\.png$/)
  })

  it('rejects a batch over the 20-file cap', async () => {
    const files = Array.from({ length: 21 }, () => ({ ext: 'jpg' }))
    const res = await callHandler(handler, { method: 'POST', path: '/api/photos/batch', body: { files } })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/max 20/)
  })

  it('rejects an ext that would escape the key space', async () => {
    const res = await callHandler(handler, {
      method: 'POST', path: '/api/photos/batch',
      body: { files: [{ ext: '../../evil' }] },
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/invalid ext/)
  })

  it('rejects an empty or missing files[]', async () => {
    expect((await callHandler(handler, { method: 'POST', path: '/api/photos/batch', body: { files: [] } })).status).toBe(400)
    expect((await callHandler(handler, { method: 'POST', path: '/api/photos/batch', body: {} })).status).toBe(400)
  })

  it('falls back to image/jpeg for a non-image content_type instead of signing it', async () => {
    const res = await callHandler(handler, {
      method: 'POST', path: '/api/photos/batch',
      body: { files: [{ ext: 'jpg', content_type: 'text/html' }] },
    })
    expect(res.status).toBe(200)
    expect(res.body.uploads[0].content_type).toBe('image/jpeg')
  })
})

describe('POST /api/photos — intake_status validation', () => {
  // Found by the pre-promote regression pass: intake_status was bound straight from the body into
  // a CHECK-constrained column, so a bad value surfaced as an opaque 500 via isUpstream().
  it('400s an intake_status outside the CHECK vocabulary instead of 500ing', async () => {
    const res = await callHandler(handler, {
      method: 'POST', path: '/api/photos',
      body: { storage_path: `inbox/${USER}/bad-status-${RUN}.jpg`, plant_id: plantId, intake_status: 'sorta_pending' },
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/intake_status/)
  })

  it("400s a parentless 'upload_failed' — photos_must_have_parent only admits pending_tag", async () => {
    const res = await callHandler(handler, {
      method: 'POST', path: '/api/photos',
      body: { storage_path: `inbox/${USER}/orphan-failed-${RUN}.jpg`, intake_status: 'upload_failed' },
    })
    expect(res.status).toBe(400)
  })

  it('still accepts the two legal values', async () => {
    const a = await callHandler(handler, {
      method: 'POST', path: '/api/photos',
      body: { storage_path: `inbox/${USER}/ok-pending-${RUN}.jpg`, intake_status: 'pending_tag' },
    })
    expect(a.status).toBe(201)
    const b = await callHandler(handler, {
      method: 'POST', path: '/api/photos',
      body: { storage_path: `inbox/${USER}/ok-failed-${RUN}.jpg`, plant_id: plantId, intake_status: 'upload_failed' },
    })
    expect(b.status).toBe(201)
  })
})
