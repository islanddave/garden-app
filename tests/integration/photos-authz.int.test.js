// photos-authz.int.test.js — 0A.5 Phase-1 leak-lock for the photos Lambda READ paths
// (lambda/photos/index.js). Real handler vs an ephemeral Neon branch (harness stubs SecretsManager +
// Clerk; SQL is REAL). Compensating control for the RLS-off posture (see _authz.js). Complements
// photos-intake.int.test.js (which covers the PUT/POST WRITE paths + one 404 arm) by pinning the
// three READ surfaces flagged in _authz.js §COVERAGE.
//
// AUTH MODEL: household-scoped on `created_by = ANY(householdIds)` + `deleted_at IS NULL` on:
//   * GET /api/photos/view-url/:id       (index.js:326-331) — single-resource presign; 404 on miss
//   * GET /api/photos            (list)  (unfiltered :418-429)
//   * GET /api/photos?project_id=        (:404-416)
// (the ?attachedTo / ?location_id branches carry the identical predicate.) With GARDEN_HOUSEHOLD_IDS
// unset, householdScope(u) = [u], so OWNER and FOREIGN are disjoint. The denial arms 404 / return an
// empty list BEFORE any presign; only the owner-allowed arms sign, and only against the stub below.
//
// S3: the handler throws at MODULE LOAD without S3_PHOTOS_BUCKET, and presigns view_url/thumb_url on
// the owner-read arms. Same treatment as photos-intake.int.test.js — hoist the env, stub the
// presigner to a deterministic URL, dynamic-import the handler after.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { directSql, callHandler, setTestUserId, testRunId } from './_harness.js'

vi.hoisted(() => {
  process.env.S3_PHOTOS_BUCKET = 'garden-photos-int-test'
  process.env.AWS_REGION = 'us-east-1'
})

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async (_client, cmd) => `https://stub-s3.invalid/${cmd?.input?.Key ?? 'unknown'}?signed=1`),
}))

const { handler } = await import('../../lambda/photos/index.js')

const RUN = testRunId()
const OWNER = `authz_photo_owner_${RUN}`
const FOREIGN = `authz_photo_foreign_${RUN}`
let projectId, photoId

beforeAll(async () => {
  setTestUserId(OWNER)
  const p = await directSql`
    INSERT INTO plant_projects (name, slug, kind, created_by)
    VALUES (${'authz-photo-' + RUN}, ${'authz-photo-' + RUN}, 'campaign', ${OWNER}) RETURNING id`
  projectId = p[0].id
  // project_id parent satisfies photos_must_have_parent. Seeded via directSql (not POST) so
  // auto-promote never runs and the project's featured_photo_id stays null.
  const ph = await directSql`
    INSERT INTO photos (project_id, storage_path, uploaded_by, created_by)
    VALUES (${projectId}, ${'plants/authz/' + RUN + '.jpg'}, ${OWNER}, ${OWNER}) RETURNING id`
  photoId = ph[0].id
})

afterAll(async () => {
  await directSql`UPDATE plant_projects SET featured_photo_id = NULL WHERE id = ${projectId}`
  await directSql`DELETE FROM photos WHERE created_by IN (${OWNER}, ${FOREIGN})`
  await directSql`DELETE FROM plant_projects WHERE created_by = ${OWNER}`
})


// CROSS-FILE ENV LEAK GUARD (added 2026-08-02). SPACE_PHOTOS_ENABLED is toggled in-process by
// space-photos.int.test.js, vitest reuses workers across files, and process.env is per-worker — so a
// crashed or --bail'd run there can leave the gate ON here. This file's whole premise is the
// flag-OFF shape of the re-tag path; inheriting a stale `true` would silently exercise the widened
// templates while every assertion still claimed to be testing flag-off. Fail loudly instead.
beforeEach(() => {
  expect(process.env.SPACE_PHOTOS_ENABLED, 'stale SPACE_PHOTOS_ENABLED leaked from another test file').toBeUndefined()
})

describe('AUTHZ photos GET /api/photos/view-url/:id — household + deleted_at (0A.5)', () => {
  it('owner-read → 200, signed view_url returned', async () => {
    setTestUserId(OWNER)
    const { status, body } = await callHandler(handler, { method: 'GET', path: `/api/photos/view-url/${photoId}` })
    expect(status).toBe(200)
    expect(body.view_url).toBeTruthy()
  })

  it('non-owner-read → 404 (foreign household cannot resolve the URL)', async () => {
    setTestUserId(FOREIGN)
    const { status } = await callHandler(handler, { method: 'GET', path: `/api/photos/view-url/${photoId}` })
    expect(status).toBe(404)
  })
})

