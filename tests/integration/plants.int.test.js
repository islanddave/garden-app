// plants.int.test.js — integration coverage for the plants Lambda.
// Verified against lambda/plants/index.js at dev HEAD e8ba7514 — every assertion
// reads the handler code, not the Phase-2 design doc.
//
// Surfaces covered: POST (required fields, enum guards, head-of-chain
// succession_group_id = self.id), GET list (array shape, project_id filter,
// soft-delete exclusion), GET single (foreign-owner 404, non-existent 404, match),
// PUT (COALESCE update pattern, foreign-owner 404), DELETE (soft-delete behavior).
//
// Skipped this bite (separate follow-up): variety_id presence-sentinel (needs
// plant_varieties FK row); featured_photo_id link validation (needs photos row +
// S3 mock); featured_photo_view_url signing.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId } from './_harness.js'
import { handler } from '../../lambda/plants/index.js'

const RUN = testRunId()
const USER = `user_int_plants_${RUN}`
const FOREIGN_USER = `user_int_plants_foreign_${RUN}`
let projectId
let foreignProjectId
let foreignPlantId

beforeAll(async () => {
  setTestUserId(USER)
  const own = await directSql`
    INSERT INTO plant_projects (name, slug, created_by)
    VALUES (${'int-plt-' + RUN}, ${'int-plt-' + RUN}, ${USER}) RETURNING id
  `
  projectId = own[0].id

  const foreign = await directSql`
    INSERT INTO plant_projects (name, slug, created_by)
    VALUES (${'int-plt-foreign-' + RUN}, ${'int-plt-foreign-' + RUN}, ${FOREIGN_USER}) RETURNING id
  `
  foreignProjectId = foreign[0].id
  const fp = await directSql`
    INSERT INTO plants (project_id, name, created_by)
    VALUES (${foreignProjectId}, ${'foreign-plant-' + RUN}, ${FOREIGN_USER}) RETURNING id
  `
  foreignPlantId = fp[0].id
})

afterAll(async () => {
  await directSql`DELETE FROM plants WHERE created_by IN (${USER}, ${FOREIGN_USER})`
  await directSql`DELETE FROM plant_projects WHERE created_by IN (${USER}, ${FOREIGN_USER})`
})

describe('POST /api/plants — validation + create', () => {
  it('missing name → 400', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/plants',
      body: { project_id: projectId },
    })
    expect(status).toBe(400) // handler: if (!body.name) return resp(400, ...)
    expect(body.error).toMatch(/name is required/i)
  })

  it('missing project_id → 400', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/plants',
      body: { name: 'no-project' },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/project_id is required/i)
  })

  it('invalid loss_cause enum → 400', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/plants',
      body: { name: 'bad-loss', project_id: projectId, loss_cause: 'meteor' },
    })
    expect(status).toBe(400) // ALLOWED_LOSS guard
    expect(body.error).toMatch(/loss_cause must be one of/i)
  })

  it('invalid source_type enum → 400', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/plants',
      body: { name: 'bad-source', project_id: projectId, source_type: 'magic_bean' },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/source_type must be one of/i)
  })

  it('invalid divergence_type enum → 400', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/plants',
      body: { name: 'bad-div', project_id: projectId, divergence_type: 'spore' },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/divergence_type must be one of/i)
  })

  it('valid POST → 201, stored, qty defaults to 1', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/plants',
      body: { name: 'pepper-' + RUN, project_id: projectId },
    })
    expect(status).toBe(201)
    expect(body.id).toBeTruthy()
    expect(body.name).toBe('pepper-' + RUN)
    expect(body.project_id).toBe(projectId)
    expect(Number(body.quantity)).toBe(1) // NUMERIC -> string
    expect(Number(body.qty_initial)).toBe(1) // NUMERIC -> string
    const rows = await directSql`SELECT name, quantity, qty_initial FROM plants WHERE id = ${body.id}`
    expect(rows[0].name).toBe('pepper-' + RUN)
    expect(Number(rows[0].quantity)).toBe(1)
  })

  it('head-of-chain: no succession_group_id + no parent → succession_group_id = self.id', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/plants',
      body: { name: 'head-of-chain-' + RUN, project_id: projectId },
    })
    expect(status).toBe(201)
    // Handler: UPDATE plants SET succession_group_id = id WHERE succession_group_id IS NULL
    expect(body.succession_group_id).toBe(body.id)
    const rows = await directSql`SELECT succession_group_id FROM plants WHERE id = ${body.id}`
    expect(rows[0].succession_group_id).toBe(body.id)
  })

  it('explicit succession_group_id passed → NOT overwritten to self.id', async () => {
    setTestUserId(USER)
    const head = await callHandler(handler, {
      method: 'POST', path: '/api/plants',
      body: { name: 'sg-head-' + RUN, project_id: projectId },
    })
    const groupId = head.body.succession_group_id
    expect(groupId).toBe(head.body.id)
    const succ = await callHandler(handler, {
      method: 'POST', path: '/api/plants',
      body: { name: 'sg-succ-' + RUN, project_id: projectId, succession_group_id: groupId },
    })
    expect(succ.status).toBe(201)
    // Caller-supplied succession_group_id should be preserved (handler's UPDATE has succession_group_id IS NULL guard).
    expect(succ.body.succession_group_id).toBe(groupId)
    expect(succ.body.succession_group_id).not.toBe(succ.body.id)
  })

  it('explicit quantity passed → stored as given, qty_initial defaults to quantity', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/plants',
      body: { name: 'qty-' + RUN, project_id: projectId, quantity: 7 },
    })
    expect(status).toBe(201)
    expect(Number(body.quantity)).toBe(7) // NUMERIC -> string
    expect(Number(body.qty_initial)).toBe(7)
  })
})

