// public-share.int.test.js — 0A.5 Phase-1 leak-lock: GET /api/projects/public/:slug (handlePublicProject).
// The public share route is UNAUTHENTICATED (served before verifyToken).
//
// IMPORTANT — what this locks and why: the C-thread brief expected an is_public=true event filter, but
// dev's handler (lambda/projects/index.js:132-138) states this is INTENTIONALLY absent — "post-PUBHIDE:
// no is_public gate, per Dave's LOCKED decision." The real security boundary is DENY-BY-DEFAULT COLUMN
// PROJECTION (the response is built key-by-key; a DB row is NEVER spread). So this test locks THAT
// boundary — no sensitive column leaks + project visibility gates — NOT an is_public filter (asserting
// which would contradict the locked decision). See handoff note re: the superseded audit item.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId } from './_harness.js'
import { handler } from '../../lambda/projects/index.js'

const RUN = testRunId()
const OWNER = `pubshare_owner_${RUN}`
const SLUG = `pub-share-${RUN}`
let projectId

const ALLOWED_TOP = ['name', 'slug', 'status', 'species', 'variety', 'description', 'start_date', 'location_path', 'events'].sort()
const ALLOWED_EVENT = ['id', 'event_type', 'event_date', 'notes', 'quantity'].sort()

beforeAll(async () => {
  const proj = await directSql`
    INSERT INTO plant_projects (name, slug, created_by)
    VALUES (${'pub-share-' + RUN}, ${SLUG}, ${OWNER}) RETURNING id`
  projectId = proj[0].id
  // Seed an event carrying SENSITIVE fields — private_notes, flagged_as_issue, is_public=false. The public
  // projection must expose NONE of them (the deny-by-default column allowlist is the boundary under test).
  await directSql`
    INSERT INTO event_log (project_id, event_type, event_date, is_public, notes, private_notes, flagged_as_issue, severity, logged_by, created_by)
    VALUES (${projectId}, 'observation', NOW(), false, ${'PUBNOTE-' + RUN}, ${'SECRETNOTE-' + RUN}, true, 1, ${OWNER}, ${OWNER})`
})

afterAll(async () => {
  await directSql`DELETE FROM event_log WHERE created_by = ${OWNER}`
  await directSql`DELETE FROM plant_projects WHERE created_by = ${OWNER}`
})

describe('LEAK-GATE public share — GET /api/projects/public/:slug deny-by-default column projection (PUBHIDE)', () => {
  it('serves a non-deleted project by slug with ONLY the allowlisted top-level keys', async () => {
    const { status, body } = await callHandler(handler, { method: 'GET', path: `/api/projects/public/${SLUG}` })
    expect(status).toBe(200)
    expect(body.slug).toBe(SLUG)
    expect(Object.keys(body).sort()).toEqual(ALLOWED_TOP) // no created_by / is_public / location_id / project-id leak
  })

  it('event rows expose ONLY the 5 allowlisted columns — private_notes/flagged/is_public NEVER leak', async () => {
    const { body } = await callHandler(handler, { method: 'GET', path: `/api/projects/public/${SLUG}` })
    expect(body.events.length).toBeGreaterThan(0)
    for (const e of body.events) {
      expect(Object.keys(e).sort()).toEqual(ALLOWED_EVENT)
    }
    const blob = JSON.stringify(body)
    expect(blob).not.toContain('SECRETNOTE-')  // private_notes value must not appear anywhere
    expect(blob).not.toContain('flagged')      // no flagged_as_issue key
    expect(blob).not.toContain('created_by')   // no ownership column
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