describe('AUTHZ photos GET /api/photos list — household scope (0A.5)', () => {
  it('owner-read unfiltered list contains the photo', async () => {
    setTestUserId(OWNER)
    const { status, body } = await callHandler(handler, { method: 'GET', path: '/api/photos' })
    expect(status).toBe(200)
    expect(body.map((p) => p.id)).toContain(photoId)
  })

  it('non-owner-read unfiltered list does NOT leak the photo', async () => {
    setTestUserId(FOREIGN)
    const { status, body } = await callHandler(handler, { method: 'GET', path: '/api/photos' })
    expect(status).toBe(200)
    expect(body.map((p) => p.id)).not.toContain(photoId)
  })

  it('?project_id= is owner-scoped: owner sees the photo, foreign does not', async () => {
    setTestUserId(OWNER)
    const own = await callHandler(handler, { method: 'GET', path: `/api/photos?project_id=${projectId}` })
    expect(own.status).toBe(200)
    expect(own.body.map((p) => p.id)).toContain(photoId)
    setTestUserId(FOREIGN)
    const foreign = await callHandler(handler, { method: 'GET', path: `/api/photos?project_id=${projectId}` })
    expect(foreign.status).toBe(200)
    expect(foreign.body.map((p) => p.id)).not.toContain(photoId) // household scope holds even with a known project_id
  })
})

// ── T3b archive leftover: a photo on an ARCHIVED container leaves the aggregate list but stays on
//    the container's own page (?project_id=). ────────────────────────────────────────────────────
describe('photos list hides a photo whose container is ARCHIVED (T3b archive leftover)', () => {
  let archivedProjectId, archivedPhotoId

  beforeAll(async () => {
    const p = await directSql`
      INSERT INTO plant_projects (name, slug, kind, created_by)
      VALUES (${'authz-photo-arch-' + RUN}, ${'authz-photo-arch-' + RUN}, 'campaign', ${OWNER}) RETURNING id`
    archivedProjectId = p[0].id
    const ph = await directSql`
      INSERT INTO photos (project_id, storage_path, uploaded_by, created_by)
      VALUES (${archivedProjectId}, ${`projects/${archivedProjectId}/arch-${RUN}.jpg`}, ${OWNER}, ${OWNER}) RETURNING id`
    archivedPhotoId = ph[0].id
  })

  it('live container: the photo is in the unfiltered list (control)', async () => {
    setTestUserId(OWNER)
    const { status, body } = await callHandler(handler, { method: 'GET', path: '/api/photos' })
    expect(status).toBe(200)
    expect(body.map((p) => p.id)).toContain(archivedPhotoId)
  })

  it('archived container: absent from the unfiltered list, present under ?project_id=', async () => {
    await directSql`UPDATE plant_projects SET archived_at = NOW() WHERE id = ${archivedProjectId}`
    setTestUserId(OWNER)
    const list = await callHandler(handler, { method: 'GET', path: '/api/photos' })
    expect(list.status).toBe(200)
    expect(list.body.map((p) => p.id)).not.toContain(archivedPhotoId)
    const own = await callHandler(handler, { method: 'GET', path: `/api/photos?project_id=${archivedProjectId}` })
    expect(own.status).toBe(200)
    expect(own.body.map((p) => p.id)).toContain(archivedPhotoId)
  })
})

