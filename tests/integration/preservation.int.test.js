// preservation.int.test.js — integration coverage for the preservation Lambda (Put-Up).
// Runs the REAL handler (lambda/preservation/index.js) against an ephemeral Neon branch with
// SecretsManager + Clerk stubbed by the harness. Every assertion mirrors index.js, verified against
// the live staging schema (preservation_log: user_id text NN owner; method/attribution/quantity/
// package_count/method_other CHECKs; plant_id + harvest_log_id FKs ON DELETE SET NULL).
//
// Surfaces: POST (validation + create scoped to sub + auto use_by_target default L6 + remaining_count
// seed), GET list (user-scoped, soft-delete + fully-consumed excluded), PUT (minimal decrement L4),
// DELETE (soft-delete), whats-put-up (storage grouping + Unassigned bucket + crop regroup),
// use-soon (in-window include / null-use-by exclude / past-date distinct flag / not-yet-soon exclude),
// ON-DELETE-SET-NULL (delete plant -> plant_id NULL; delete harvest_log -> harvest_log_id NULL).
//
// quantity_value is NUMERIC -> the driver returns it as a JS string; readbacks coerce via Number().

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId } from './_harness.js'
import { handler } from '../../lambda/preservation/index.js'

const RUN = testRunId()
const USER = `user_int_pres_${RUN}`
const FOREIGN_USER = `user_int_pres_foreign_${RUN}`
const CROP = 'tomato' // existing crop_types slug (FK target)

let foreignId
let storageId
let plantId
let harvestLogId
let projectId
let eventId

function isoDate(offsetDays) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offsetDays)
  return d.toISOString().slice(0, 10)
}

beforeAll(async () => {
  setTestUserId(USER)

  // Own storage location (deep_freezer) for grouping + auto-use-by tests.
  const s = await directSql`
    INSERT INTO storage_location (user_id, label, kind)
    VALUES (${USER}, ${'freezer-' + RUN}, ${'deep_freezer'})
    RETURNING id
  `
  storageId = s[0].id

  // Own plant (minimal fixture: name + created_by; other NN cols have defaults) for ON DELETE SET NULL.
  const pl = await directSql`
    INSERT INTO plants (name, created_by) VALUES (${'pres-plant-' + RUN}, ${USER}) RETURNING id
  `
  plantId = pl[0].id

  // Harvest-log provenance chain (plant_projects -> event_log -> harvest_log) for ON DELETE SET NULL.
  const proj = await directSql`
    INSERT INTO plant_projects (name, slug, created_by)
    VALUES (${'pres-proj-' + RUN}, ${'pres-proj-' + RUN}, ${USER}) RETURNING id
  `
  projectId = proj[0].id
  const ev = await directSql`
    INSERT INTO event_log (project_id, event_type, event_date, is_public, logged_by, created_by)
    VALUES (${projectId}, 'harvest', NOW(), false, ${USER}, ${USER}) RETURNING id
  `
  eventId = ev[0].id
  const hl = await directSql`
    INSERT INTO harvest_log (event_id, project_id, quantity, unit, created_by)
    VALUES (${eventId}, ${projectId}, ${5}, ${'lb'}, ${USER}) RETURNING id
  `
  harvestLogId = hl[0].id

  // Foreign-owned put-up (different household) for scope + 404 tests.
  const fi = await directSql`
    INSERT INTO preservation_log (user_id, crop_type_slug, preserved_at, method, quantity_value, quantity_unit, package_count, remaining_count)
    VALUES (${FOREIGN_USER}, ${CROP}, ${isoDate(-10)}, ${'whole_freeze'}, ${3}, ${'lb'}, ${2}, ${2})
    RETURNING id
  `
  foreignId = fi[0].id
})

afterAll(async () => {
  await directSql`DELETE FROM preservation_log WHERE user_id IN (${USER}, ${FOREIGN_USER})`
  await directSql`DELETE FROM harvest_log WHERE created_by = ${USER}`
  await directSql`DELETE FROM event_log WHERE created_by = ${USER}`
  await directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`
  // entity FK (ON DELETE RESTRICT) references plantings — clear registry rows before the plants.
  await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id IN (SELECT id FROM plants WHERE created_by = ${USER})`
  await directSql`DELETE FROM plants WHERE created_by = ${USER}`
  await directSql`DELETE FROM storage_location WHERE user_id = ${USER}`
})

