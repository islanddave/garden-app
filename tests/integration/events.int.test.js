// events.int.test.js — full integration coverage for the events Lambda.
// Runs the REAL handler (lambda/events/index.js) against an ephemeral Neon branch
// with SecretsManager + Clerk stubbed by the harness (vi.mock factories).
//
// Every assertion verified against lambda/events/index.js at dev HEAD e4b3305 +
// lambda/events/validators.js (not against the Phase-2 design doc, which has guesses).
// Notes inline mark which handler line each assertion verifies.
//
// Surfaces covered: POST validation + create + noon-anchor + flagged/severity matrix;
// GET list (array shape, project_id filter, soft-delete exclusion);
// GET single (UUID-oblivious 404 + foreign-owner 404 + match shape);
// PATCH resolve (body validation + flagged-only gate + resolved_at/by set).
//
// Batch routes (POST /api/events/batch + GET batches + DELETE undo) are a separate
// follow-up bite — they need plants-schema setup and a clean blast radius.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId } from './_harness.js'
import { handler } from '../../lambda/events/index.js'

const RUN = testRunId()
const USER = `user_int_events_${RUN}`
const FOREIGN_USER = `user_int_events_foreign_${RUN}`
let projectId
let foreignProjectId
let foreignEventId

beforeAll(async () => {
  setTestUserId(USER)
  const own = await directSql`
    INSERT INTO plant_projects (name, slug, created_by)
    VALUES (${'int-evt-' + RUN}, ${'int-evt-' + RUN}, ${USER}) RETURNING id
  `
  projectId = own[0].id

  // Foreign-owner fixture for 404 / scope tests.
  const foreign = await directSql`
    INSERT INTO plant_projects (name, slug, created_by)
    VALUES (${'int-evt-foreign-' + RUN}, ${'int-evt-foreign-' + RUN}, ${FOREIGN_USER}) RETURNING id
  `
  foreignProjectId = foreign[0].id
  // Insert a foreign event directly so the scope test has something to NOT see.
  const fe = await directSql`
    INSERT INTO event_log
      (project_id, event_type, event_date, is_public, logged_by, created_by)
    VALUES
      (${foreignProjectId}, 'observation', NOW(), true, ${FOREIGN_USER}, ${FOREIGN_USER})
    RETURNING id
  `
  foreignEventId = fe[0].id
})

afterAll(async () => {
  await directSql`DELETE FROM xp_events WHERE user_id IN (${USER}, ${FOREIGN_USER})`
  await directSql`DELETE FROM user_achievements WHERE user_id IN (${USER}, ${FOREIGN_USER})`
  await directSql`DELETE FROM user_stats WHERE user_id IN (${USER}, ${FOREIGN_USER})`
  await directSql`DELETE FROM app_events WHERE user_clerk_sub IN (${USER}, ${FOREIGN_USER})`
  await directSql`DELETE FROM entity_memory WHERE project_id IN (${projectId}, ${foreignProjectId})`
  await directSql`DELETE FROM event_log WHERE created_by IN (${USER}, ${FOREIGN_USER})`
  await directSql`DELETE FROM plant_projects WHERE created_by IN (${USER}, ${FOREIGN_USER})`
})

