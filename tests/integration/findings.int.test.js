// new-file: no integration test existed for findings
// Pins today's /api/findings replies and row filters on real Postgres (OPS-CODEREVIEW-001 C6), so D2/D3 are seen.
// Read-only: no 23514/23505/23503 is reachable; the one database error a request can cause (a NUL byte in
// the subject, 22021) pins the generic 500. Trap: rows without a canonical entity are dropped silently.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { directSql, callHandler, makeEvent, setTestUserId, testRunId, insertProject, householdDefault } from './_harness.js'
// After _harness.js, whose vi.mock replaces this module with the stub; imported first it would be the real one.
import { verifyToken } from '@clerk/backend'
import { handler } from '../../lambda/findings/index.js'
import { SCHEMA_VERSION } from '../../lambda/findings/engine/config.js'

const ORIGINS = ['https://garden.futureishere.net', 'https://dg6mmjhepoyt9.cloudfront.net']
// Clerk refuses a token whose azp is not in authorizedParties; this models that check on the list the handler passes.
const signedFrom = (azp, sub) => (_token, opts) => (opts.authorizedParties.includes(azp)
  ? (householdDefault(sub), Promise.resolve({ sub, azp }))
  : Promise.reject(new Error(`Invalid JWT Authorized party claim (azp) "${azp}"`)))
const raw = async (event) => {
  const r = await handler(event)
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null, raw: r }
}
const get = () => callHandler(handler, { method: 'GET', path: '/api/findings' })

const RUN = testRunId()
const OWNER = `c6_find_owner_${RUN}`
const STRANGER = `c6_find_stranger_${RUN}`
const ev = {}

beforeAll(async () => {
  const project = await insertProject({ name: `c6-find-${RUN}`, createdBy: OWNER })
  const mkPlant = async (tag, extra = {}) => (await directSql`
    INSERT INTO plants (project_id, name, status, archived_at, created_by)
    VALUES (${project.id}, ${`c6-find-${tag}-${RUN}`}, ${extra.status ?? 'vegetative'}, ${extra.archivedAt ?? null}::timestamptz, ${OWNER})
    RETURNING id`)[0].id
  const mkIssue = async (plantId, { resolvedAt = null, deletedAt = null } = {}) => (await directSql`
    INSERT INTO event_log (plant_id, project_id, event_type, event_date, flagged_as_issue, severity,
                           resolved_at, deleted_at, logged_by, created_by)
    VALUES (${plantId}, ${project.id}, 'observation', now() - interval '1 day', true, 2,
            ${resolvedAt}::timestamptz, ${deletedAt}::timestamptz, ${OWNER}, ${OWNER})
    RETURNING id`)[0].id
  const live = await mkPlant('live')
  ev.open = await mkIssue(live)
  ev.recentlyResolved = await mkIssue(live, { resolvedAt: new Date(Date.now() - 5 * 864e5).toISOString() })
  ev.longResolved = await mkIssue(live, { resolvedAt: new Date(Date.now() - 40 * 864e5).toISOString() })
  ev.deleted = await mkIssue(live, { deletedAt: new Date().toISOString() })
  ev.dormant = await mkIssue(await mkPlant('dormant', { status: 'dormant' }))
  ev.archived = await mkIssue(await mkPlant('archived', { archivedAt: new Date().toISOString() }))
  ev.livePlant = live
  ev.entity = (await directSql`
    SELECT id FROM entity WHERE entity_type = 'planting' AND planting_ref_id = ${live} AND deleted_at IS NULL`)[0]?.id
})

afterAll(async () => {
  await directSql`DELETE FROM entity WHERE entity_type = 'planting' AND planting_ref_id IN (SELECT id FROM plants WHERE created_by = ${OWNER})`
})

describe('findings — normal requests', () => {
  it('OPTIONS answers 204 with an empty body before sign-in', async () => {
    const r = await raw({ ...makeEvent({ method: 'OPTIONS', path: '/api/findings' }), headers: {} })
    expect(r.raw).toEqual({ statusCode: 204, headers: {}, body: '' })
  })

  it('the mirror trigger gave the live planting an entity row (anti-vacuity)', () => {
    expect(ev.entity).toBeTruthy()
  })

  it('serves open and recently resolved issues; drops old-resolved, deleted, dormant and archived', async () => {
    setTestUserId(OWNER)
    const { status, body, raw: res } = await get()
    expect(status).toBe(200)
    expect(res.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(body.schema_version).toBe(SCHEMA_VERSION)
    expect(Number.isNaN(Date.parse(body.generated_at))).toBe(false)
    expect(body.count).toBe(2)
    expect(body.findings.map((f) => f.finding_id).sort()).toEqual([`issue:${ev.open}`, `issue:${ev.recentlyResolved}`].sort())
    for (const f of body.findings) {
      expect(f).toMatchObject({ schema_version: SCHEMA_VERSION, entity_id: ev.entity, source_room: 'Knowledge', scope: 'planting' })
    }
  })

  it('another household sees none of them', async () => {
    setTestUserId(STRANGER)
    const { status, body } = await get()
    expect(status).toBe(200)
    expect(body.findings.map((f) => f.finding_id)).not.toContain(`issue:${ev.open}`)
    expect(body.count).toBe(0)
  })

  it('a non-GET or another path is 405; a malformed body on GET is ignored', async () => {
    setTestUserId(OWNER)
    const post = await raw({ ...makeEvent({ method: 'POST', path: '/api/findings' }), body: '{not json' })
    expect(post.status).toBe(405)
    expect(post.body).toEqual({ error: 'Method not allowed' })
    expect((await callHandler(handler, { method: 'GET', path: '/api/findings/x' })).status).toBe(405)
    const withBody = await raw({ ...makeEvent({ method: 'GET', path: '/api/findings' }), body: '{not json' })
    expect(withBody.status).toBe(200)
  })
})

describe('findings — sign-in and origin', () => {
  it('a token Clerk rejects is 401', async () => {
    vi.mocked(verifyToken).mockImplementationOnce(() => Promise.reject(new Error('JWT is expired')))
    const r = await raw(makeEvent({ method: 'GET', path: '/api/findings' }))
    expect(r.status).toBe(401)
    expect(r.body).toEqual({ error: 'Unauthorized' })
  })

  it('a verified token with no subject is 401 (empty-subject guard)', async () => {
    vi.mocked(verifyToken).mockImplementationOnce(() => Promise.resolve({ sub: '' }))
    const r = await raw(makeEvent({ method: 'GET', path: '/api/findings' }))
    expect(r.status).toBe(401)
  })

  it('the handler hands Clerk exactly the two production origins', async () => {
    setTestUserId(OWNER)
    await get()
    expect(vi.mocked(verifyToken).mock.calls.at(-1)[1].authorizedParties).toEqual(ORIGINS)
  })

  it('a token minted for another origin is 401; the CloudFront origin is accepted', async () => {
    vi.mocked(verifyToken).mockImplementationOnce(signedFrom('https://evil.example', OWNER))
    expect((await raw(makeEvent({ method: 'GET', path: '/api/findings' }))).status).toBe(401)
    vi.mocked(verifyToken).mockImplementationOnce(signedFrom(ORIGINS[1], OWNER))
    expect((await raw(makeEvent({ method: 'GET', path: '/api/findings' }))).status).toBe(200)
  })
})

describe('findings — database errors', () => {
  it('22021 (NUL in the subject) is a generic 500', async () => {
    setTestUserId(`c6_find_nul_${RUN}\u0000`)
    const r = await get()
    expect(r.status).toBe(500)
    expect(r.body).toEqual({ error: 'Internal server error' })
  })
})