describe('POST /api/preservation — validation', () => {
  it('no crop and no variety -> 400 (attribution)', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/preservation',
      body: { method: 'whole_freeze', quantity_value: 2, quantity_unit: 'lb', preserved_at: isoDate(0) },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/at least one of crop_type_slug or variety_id/i)
  })

  it('invalid method -> 400', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/preservation',
      body: { crop_type_slug: CROP, method: 'sunbake', quantity_value: 2, quantity_unit: 'lb', preserved_at: isoDate(0) },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/method must be one of/i)
  })

  it("method 'other' without method_other_text -> 400", async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/preservation',
      body: { crop_type_slug: CROP, method: 'other', quantity_value: 2, quantity_unit: 'lb', preserved_at: isoDate(0) },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/method_other_text is required/i)
  })

  it('quantity_value <= 0 -> 400', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/preservation',
      body: { crop_type_slug: CROP, method: 'whole_freeze', quantity_value: 0, quantity_unit: 'lb', preserved_at: isoDate(0) },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/quantity_value must be > 0/i)
  })
})

describe('POST /api/preservation — create', () => {
  it('valid POST -> 201, scoped to sub, remaining_count seeded from package_count', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/preservation',
      body: { crop_type_slug: CROP, method: 'whole_freeze', quantity_value: 4, quantity_unit: 'lb', package_count: 3, preserved_at: isoDate(-1), storage_location_id: storageId },
    })
    expect(status).toBe(201)
    expect(body.id).toBeTruthy()
    expect(body.user_id).toBe(USER)
    expect(Number(body.quantity_value)).toBe(4)
    expect(body.package_count).toBe(3)
    expect(body.remaining_count).toBe(3) // seeded from package_count (L4)
    const rows = await directSql`SELECT user_id, method FROM preservation_log WHERE id = ${body.id}`
    expect(rows[0].user_id).toBe(USER)
  })

  it('auto-applies L6 shelf-life default use_by_target when omitted (deep_freezer whole_freeze ~12mo)', async () => {
    setTestUserId(USER)
    const preserved = isoDate(0)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/preservation',
      body: { crop_type_slug: CROP, method: 'whole_freeze', quantity_value: 2, quantity_unit: 'lb', preserved_at: preserved, storage_location_id: storageId },
    })
    expect(status).toBe(201)
    expect(body.use_by_target).toBeTruthy() // default applied, not null
    const months = (new Date(body.use_by_target).getUTCFullYear() - new Date(preserved).getUTCFullYear()) * 12
      + (new Date(body.use_by_target).getUTCMonth() - new Date(preserved).getUTCMonth())
    expect(months).toBe(12) // deep_freezer whole_freeze = 12 (cited NCHFP/USDA table)
  })

  it('explicit use_by_target: null is honored (no default applied)', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/preservation',
      body: { crop_type_slug: CROP, method: 'whole_freeze', quantity_value: 2, quantity_unit: 'lb', preserved_at: isoDate(0), storage_location_id: storageId, use_by_target: null },
    })
    expect(status).toBe(201)
    expect(body.use_by_target).toBeNull()
  })
})