// ── I34 / I35 (BUG-AUTHZLAMBDA-001): a caller-named S3 key carries no owner segment, so a key
//    another household registered is refused on POST (400) and on the three signing routes (403).
//    Env OWNER,MEMBER: household sharing must survive (MEMBER may register OWNER's key). ─────────
describe('AUTHZ photos storage_path — a foreign-registered key is refused (I34 / I35)', () => {
  const MEMBER = `authz_photo_member_${RUN}`
  const KEY_BODY = 'storage_path is not a valid upload key'
  let ownerKey, hhEnv

  beforeAll(async () => {
    hhEnv = process.env.GARDEN_HOUSEHOLD_IDS
    process.env.GARDEN_HOUSEHOLD_IDS = `${OWNER},${MEMBER}`
    ownerKey = `plants/${projectId}/k-${RUN}.jpg`
    await directSql`
      INSERT INTO photos (project_id, storage_path, uploaded_by, created_by)
      VALUES (${projectId}, ${ownerKey}, ${OWNER}, ${OWNER})`
  })

  afterAll(async () => {
    if (hhEnv === undefined) delete process.env.GARDEN_HOUSEHOLD_IDS
    else process.env.GARDEN_HOUSEHOLD_IDS = hhEnv
    await directSql`DELETE FROM photos WHERE created_by = ${MEMBER}`
  })

  it('FOREIGN POSTs OWNER\'s registered key -> 400, generic body, no row', async () => {
    setTestUserId(FOREIGN)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/photos', body: { storage_path: ownerKey, intake_status: 'pending_tag' },
    })
    expect(status, JSON.stringify(body)).toBe(400)
    expect(body.error).toBe(KEY_BODY)
    const rows = await directSql`SELECT 1 FROM photos WHERE storage_path = ${ownerKey} AND created_by = ${FOREIGN}`
    expect(rows).toHaveLength(0)
  })

  it('MEMBER (same household) POSTs OWNER\'s key -> 201 (household sharing preserved)', async () => {
    setTestUserId(MEMBER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/photos', body: { storage_path: ownerKey, intake_status: 'pending_tag' },
    })
    expect(status, JSON.stringify(body)).toBe(201)
  })

  it('thumbs/<key> and another sub\'s inbox are refused with the SAME body; own inbox is accepted', async () => {
    setTestUserId(FOREIGN)
    const thumb = await callHandler(handler, {
      method: 'POST', path: '/api/photos', body: { storage_path: `thumbs/${ownerKey}`, intake_status: 'pending_tag' },
    })
    expect(thumb.status).toBe(400)
    expect(thumb.body.error).toBe(KEY_BODY)
    const theirInbox = await callHandler(handler, {
      method: 'POST', path: '/api/photos', body: { storage_path: `inbox/${OWNER}/x-${RUN}.jpg`, intake_status: 'pending_tag' },
    })
    expect(theirInbox.status).toBe(400)
    expect(theirInbox.body.error).toBe(KEY_BODY)
    const ownInbox = await callHandler(handler, {
      method: 'POST', path: '/api/photos', body: { storage_path: `inbox/${FOREIGN}/own-${RUN}.jpg`, intake_status: 'pending_tag' },
    })
    expect(ownInbox.status, JSON.stringify(ownInbox.body)).toBe(201)
  })

  // The negative arms only: S3 is not stubbed for relay (a 200 would PUT for real). The presign is
  // stubbed, so upload-url / thumb-upload-url also carry an OWNER positive control.
  it('FOREIGN upload-url / thumb-upload-url / relay-upload on OWNER\'s key -> 403', async () => {
    setTestUserId(FOREIGN)
    const up = await callHandler(handler, { method: 'GET', path: `/api/photos/upload-url?key=${encodeURIComponent(ownerKey)}` })
    expect(up.status).toBe(403)
    expect(up.body).toEqual({ error: 'Forbidden' })
    const th = await callHandler(handler, { method: 'GET', path: `/api/photos/thumb-upload-url?key=${encodeURIComponent(ownerKey)}` })
    expect(th.status).toBe(403)
    const relay = await callHandler(handler, {
      method: 'POST', path: '/api/photos/relay-upload', body: { key: ownerKey, data_b64: Buffer.from('x').toString('base64') },
    })
    expect(relay.status).toBe(403)
  })

  it('OWNER may still sign their own key (control)', async () => {
    setTestUserId(OWNER)
    const up = await callHandler(handler, { method: 'GET', path: `/api/photos/upload-url?key=${encodeURIComponent(ownerKey)}` })
    expect(up.status).toBe(200)
    const th = await callHandler(handler, { method: 'GET', path: `/api/photos/thumb-upload-url?key=${encodeURIComponent(ownerKey)}` })
    expect(th.status).toBe(200)
  })
})

// Runs LAST — mutates the fixture (soft-deletes the shared photo).
describe('AUTHZ photos read paths exclude soft-deleted rows (deleted_at) (0A.5)', () => {
  it('a soft-deleted photo drops from view-url (404) and the owner list', async () => {
    await directSql`UPDATE photos SET deleted_at = NOW() WHERE id = ${photoId}`
    setTestUserId(OWNER)
    const view = await callHandler(handler, { method: 'GET', path: `/api/photos/view-url/${photoId}` })
    expect(view.status).toBe(404)
    const list = await callHandler(handler, { method: 'GET', path: '/api/photos' })
    expect(list.body.map((p) => p.id)).not.toContain(photoId)
  })

  // I35: the probe deliberately counts soft-deleted rows — the S3 object survives and restore
  // brings the row back, so a stranger must not be able to re-sign it in the meantime.
  it('a SOFT-DELETED foreign row still blocks FOREIGN from signing its key (I35)', async () => {
    setTestUserId(FOREIGN)
    const key = `plants/authz/${RUN}.jpg`
    const up = await callHandler(handler, { method: 'GET', path: `/api/photos/upload-url?key=${encodeURIComponent(key)}` })
    expect(up.status).toBe(403)
  })
})