describe('POST /api/events — validation + create', () => {
  it('YYYY-MM-DD bare date → 201, stored at noon UTC (normalizeEventDate verified)', async () => {
    setTestUserId(USER)
    const bareDate = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10)
    const expected = bareDate + 'T12:00:00.000Z'
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: { project_id: projectId, event_type: 'observation', event_date: bareDate, notes: 'int-noon-anchor' },
    })
    expect(status).toBe(201) // handler line: return resp(201, {...newEvent, ...})
    expect(body.id).toBeTruthy()
    expect(body.event_type).toBe('observation')
    expect(body.project_id).toBe(projectId)
    const rows = await directSql`SELECT event_date FROM event_log WHERE id = ${body.id}`
    expect(rows).toHaveLength(1)
    expect(new Date(rows[0].event_date).toISOString()).toBe(expected)
  })

  it('full ISO datetime passes through unchanged (no noon-anchor rewrite)', async () => {
    setTestUserId(USER)
    const iso = '2026-04-15T14:30:00.000Z'
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: { project_id: projectId, event_type: 'watering', event_date: iso },
    })
    expect(status).toBe(201)
    const rows = await directSql`SELECT event_date FROM event_log WHERE id = ${body.id}`
    expect(new Date(rows[0].event_date).toISOString()).toBe(iso)
  })

  it('missing event_type → 400', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: { project_id: projectId },
    })
    expect(status).toBe(400) // validators.js: 'event_type is required'
    expect(body.error).toMatch(/event_type/i)
  })

  it('missing project_id → 400', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: { event_type: 'observation' },
    })
    expect(status).toBe(400) // validators.js: 'project_id is required'
    expect(body.error).toMatch(/project_id/i)
  })

  it('flagged_as_issue=true + severity=2 → 201, severity stored', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: {
        project_id: projectId, event_type: 'observation',
        flagged_as_issue: true, severity: 2, notes: 'flagged-with-severity',
      },
    })
    expect(status).toBe(201)
    expect(body.flagged_as_issue).toBe(true)
    expect(body.severity).toBe(2)
    const rows = await directSql`SELECT flagged_as_issue, severity FROM event_log WHERE id = ${body.id}`
    expect(rows[0].flagged_as_issue).toBe(true)
    expect(rows[0].severity).toBe(2)
  })

  it('flagged_as_issue=true + severity=null → 400 (F5: severity required when flagged)', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: { project_id: projectId, event_type: 'observation', flagged_as_issue: true },
    })
    expect(status).toBe(400) // validators.js F5
    expect(body.error).toMatch(/severity required when flagged_as_issue/i)
  })

  it('severity=2 without flagged_as_issue → 400 (validator gate — L-091 correction)', async () => {
    // This is the assertion the Phase-2 design doc had backwards: the design doc said
    // severity without flag silently nulls + returns success. Validator catches it at
    // 400 BEFORE the handler's `const severity = flagged ? body.severity : null` line.
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: { project_id: projectId, event_type: 'observation', severity: 2 },
    })
    expect(status).toBe(400) // validators.js: 'severity requires flagged_as_issue=true'
    expect(body.error).toMatch(/severity requires flagged_as_issue/i)
  })

  it('severity=99 (out of range) → 400 (F6: shape check first)', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: { project_id: projectId, event_type: 'observation', flagged_as_issue: true, severity: 99 },
    })
    expect(status).toBe(400) // validators.js F6
    expect(body.error).toMatch(/severity must be 1, 2, or 3/i)
  })

  it('event_type=harvest without harvest object → 400', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: { project_id: projectId, event_type: 'harvest' },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/harvest fields required/i)
  })

  it('non-harvest event with harvest object → 400 (cross-field guard)', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: {
        project_id: projectId, event_type: 'observation',
        harvest: { quantity: 1, unit: 'lb' },
      },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/harvest fields only valid on event_type=harvest/i)
  })
})

describe('GET /api/events — list (collection)', () => {
  it('returns ARRAY shape (not {events:[...]}), scoped to caller', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'GET', path: '/api/events',
    })
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true) // handler: return resp(200, rows) — rows is direct array
    // Every returned row must belong to our test project (single-user scope, no household env).
    for (const row of body) {
      expect(row.project_id).toBe(projectId)
    }
    // Foreign event must NOT appear (it belongs to foreignProjectId / FOREIGN_USER).
    const ids = body.map((r) => r.id)
    expect(ids).not.toContain(foreignEventId)
  })

  it('?project_id= filters list to that project', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'GET', path: '/api/events',
    })
    expect(status).toBe(200)
    // We expect the same rows because USER only has events under projectId; smoke-check the filter exists.
    const all = body
    // Simulate a filter request: handler reads event.queryStringParameters?.project_id.
    const filtered = await handler({
      requestContext: { http: { method: 'GET' } },
      rawPath: '/api/events',
      headers: { authorization: 'Bearer stub' },
      queryStringParameters: { project_id: projectId },
    })
    expect(filtered.statusCode).toBe(200)
    const filteredRows = JSON.parse(filtered.body)
    expect(Array.isArray(filteredRows)).toBe(true)
    for (const row of filteredRows) expect(row.project_id).toBe(projectId)
    // Length should match (we only have rows under this project).
    expect(filteredRows.length).toBe(all.length)
  })

  it('soft-deleted rows excluded from list', async () => {
    setTestUserId(USER)
    // Create a fresh row, soft-delete it via directSql, confirm it's NOT in the GET list.
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: { project_id: projectId, event_type: 'observation', notes: 'will-be-soft-deleted' },
    })
    expect(created.status).toBe(201)
    const id = created.body.id
    await directSql`UPDATE event_log SET deleted_at = NOW() WHERE id = ${id}`
    const { body: listBody } = await callHandler(handler, { method: 'GET', path: '/api/events' })
    const ids = listBody.map((r) => r.id)
    expect(ids).not.toContain(id) // handler WHERE clause: e.deleted_at IS NULL
  })
})