describe('GET /api/preservation — list (user-scoped, exclusions)', () => {
  // Base GET /api/preservation is the RAW record list (edit/history surface): it filters deleted_at
  // + user scope, but NOT fully-consumed (a consumed record still exists; GET/:id must reach it to
  // un-consume). Fully-consumed exclusion is a property of the two INVENTORY reads (whats-put-up /
  // use-soon) per spec — asserted below and in the decrement→0 test.
  it('bare array, foreign excluded, soft-deleted excluded; consumed excluded from whats-put-up read', async () => {
    setTestUserId(USER)
    const keep = await callHandler(handler, {
      method: 'POST', path: '/api/preservation',
      body: { crop_type_slug: CROP, method: 'blanch_freeze', quantity_value: 1, quantity_unit: 'lb', preserved_at: isoDate(-2) },
    })
    const del = await callHandler(handler, {
      method: 'POST', path: '/api/preservation',
      body: { crop_type_slug: CROP, method: 'blanch_freeze', quantity_value: 1, quantity_unit: 'lb', preserved_at: isoDate(-2) },
    })
    await directSql`UPDATE preservation_log SET deleted_at = NOW() WHERE id = ${del.body.id}`
    const consumed = await callHandler(handler, {
      method: 'POST', path: '/api/preservation',
      body: { crop_type_slug: CROP, method: 'blanch_freeze', quantity_value: 1, quantity_unit: 'lb', package_count: 1, preserved_at: isoDate(-2) },
    })
    await directSql`UPDATE preservation_log SET remaining_count = 0 WHERE id = ${consumed.body.id}`

    const { status, body } = await callHandler(handler, { method: 'GET', path: '/api/preservation' })
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    const ids = body.map((r) => r.id)
    expect(ids).toContain(keep.body.id)
    expect(ids).not.toContain(foreignId)
    expect(ids).not.toContain(del.body.id)

    // fully-consumed row IS excluded from the inventory read (whats-put-up), even though it remains
    // in the raw record list above.
    const wpu = await callHandler(handler, { method: 'GET', path: '/api/preservation/whats-put-up' })
    const wpuIds = wpu.body.groups.flatMap((g) => g.records.map((r) => r.id))
    expect(wpuIds).not.toContain(consumed.body.id)
  })

  it('GET /:id foreign-owner -> 404', async () => {
    setTestUserId(USER)
    const { status } = await callHandler(handler, { method: 'GET', path: `/api/preservation/${foreignId}` })
    expect(status).toBe(404)
  })
})

describe('PUT /api/preservation/:id — minimal decrement (L4)', () => {
  it('decrement remaining_count -> 200, persisted', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/preservation',
      body: { crop_type_slug: CROP, method: 'whole_freeze', quantity_value: 6, quantity_unit: 'lb', package_count: 5, preserved_at: isoDate(-1) },
    })
    const id = created.body.id
    const { status, body } = await callHandler(handler, {
      method: 'PUT', path: `/api/preservation/${id}`,
      body: { crop_type_slug: CROP, method: 'whole_freeze', quantity_value: 6, quantity_unit: 'lb', package_count: 5, preserved_at: created.body.preserved_at, remaining_count: 2 },
    })
    expect(status).toBe(200)
    expect(body.remaining_count).toBe(2)
    const rows = await directSql`SELECT remaining_count FROM preservation_log WHERE id = ${id}`
    expect(rows[0].remaining_count).toBe(2)
  })

  it('remaining_count 0 -> consumed_at auto-stamped; row drops from whats-put-up', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/preservation',
      body: { crop_type_slug: CROP, method: 'whole_freeze', quantity_value: 2, quantity_unit: 'lb', package_count: 1, preserved_at: isoDate(-1), storage_location_id: storageId },
    })
    const id = created.body.id
    const put = await callHandler(handler, {
      method: 'PUT', path: `/api/preservation/${id}`,
      body: { crop_type_slug: CROP, method: 'whole_freeze', quantity_value: 2, quantity_unit: 'lb', package_count: 1, preserved_at: created.body.preserved_at, remaining_count: 0 },
    })
    expect(put.status).toBe(200)
    expect(put.body.consumed_at).toBeTruthy()
    const wpu = await callHandler(handler, { method: 'GET', path: '/api/preservation/whats-put-up' })
    const allRecordIds = wpu.body.groups.flatMap((g) => g.records.map((r) => r.id))
    expect(allRecordIds).not.toContain(id)
  })

  it('PUT foreign-owner -> 404', async () => {
    setTestUserId(USER)
    const { status } = await callHandler(handler, {
      method: 'PUT', path: `/api/preservation/${foreignId}`,
      body: { crop_type_slug: CROP, method: 'whole_freeze', quantity_value: 1, quantity_unit: 'lb', preserved_at: isoDate(0) },
    })
    expect(status).toBe(404)
  })
})