describe('GET /api/plants — list', () => {
  it('returns ARRAY shape (not {plants:[...]}), scoped to caller', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'GET', path: '/api/plants',
    })
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    const ids = body.map((r) => r.id)
    expect(ids).not.toContain(foreignPlantId)
    // featured_photo_view_url present (null because no photo set).
    for (const row of body) {
      expect(row).toHaveProperty('featured_photo_view_url')
      // variety_ref present (null because no variety set).
      expect(row).toHaveProperty('variety_ref')
    }
  })

  it('?project_id= filters list', async () => {
    setTestUserId(USER)
    const filtered = await handler({
      requestContext: { http: { method: 'GET' } },
      rawPath: '/api/plants',
      headers: { authorization: 'Bearer stub' },
      queryStringParameters: { project_id: projectId },
    })
    expect(filtered.statusCode).toBe(200)
    const rows = JSON.parse(filtered.body)
    expect(Array.isArray(rows)).toBe(true)
    for (const row of rows) expect(row.project_id).toBe(projectId)
  })

  it('soft-deleted rows excluded from list', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/plants',
      body: { name: 'soft-del-' + RUN, project_id: projectId },
    })
    expect(created.status).toBe(201)
    const id = created.body.id
    await directSql`UPDATE plants SET deleted_at = NOW() WHERE id = ${id}`
    const { body: listBody } = await callHandler(handler, { method: 'GET', path: '/api/plants' })
    const ids = listBody.map((r) => r.id)
    expect(ids).not.toContain(id)
  })
})

describe('GET /api/plants/:id — single', () => {
  it('foreign-owner plantId → 404 (household scope filter)', async () => {
    setTestUserId(USER)
    const { status } = await callHandler(handler, {
      method: 'GET', path: `/api/plants/${foreignPlantId}`,
    })
    expect(status).toBe(404)
  })

  it('non-existent UUID → 404', async () => {
    setTestUserId(USER)
    const fakeUuid = '00000000-0000-4000-8000-000000000000'
    const { status } = await callHandler(handler, {
      method: 'GET', path: `/api/plants/${fakeUuid}`,
    })
    expect(status).toBe(404)
  })

  it('own plant → 200 with row + variety_ref + featured_photo_view_url keys', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/plants',
      body: { name: 'single-get-' + RUN, project_id: projectId },
    })
    expect(created.status).toBe(201)
    const id = created.body.id
    const { status, body } = await callHandler(handler, {
      method: 'GET', path: `/api/plants/${id}`,
    })
    expect(status).toBe(200)
    expect(body.id).toBe(id)
    expect(body.name).toBe('single-get-' + RUN)
    expect(body).toHaveProperty('variety_ref') // null but key present (LEFT JOIN)
    expect(body).toHaveProperty('featured_photo_view_url') // null but key present
    expect(body).toHaveProperty('project_name') // joined column
  })
})

describe('PUT /api/plants/:id — update', () => {
  it('foreign-owner plantId → 404', async () => {
    setTestUserId(USER)
    const { status } = await callHandler(handler, {
      method: 'PUT', path: `/api/plants/${foreignPlantId}`,
      body: { name: 'hijack-attempt' },
    })
    expect(status).toBe(404)
  })

  it('name update via COALESCE → 200, name changed, other fields preserved', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/plants',
      body: { name: 'before-' + RUN, project_id: projectId, notes: 'preserve-me' },
    })
    const id = created.body.id
    const { status, body } = await callHandler(handler, {
      method: 'PUT', path: `/api/plants/${id}`,
      body: { name: 'after-' + RUN },
    })
    expect(status).toBe(200)
    expect(body.id).toBe(id)
    expect(body.name).toBe('after-' + RUN)
    expect(body.notes).toBe('preserve-me') // COALESCE: null in body → keep existing
    expect(body).not.toHaveProperty('variety_ref') // RETURNING p.* — no JOIN in PUT
  })

  it('invalid loss_cause enum in PUT → 400', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/plants',
      body: { name: 'put-enum-' + RUN, project_id: projectId },
    })
    const { status, body } = await callHandler(handler, {
      method: 'PUT', path: `/api/plants/${created.body.id}`,
      body: { loss_cause: 'alien-abduction' },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/loss_cause must be one of/i)
  })
})

describe('DELETE /api/plants/:id — soft-delete', () => {
  it('own plant DELETE → 200 {ok:true}; sets deleted_at; row no longer visible via GET', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/plants',
      body: { name: 'del-target-' + RUN, project_id: projectId },
    })
    const id = created.body.id
    const { status, body } = await callHandler(handler, {
      method: 'DELETE', path: `/api/plants/${id}`,
    })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    const rows = await directSql`SELECT deleted_at FROM plants WHERE id = ${id}`
    expect(rows[0].deleted_at).toBeTruthy()
    // GET single now 404 (handler filters deleted_at IS NULL).
    const get = await callHandler(handler, { method: 'GET', path: `/api/plants/${id}` })
    expect(get.status).toBe(404)
  })

  it('DELETE is idempotent: re-delete returns 200 {ok:true} even with no rows updated', async () => {
    // Handler returns resp(200, { ok: true }) unconditionally — no RETURNING-gate on the UPDATE.
    setTestUserId(USER)
    const fakeUuid = '00000000-0000-4000-8000-000000000001'
    const { status, body } = await callHandler(handler, {
      method: 'DELETE', path: `/api/plants/${fakeUuid}`,
    })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
  })
})