describe('GET /api/events/:id — single', () => {
  it('non-UUID id → 404 (F9 UUID pre-validation, existence-oblivious)', async () => {
    setTestUserId(USER)
    const { status } = await callHandler(handler, {
      method: 'GET', path: '/api/events/not-a-uuid',
    })
    expect(status).toBe(404)
  })

  it('valid-format UUID for foreign-owner event → 404 (scope filter)', async () => {
    setTestUserId(USER) // calling as own USER, asking for FOREIGN_USER's event
    const { status } = await callHandler(handler, {
      method: 'GET', path: `/api/events/${foreignEventId}`,
    })
    expect(status).toBe(404)
  })

  it('own event → 200 with row shape', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: { project_id: projectId, event_type: 'pruning', notes: 'single-get-target' },
    })
    expect(created.status).toBe(201)
    const id = created.body.id
    const { status, body } = await callHandler(handler, {
      method: 'GET', path: `/api/events/${id}`,
    })
    expect(status).toBe(200)
    // Handler returns rows[0] directly (object), not {event: ...}
    expect(body.id).toBe(id)
    expect(body.event_type).toBe('pruning')
    expect(body.project_id).toBe(projectId)
    expect(body).toHaveProperty('project_name') // joined column
  })
})

describe('PATCH /api/events/:id — issue resolve', () => {
  it('non-UUID id → 404', async () => {
    setTestUserId(USER)
    const { status } = await callHandler(handler, {
      method: 'PATCH', path: '/api/events/not-a-uuid',
      body: { resolved: true },
    })
    expect(status).toBe(404)
  })

  it('body resolved!=true → 400', async () => {
    setTestUserId(USER)
    // Need a UUID to get past F9; use a random one — the validator fires before the UPDATE.
    const fakeUuid = '00000000-0000-4000-8000-000000000000'
    const { status, body } = await callHandler(handler, {
      method: 'PATCH', path: `/api/events/${fakeUuid}`,
      body: { resolved: false },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/resolved must be true/i)
  })

  it('non-flagged event PATCH → 404 (UPDATE matches zero rows: flagged_as_issue=true gate)', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: { project_id: projectId, event_type: 'observation', notes: 'unflagged-no-resolve' },
    })
    expect(created.status).toBe(201)
    const id = created.body.id
    const { status } = await callHandler(handler, {
      method: 'PATCH', path: `/api/events/${id}`,
      body: { resolved: true },
    })
    expect(status).toBe(404) // RETURNING from UPDATE WHERE flagged_as_issue=true returns empty
  })

  it('flagged event PATCH → 200; resolved_at and resolved_by populated', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: {
        project_id: projectId, event_type: 'observation',
        flagged_as_issue: true, severity: 1, notes: 'flagged-to-resolve',
      },
    })
    expect(created.status).toBe(201)
    const id = created.body.id
    const { status, body } = await callHandler(handler, {
      method: 'PATCH', path: `/api/events/${id}`,
      body: { resolved: true },
    })
    expect(status).toBe(200)
    expect(body.id).toBe(id)
    expect(body.flagged_as_issue).toBe(true)
    expect(body.severity).toBe(1)
    expect(body.resolved_at).toBeTruthy()
    expect(body.resolved_by).toBe(USER)
    // Read-back: DB row matches.
    const rows = await directSql`SELECT resolved_at, resolved_by FROM event_log WHERE id = ${id}`
    expect(rows[0].resolved_at).toBeTruthy()
    expect(rows[0].resolved_by).toBe(USER)
  })
})