describe('DELETE /api/preservation/:id — soft-delete', () => {
  it('own DELETE -> 200 {ok:true}; deleted_at set; GET/:id then 404', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/preservation',
      body: { crop_type_slug: CROP, method: 'dehydrate', quantity_value: 1, quantity_unit: 'oz', preserved_at: isoDate(-1) },
    })
    const id = created.body.id
    const { status, body } = await callHandler(handler, { method: 'DELETE', path: `/api/preservation/${id}` })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    const rows = await directSql`SELECT deleted_at FROM preservation_log WHERE id = ${id}`
    expect(rows[0].deleted_at).toBeTruthy()
    const get = await callHandler(handler, { method: 'GET', path: `/api/preservation/${id}` })
    expect(get.status).toBe(404)
  })

  it('DELETE non-existent -> 404', async () => {
    setTestUserId(USER)
    const { status } = await callHandler(handler, {
      method: 'DELETE', path: `/api/preservation/00000000-0000-4000-8000-0000000000ee`,
    })
    expect(status).toBe(404)
  })
})

describe('GET /api/preservation/whats-put-up — grouping', () => {
  it('groups by storage location by default; NULL storage -> Unassigned bucket', async () => {
    setTestUserId(USER)
    await callHandler(handler, {
      method: 'POST', path: '/api/preservation',
      body: { crop_type_slug: CROP, method: 'whole_freeze', quantity_value: 3, quantity_unit: 'lb', package_count: 2, preserved_at: isoDate(-1), storage_location_id: storageId },
    })
    await callHandler(handler, {
      method: 'POST', path: '/api/preservation',
      body: { crop_type_slug: CROP, method: 'whole_freeze', quantity_value: 1, quantity_unit: 'lb', package_count: 1, preserved_at: isoDate(-1) }, // no storage -> Unassigned
    })
    const { status, body } = await callHandler(handler, { method: 'GET', path: '/api/preservation/whats-put-up' })
    expect(status).toBe(200)
    expect(body.group_by).toBe('storage')
    const storageGroup = body.groups.find((g) => g.group_key === storageId)
    const unassigned = body.groups.find((g) => g.group_key === 'unassigned')
    expect(storageGroup).toBeTruthy()
    expect(storageGroup.total_packages).toBeGreaterThanOrEqual(2)
    expect(storageGroup.units).toContain('lb') // per-record units listed, not summed across kinds
    expect(unassigned).toBeTruthy()
    expect(unassigned.label).toBe('Unassigned')
  })

  it('?group=crop regroups by crop with display name', async () => {
    setTestUserId(USER)
    // Real Lambda Function URLs put the query string in queryStringParameters, NOT rawPath, so the
    // literal-route match stays exact. Build the event directly (mirrors events.int.test.js).
    const res = await handler({
      requestContext: { http: { method: 'GET' } },
      rawPath: '/api/preservation/whats-put-up',
      headers: { authorization: `Bearer stub-token-for-${USER}` },
      queryStringParameters: { group: 'crop' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.group_by).toBe('crop')
    const cropGroup = body.groups.find((g) => g.group_key === CROP)
    expect(cropGroup).toBeTruthy()
    expect(cropGroup.label).toBeTruthy() // crop_types.display_name
  })
})

describe('GET /api/preservation/use-soon — server-side shelf-life window (L6)', () => {
  it('includes an in-window row; excludes null-use-by + not-yet-soon; flags past-use-by distinctly', async () => {
    setTestUserId(USER)
    // In-window: long span, now near the end -> use_soon.
    const inWindow = await callHandler(handler, {
      method: 'POST', path: '/api/preservation',
      body: { crop_type_slug: CROP, method: 'whole_freeze', quantity_value: 1, quantity_unit: 'lb', preserved_at: isoDate(-100), use_by_target: isoDate(3) },
    })
    // Past use-by.
    const past = await callHandler(handler, {
      method: 'POST', path: '/api/preservation',
      body: { crop_type_slug: CROP, method: 'whole_freeze', quantity_value: 1, quantity_unit: 'lb', preserved_at: isoDate(-100), use_by_target: isoDate(-5) },
    })
    // Not yet soon: fresh, far-off use-by.
    const notYet = await callHandler(handler, {
      method: 'POST', path: '/api/preservation',
      body: { crop_type_slug: CROP, method: 'whole_freeze', quantity_value: 1, quantity_unit: 'lb', preserved_at: isoDate(0), use_by_target: isoDate(300) },
    })
    // No expiry.
    const noExpiry = await callHandler(handler, {
      method: 'POST', path: '/api/preservation',
      body: { crop_type_slug: CROP, method: 'whole_freeze', quantity_value: 1, quantity_unit: 'lb', preserved_at: isoDate(-1), use_by_target: null },
    })

    const { status, body } = await callHandler(handler, { method: 'GET', path: '/api/preservation/use-soon' })
    expect(status).toBe(200)
    const byId = Object.fromEntries(body.items.map((r) => [r.id, r]))
    expect(byId[inWindow.body.id]?.use_by_status).toBe('use_soon')
    expect(byId[past.body.id]?.use_by_status).toBe('past_use_by')
    expect(byId[notYet.body.id]).toBeUndefined() // not yet soon -> excluded
    expect(byId[noExpiry.body.id]).toBeUndefined() // null use_by -> excluded
  })
})

describe('ON DELETE SET NULL — put-up survives parent deletion', () => {
  it('delete a plants row -> preservation_log.plant_id becomes NULL, row survives', async () => {
    setTestUserId(USER)
    // Dedicated plant so the delete does not disturb the shared beforeAll fixture.
    const pl = await directSql`INSERT INTO plants (name, created_by) VALUES (${'del-plant-' + RUN}, ${USER}) RETURNING id`
    const localPlantId = pl[0].id
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/preservation',
      body: { crop_type_slug: CROP, method: 'whole_freeze', quantity_value: 1, quantity_unit: 'lb', preserved_at: isoDate(-1), plant_id: localPlantId },
    })
    expect(created.body.plant_id).toBe(localPlantId)
    // A trigger auto-registers an `entity` row for the planting (FK ON DELETE RESTRICT) — clear it
    // before deleting the plant so the delete can proceed (mirrors inventory-items cultivar cleanup).
    await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id = ${localPlantId}`
    await directSql`DELETE FROM plants WHERE id = ${localPlantId}`
    const rows = await directSql`SELECT plant_id, deleted_at FROM preservation_log WHERE id = ${created.body.id}`
    expect(rows).toHaveLength(1) // put-up row survives
    expect(rows[0].plant_id).toBeNull() // FK ON DELETE SET NULL
    expect(rows[0].deleted_at).toBeNull()
  })

  it('delete a harvest_log row -> preservation_log.harvest_log_id becomes NULL, row survives', async () => {
    setTestUserId(USER)
    // Dedicated harvest_log chain so the delete does not disturb the shared fixture.
    const ev = await directSql`
      INSERT INTO event_log (project_id, event_type, event_date, is_public, logged_by, created_by)
      VALUES (${projectId}, 'harvest', NOW(), false, ${USER}, ${USER}) RETURNING id
    `
    const hl = await directSql`
      INSERT INTO harvest_log (event_id, project_id, quantity, unit, created_by)
      VALUES (${ev[0].id}, ${projectId}, ${2}, ${'lb'}, ${USER}) RETURNING id
    `
    const localHarvestId = hl[0].id
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/preservation',
      body: { crop_type_slug: CROP, method: 'whole_freeze', quantity_value: 1, quantity_unit: 'lb', preserved_at: isoDate(-1), harvest_log_id: localHarvestId },
    })
    expect(created.body.harvest_log_id).toBe(localHarvestId)
    await directSql`DELETE FROM harvest_log WHERE id = ${localHarvestId}`
    const rows = await directSql`SELECT harvest_log_id FROM preservation_log WHERE id = ${created.body.id}`
    expect(rows).toHaveLength(1)
    expect(rows[0].harvest_log_id).toBeNull() // FK ON DELETE SET NULL
  })
})
