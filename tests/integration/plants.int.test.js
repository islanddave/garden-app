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
import { directSql, callHandler, testRunId, setTestUserId, insertProject } from './_harness.js'
import { handler } from '../../lambda/plants/index.js'

const RUN = testRunId()
const USER = `user_int_plants_${RUN}`
const FOREIGN_USER = `user_int_plants_foreign_${RUN}`
let projectId
let foreignProjectId
let foreignPlantId

beforeAll(async () => {
  setTestUserId(USER)
  projectId = (await insertProject({ name: 'int-plt-' + RUN, createdBy: USER })).id
  foreignProjectId = (await insertProject({ name: 'int-plt-foreign-' + RUN, createdBy: FOREIGN_USER })).id
  const fp = await directSql`
    INSERT INTO plants (project_id, name, created_by)
    VALUES (${foreignProjectId}, ${'foreign-plant-' + RUN}, ${FOREIGN_USER}) RETURNING id
  `
  foreignPlantId = fp[0].id
})

afterAll(async () => {
  // Order matters — three separate FK behaviours have to be unwound by hand before the
  // fixture plantings can be hard-deleted.
  //
  // event_log.plant_id is ON DELETE RESTRICT (V4-EVTANCHORDEL-001, 2026-08-04), so every event
  // anchored to a fixture planting has to go before the planting does.
  //
  // NOTE — this line is NOT a workaround any more, and must NOT be removed. It was originally
  // added to dodge BUG-EVTANCHORDEL-001: plant_id was ON DELETE SET NULL while
  // event_log_has_anchor requires (plant_id IS NOT NULL OR project_id IS NOT NULL), so for a
  // PROJECT-LESS planting the cascade's own UPDATE produced a row violating the table's own
  // CHECK and the DELETE died with 23514. The fix removed that contradiction by making the FK
  // RESTRICT — which means the DB now REQUIRES this ordering rather than merely punishing you
  // for getting it wrong, and it requires it for EVERY planting, not just project-less ones.
  // Deleting this line turns a green teardown into a 23503. It is enforced ordering, not a
  // band-aid. The supported non-test path is archive_plant_events(); tests delete outright
  // because fixture events are not history worth keeping.
  await directSql`DELETE FROM event_log WHERE plant_id IN (SELECT id FROM plants WHERE created_by IN (${USER}, ${FOREIGN_USER}))`
  // V4-SOFTDELCASCADE-001: event_log.project_id is ON DELETE RESTRICT once 0c lands, so an event
  // anchored ONLY by project_id (no plant_id) would block the plant_projects delete below. The
  // plant_id-scoped line above cannot see such a row; this one exists for it.
  await directSql`DELETE FROM event_log WHERE project_id IN (SELECT id FROM plant_projects WHERE created_by IN (${USER}, ${FOREIGN_USER}))`
  // entity_memory.plant_id is ON DELETE RESTRICT — a status change writes a plant-keyed row.
  await directSql`DELETE FROM entity_memory WHERE plant_id IN (SELECT id FROM plants WHERE created_by IN (${USER}, ${FOREIGN_USER}))`
  // entity registry (DRG-ENGINE-002) FK is ON DELETE RESTRICT — clear the auto-created
  // planting entity rows before hard-deleting fixtures (test-teardown carve-out).
  await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id IN (SELECT id FROM plants WHERE created_by IN (${USER}, ${FOREIGN_USER}))`
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

  it('missing project_id → 201 project-less planting (V3-CAPTURE-001)', async () => {
    // V3-CAPTURE-001: photo-first capture can create a planting with no project;
    // V4 tagging will group it later. container_id (project_id) is nullable.
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/plants',
      body: { name: 'no-project' },
    })
    expect(status).toBe(201)
    expect(body.project_id ?? null).toBeNull()
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

  it('accepts a free-text source_type on create (V4-SOURCEFREE-001 — replaces the create-path allowlist that 400d rescue)', async () => {
    // source_type is now free-text (no lambda allowlist; DB CHECK dropped at promote). 'rescued'
    // is the case Dave hit: the create path used to omit it from ALLOWED_SOURCE and 400. Uses a
    // value the current CHECK already permits so this passes pre-migration too.
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/plants',
      body: { name: 'rescue-' + RUN, project_id: projectId, source_type: 'rescued' },
    })
    expect(status).toBe(201)
    expect(body.source_type).toBe('rescued')
    const rows = await directSql`SELECT source_type FROM plants WHERE id = ${body.id}`
    expect(rows[0].source_type).toBe('rescued')
  })

  // BUG-DIVERGENCEVOCAB-001. The test that used to live here probed 'spore' — a value invalid in
  // the Lambda allowlist AND in plants_divergence_type_check. It passed for 15 months while the
  // field was unwritable in both directions (Lambda admitted mutation|cross|selection|unknown, the
  // CHECK admits division|cutting|saved_seed_from, zero overlap). A rejection test whose probe is
  // rejected by every candidate vocabulary cannot distinguish a working feature from a dead one.
  // The three below can: one round-trips a canonical value THROUGH the database, one pins the
  // specific dead value that used to be accepted-then-23514'd, and one keeps the junk-input case.
  it('accepts a canonical divergence_type and it survives the round-trip to the DB', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/plants',
      body: { name: 'div-' + RUN, project_id: projectId, divergence_type: 'cutting' },
    })
    // A 400 here means the Lambda allowlist drifted from the CHECK; a 500/23514 means the CHECK
    // drifted from the Lambda. Only agreement produces a 201.
    expect(status).toBe(201)
    expect(body.divergence_type).toBe('cutting')
    const rows = await directSql`SELECT divergence_type FROM plants WHERE id = ${body.id}`
    expect(rows[0].divergence_type).toBe('cutting')
  })

  it('rejects the retired mutation/cross/selection vocabulary → 400', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/plants',
      body: { name: 'bad-div-' + RUN, project_id: projectId, divergence_type: 'mutation' },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/divergence_type must be one of/i)
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
    // BUG-DELNOOPOK-001: re-deleting the row we just deleted is a 404, not a second success —
    // the UPDATE's `deleted_at IS NULL` guard means it matches nothing the second time.
    const again = await callHandler(handler, { method: 'DELETE', path: `/api/plants/${id}` })
    expect(again.status).toBe(404)
  })

  // BUG-DELNOOPOK-001 (2026-08-13) REVERSED this test's intent. It previously asserted that a
  // re-delete returned 200 {ok:true}, describing the handler's unconditional response as
  // deliberate idempotence. It was not idempotence — it was the absence of a RETURNING-gate, and
  // it made not-found, already-deleted and NOT-OWNED indistinguishable. The route now gates on the
  // soft-delete's own RETURNING and 404s, which is the shape every other verb on this path already
  // had (see 'another user's project-less planting → 404 on GET/PUT/archive/seen' below) and the
  // shape inventory-items and the restore routes ship. Do not restore the old assertion.
  it('DELETE is NOT idempotent: re-delete / unknown id -> 404', async () => {
    setTestUserId(USER)
    const fakeUuid = '00000000-0000-4000-8000-000000000001'
    const { status, body } = await callHandler(handler, {
      method: 'DELETE', path: `/api/plants/${fakeUuid}`,
    })
    expect(status).toBe(404)
    expect(body.error).toBe('Not found')
  })
})

// ── BUG-PLANTLESSWRITE-001 — project-less plantings are writable, and only by their owner ──────
// Real-Postgres proof of the widened ownership predicate. The static guards in
// lambda/plants/project-less-write.test.js pin the SOURCE shape; only this block proves the
// runtime behaviour, and specifically that the widening did NOT open a cross-household hole.
describe('project-less plantings — full by-id lifecycle (BUG-PLANTLESSWRITE-001)', () => {
  let plantlessId
  let foreignPlantlessId

  beforeAll(async () => {
    setTestUserId(USER)
    const own = await callHandler(handler, {
      method: 'POST', path: '/api/plants',
      body: { name: 'plantless-' + RUN, notes: 'keep-me' },
    })
    expect(own.status).toBe(201)
    expect(own.body.project_id ?? null).toBeNull()
    plantlessId = own.body.id
    // Foreign project-less row seeded directly: the attack this predicate must still refuse is
    // "someone else's container-less planting", which the own-created_by arm could otherwise reach.
    const f = await directSql`
      INSERT INTO plants (project_id, name, created_by)
      VALUES (NULL, ${'foreign-plantless-' + RUN}, ${FOREIGN_USER}) RETURNING id
    `
    foreignPlantlessId = f[0].id
  })

  it('GET /:id → 200 (was 404: the container INNER JOIN dropped it)', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, { method: 'GET', path: `/api/plants/${plantlessId}` })
    expect(status, `GET → ${JSON.stringify(body)}`).toBe(200)
    expect(body.id).toBe(plantlessId)
    expect(body.project_id ?? null).toBeNull()
    expect(body.project_name ?? null).toBeNull() // LEFT JOIN, key still present
  })

  it('PUT /:id → 200 and persists (the blocker: every PUT 404d before business logic)', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'PUT', path: `/api/plants/${plantlessId}`, body: { name: 'plantless-renamed-' + RUN },
    })
    expect(status, `PUT name → ${JSON.stringify(body)}`).toBe(200)
    expect(body.name).toBe('plantless-renamed-' + RUN)
    expect(body.notes).toBe('keep-me')
    const rows = await directSql`SELECT name FROM plants WHERE id = ${plantlessId}`
    expect(rows[0].name).toBe('plantless-renamed-' + RUN)
  })

  it('PUT status change → 200 (status_change event_log + entity_memory guard path)', async () => {
    // `vegetative`, NOT `growing`: `growing` is a PROJECT status (statusEvents.js
    // PROJECT_STATUS_LABELS) and the base table carries a VALIDATED CHECK,
    // chk_plants_status = seed|seedling|vegetative|flowering|fruiting|harvested|dormant|ended|
    // failed|rooting. `growing` violates it → 23514 → the handler's catch returns 400. The
    // constraint lives on `plants`; `garden_node` is a view and reports no constraints of its own,
    // which is why a check against the view suggests there is no status constraint at all.
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'PUT', path: `/api/plants/${plantlessId}`, body: { status: 'vegetative' },
    })
    // Assert on the body, so the next failure names its own cause instead of showing a bare number.
    expect(status, `PUT status → ${status}: ${JSON.stringify(body)}`).toBe(200)
    expect(body.status).toBe('vegetative')
    const ev = await directSql`
      SELECT project_id, plant_id FROM event_log
       WHERE plant_id = ${plantlessId} AND event_type = 'status_change' AND deleted_at IS NULL
    `
    expect(ev.length).toBeGreaterThan(0)
    expect(ev[0].project_id).toBeNull() // no project to attribute it to; must not 500
  })

  it('PATCH /:id/archive → 200 and toggles back', async () => {
    setTestUserId(USER)
    const on = await callHandler(handler, {
      method: 'PATCH', path: `/api/plants/${plantlessId}/archive`, body: { archived: true },
    })
    expect(on.status, `archive on → ${JSON.stringify(on.body)}`).toBe(200)
    expect(on.body.archived_at).toBeTruthy()
    const off = await callHandler(handler, {
      method: 'PATCH', path: `/api/plants/${plantlessId}/archive`, body: { archived: false },
    })
    expect(off.status, `archive off → ${JSON.stringify(off.body)}`).toBe(200)
    expect(off.body.archived_at).toBeNull()
  })

  it('POST /:id/seen → 201', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: `/api/plants/${plantlessId}/seen`, body: {},
    })
    expect(status, `seen → ${JSON.stringify(body)}`).toBe(201)
    expect(body.leaf_id).toBe(plantlessId)
  })

  // ── the negative half: the widening must not reach anyone else's rows ──────────────────────
  it("DELETE on another user's project-less planting must not delete it", async () => {
    // (Adversarial review F3.) This test was written when DELETE was the ONE route whose response
    // could not reveal an authz failure — it returned {ok:true} unconditionally, so a broken
    // predicate would have been completely silent, and the read-back was the only real assertion.
    //
    // BUG-DELNOOPOK-001 retired that: the route is RETURNING-gated and a foreign id now 404s, the
    // same status the other four verbs return one test below. The status IS now evidence.
    //
    // The DATABASE read-back is KEPT ANYWAY, and deliberately so — that is the point of this test,
    // not an artefact of the old contract. A 404 proves the response was gated; only the row state
    // proves the UPDATE did not fire. Those are different claims, and a handler that soft-deleted
    // a foreign row and *then* mis-reported would satisfy the first and fail the second. Assert
    // both; never delete the read-back in favour of the status.
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'DELETE', path: `/api/plants/${foreignPlantlessId}`,
    })
    expect(status).toBe(404)
    expect(body.error).toBe('Not found') // collapsed with not-found on purpose: never leak existence
    const rows = await directSql`SELECT deleted_at FROM plants WHERE id = ${foreignPlantlessId}`
    expect(rows[0].deleted_at).toBeNull()
  })

  // BUG-DELNOOPOK-001: DELETE now belongs to this set too — it is asserted in the test directly
  // above rather than in this loop, because that one additionally reads the row back.
  it("another user's project-less planting → 404 on GET/PUT/archive/seen (and DELETE, above)", async () => {
    setTestUserId(USER)
    for (const req of [
      { method: 'GET', path: `/api/plants/${foreignPlantlessId}` },
      { method: 'PUT', path: `/api/plants/${foreignPlantlessId}`, body: { name: 'hijack' } },
      { method: 'PATCH', path: `/api/plants/${foreignPlantlessId}/archive`, body: { archived: true } },
      { method: 'POST', path: `/api/plants/${foreignPlantlessId}/seen`, body: {} },
    ]) {
      const { status } = await callHandler(handler, req)
      expect(status, `${req.method} ${req.path}`).toBe(404)
    }
    const rows = await directSql`SELECT name, archived_at FROM plants WHERE id = ${foreignPlantlessId}`
    expect(rows[0].name).toBe('foreign-plantless-' + RUN)
    expect(rows[0].archived_at).toBeNull()
  })

  it('a planting I created inside SOMEONE ELSE\'S project stays unreachable (the load-bearing conjunct)', async () => {
    // Without `container_id IS NULL AND` on the own-created_by arm, this row would become writable
    // by USER — and the plants POST path does not verify that body.project_id is a project you own,
    // so USER can create exactly this row. This is the case the guard exists for.
    setTestUserId(USER)
    const planted = await callHandler(handler, {
      method: 'POST', path: '/api/plants',
      body: { name: 'trojan-' + RUN, project_id: foreignProjectId },
    })
    // Tolerant on purpose: today POST accepts a foreign project_id (the gap written up in
    // events-authz-gap-V100-20260804.md §3). If that sweep lands and POST starts rejecting it, this
    // test should keep passing — the property under test is "the row is unreachable", not "POST allows it".
    if (planted.status !== 201) {
      expect(planted.status).toBe(400)
      return
    }
    const trojanId = planted.body.id
    const get = await callHandler(handler, { method: 'GET', path: `/api/plants/${trojanId}` })
    expect(get.status).toBe(404)
    const put = await callHandler(handler, {
      method: 'PUT', path: `/api/plants/${trojanId}`, body: { name: 'trojan-edit' },
    })
    expect(put.status).toBe(404)
    // DELETE too — it answers 200 either way, so only the read-back proves the predicate held.
    const del = await callHandler(handler, { method: 'DELETE', path: `/api/plants/${trojanId}` })
    expect(del.status).toBe(200)
    const rows = await directSql`SELECT name, deleted_at FROM plants WHERE id = ${trojanId}`
    expect(rows[0].name).toBe('trojan-' + RUN)
    expect(rows[0].deleted_at).toBeNull()
  })

  it('DELETE /:id → 200 and actually soft-deletes the project-less row', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, { method: 'DELETE', path: `/api/plants/${plantlessId}` })
    expect(status, `DELETE → ${JSON.stringify(body)}`).toBe(200)
    const rows = await directSql`SELECT deleted_at FROM plants WHERE id = ${plantlessId}`
    expect(rows[0].deleted_at).toBeTruthy() // the DELETE always returns 200; assert the DB, not the echo
  })
})
