// public-share.int.test.js — 0A.5 Phase-1 leak-lock: GET /api/projects/public/:slug (handlePublicProject).
// The public share route is UNAUTHENTICATED (served before verifyToken).
//
// IMPORTANT — what this locks and why. This route has TWO independent boundaries and this file
// proves each one WITHOUT the other able to mask it:
//
//   (1) ROW GATE — is_public on the project AND on its events. Added 2026-08-24, reversing the
//       earlier "post-PUBHIDE: no is_public gate, per Dave's LOCKED decision" that this file used
//       to document. Reversed by Dave ("add the filter and keep the route") after an audit found
//       the route serving is_public=false projects, with notes, to anyone who guesses a slug.
//   (2) COLUMN GATE — deny-by-default projection: the response is built key-by-key and a DB row
//       is NEVER spread.
//
// Seeding is deliberately split so the two cannot cover for each other. The sensitive-column event
// is seeded is_public=TRUE so it still reaches the projection — if it were non-public, the row gate
// would filter it out and the column assertions would pass vacuously whichever boundary you broke.
// A separate is_public=FALSE event exists solely to prove the row gate drops it. Break (1) and the
// row-gate tests fail; break (2) and the column tests fail; neither failure mode is hidden.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, insertProject } from './_harness.js'
import { handler } from '../../lambda/projects/index.js'

const RUN = testRunId()
const OWNER = `pubshare_owner_${RUN}`
const SLUG = `pub-share-${RUN}`
let projectId

const ALLOWED_TOP = ['name', 'slug', 'status', 'species', 'variety', 'description', 'start_date', 'location_path', 'events'].sort()
const ALLOWED_EVENT = ['id', 'event_type', 'event_date', 'notes', 'quantity'].sort()

beforeAll(async () => {
  projectId = (await insertProject({ name: 'pub-share-' + RUN, slug: SLUG, createdBy: OWNER })).id
  // PUBLIC event carrying SENSITIVE columns — private_notes, flagged_as_issue. It passes the row
  // gate on purpose, so the column allowlist is the only thing standing between those values and
  // the response. This is what keeps the leak-gate non-vacuous.
  await directSql`
    INSERT INTO event_log (project_id, event_type, event_date, is_public, notes, private_notes, flagged_as_issue, severity, logged_by, created_by)
    VALUES (${projectId}, 'observation', NOW(), true, ${'PUBNOTE-' + RUN}, ${'SECRETNOTE-' + RUN}, true, 1, ${OWNER}, ${OWNER})`
  // NON-PUBLIC event. Nothing about it is sensitive by column; it exists only to prove the row gate
  // drops it. Its notes value is the tracer.
  await directSql`
    INSERT INTO event_log (project_id, event_type, event_date, is_public, notes, logged_by, created_by)
    VALUES (${projectId}, 'observation', NOW(), false, ${'HIDDENEVENT-' + RUN}, ${OWNER}, ${OWNER})`
})

afterAll(async () => {
  await directSql`DELETE FROM event_log WHERE created_by = ${OWNER}`
  await directSql`DELETE FROM plant_projects WHERE created_by = ${OWNER}`
})

describe('LEAK-GATE public share — GET /api/projects/public/:slug row gate + deny-by-default column projection', () => {
  it('serves a public, non-deleted project by slug with ONLY the allowlisted top-level keys', async () => {
    const { status, body } = await callHandler(handler, { method: 'GET', path: `/api/projects/public/${SLUG}` })
    expect(status).toBe(200)
    expect(body.slug).toBe(SLUG)
    expect(Object.keys(body).sort()).toEqual(ALLOWED_TOP) // no created_by / is_public / location_id / project-id leak
  })

  it('event rows expose ONLY the 5 allowlisted columns — private_notes/flagged/created_by NEVER leak', async () => {
    const { body } = await callHandler(handler, { method: 'GET', path: `/api/projects/public/${SLUG}` })
    // Non-vacuity: the sensitive-column event is public, so it MUST be present for this assertion
    // to mean anything. A zero-length events array here is a broken fixture, not a pass.
    expect(body.events.length).toBeGreaterThan(0)
    expect(JSON.stringify(body)).toContain('PUBNOTE-' + RUN)
    for (const e of body.events) {
      expect(Object.keys(e).sort()).toEqual(ALLOWED_EVENT)
    }
    const blob = JSON.stringify(body)
    expect(blob).not.toContain('SECRETNOTE-')  // private_notes value must not appear anywhere
    expect(blob).not.toContain('flagged')      // no flagged_as_issue key
    expect(blob).not.toContain('created_by')   // no ownership column
  })

  it('ROW GATE — a non-public event is not served, even on a public project', async () => {
    const { status, body } = await callHandler(handler, { method: 'GET', path: `/api/projects/public/${SLUG}` })
    expect(status).toBe(200)
    expect(JSON.stringify(body)).not.toContain('HIDDENEVENT-' + RUN)
  })

  it('ROW GATE — a non-public project → 404, then restored', async () => {
    await directSql`UPDATE plant_projects SET is_public = false WHERE id = ${projectId}`
    const { status } = await callHandler(handler, { method: 'GET', path: `/api/projects/public/${SLUG}` })
    expect(status).toBe(404)
    await directSql`UPDATE plant_projects SET is_public = true WHERE id = ${projectId}`
    const after = await callHandler(handler, { method: 'GET', path: `/api/projects/public/${SLUG}` })
    expect(after.status).toBe(200) // restore actually restored — guards against a poisoned fixture
  })

  it('non-existent slug → 404', async () => {
    const { status } = await callHandler(handler, { method: 'GET', path: `/api/projects/public/nope-${RUN}` })
    expect(status).toBe(404)
  })

  it('soft-deleted project → 404 (deleted_at gate), then restored', async () => {
    await directSql`UPDATE plant_projects SET deleted_at = NOW() WHERE id = ${projectId}`
    const { status } = await callHandler(handler, { method: 'GET', path: `/api/projects/public/${SLUG}` })
    expect(status).toBe(404)
    await directSql`UPDATE plant_projects SET deleted_at = NULL WHERE id = ${projectId}`
  })

  it('archived project → 404 (archived_at gate), then restored', async () => {
    await directSql`UPDATE plant_projects SET archived_at = NOW() WHERE id = ${projectId}`
    const { status } = await callHandler(handler, { method: 'GET', path: `/api/projects/public/${SLUG}` })
    expect(status).toBe(404)
    await directSql`UPDATE plant_projects SET archived_at = NULL WHERE id = ${projectId}`
  })
})
