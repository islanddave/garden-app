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
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
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
    INSERT INTO plant_projects (name, slug, created_by)
    VALUES (${'authz-photo-' + RUN}, ${'authz-photo-' + RUN}, ${OWNER}) RETURNING id`
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
})
