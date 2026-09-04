// inventory-items.int.test.js — integration coverage for the inventory-items Lambda.
// Verified against lambda/inventory-items/index.js at dev HEAD 48f17db (live read, not the
// Phase-2 design doc): every active assertion mirrors validateCreate/validateUpdate and the
// real SQL in index.js, and was cross-checked against the deployed inventory_items schema
// (CHECK constraints + NOT NULL columns introspected on the staging + prod Neon branches).
//
// HONEST-REWRITE NOTE (2026-05-31, crucible-validated):
//   The prior version of this file asserted an entire variety surface + handler behaviors that
//   the shipped Lambda does not implement (variety_id read/write, plant_varieties JOIN exposing
//   variety_name/variety_crop_type, ?category/?variety_id query filters, COALESCE-style PUT,
//   idempotent DELETE) and never sent the REQUIRED `type` field. Its `beforeAll` also INSERTed
//   plant_varieties(crop_type,...) — `crop_type` exists on plant_varieties in NEITHER staging nor
//   prod (drift conclusively ruled out via information_schema on both). Those assertions are
//   re-homed into describe.skip blocks below, gated on TICKET-VARIETY-INV.
//
// REAL handler surface exercised here:
//   POST  — name required; type required (consumable|durable); category enum; consumable requires
//           quantity_on_hand+unit; durable requires quantity; create returns 201 + RETURNING *.
//   GET   — list is a BARE ARRAY, household-scoped, soft-deletes excluded (no JOIN, no filters).
//   GET/:id — household-scoped 200 with featured_photo_view_url key; foreign/non-existent -> 404.
//   PUT   — "replace editable fields": omitted fields are NULLED (NOT COALESCE); category enum 400;
//           foreign -> 404; write->read-back asserts the stored value (L-108).
//   DELETE — soft-delete own -> 200 {ok:true}; non-existent -> 404 (handler is NOT idempotent).
//
// quantity is NUMERIC -> @neondatabase/serverless returns it as a JS string; readbacks coerce via Number().

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId } from './_harness.js'
import { handler } from '../../lambda/inventory-items/index.js'

const RUN = testRunId()
const USER = `user_int_inv_${RUN}`
const FOREIGN_USER = `user_int_inv_foreign_${RUN}`
let foreignItemId

beforeAll(async () => {
  setTestUserId(USER)
  // Foreign-owned inventory item (different household) to test scope + foreign-404.
  // All NOT NULL columns provided (user_id, created_by, type, name, category); durable_requires_quantity CHECK -> quantity.
  const fi = await directSql`
    INSERT INTO inventory_items (user_id, created_by, type, name, category, quantity)
    VALUES (${FOREIGN_USER}, ${FOREIGN_USER}, ${'durable'}, ${'foreign-item-' + RUN}, ${'tools'}, ${1})
    RETURNING id
  `
  foreignItemId = fi[0].id
})

afterAll(async () => {
  await directSql`DELETE FROM inventory_items WHERE created_by IN (${USER}, ${FOREIGN_USER})`
})

describe('POST /api/inventory-items — validation + create', () => {
  it('missing name -> 400 (name checked before type)', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/inventory-items', body: { category: 'tools', type: 'durable' },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/name is required/i)
  })

  it('missing type -> 400 type must be consumable or durable', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/inventory-items', body: { name: 'no-type-' + RUN, category: 'tools' },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/type must be consumable or durable/i)
  })

  it('invalid category enum -> 400 (type valid so category check is reached)', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/inventory-items',
      body: { name: 'bad-cat-' + RUN, type: 'durable', category: 'unicorn-feed', quantity: 1 },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/category must be one of/i)
  })

  it('consumable missing unit -> 400', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/inventory-items',
      body: { name: 'no-unit-' + RUN, type: 'consumable', category: 'nutrients_and_amendments', quantity_on_hand: 5 },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/unit is required for consumable/i)
  })

  it('valid durable POST -> 201, stored, quantity coerced (write->read-back)', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/inventory-items',
      body: { name: 'trowel-' + RUN, type: 'durable', category: 'tools', quantity: 2 },
    })
    expect(status).toBe(201)
    expect(body.id).toBeTruthy()
    expect(body.name).toBe('trowel-' + RUN)
    expect(body.category).toBe('tools')
    expect(body.type).toBe('durable')
    expect(Number(body.quantity)).toBe(2) // NUMERIC -> string
    expect(body.created_by).toBe(USER)
    const rows = await directSql`SELECT name, category, type FROM inventory_items WHERE id = ${body.id}`
    expect(rows[0].name).toBe('trowel-' + RUN)
    expect(rows[0].type).toBe('durable')
  })

  it('valid consumable POST -> 201 (quantity_on_hand + unit persisted)', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/inventory-items',
      body: { name: 'feed-' + RUN, type: 'consumable', category: 'nutrients_and_amendments', quantity_on_hand: 5, unit: 'each' },
    })
    expect(status).toBe(201)
    expect(body.type).toBe('consumable')
    expect(body.unit).toBe('each')
    expect(Number(body.quantity_on_hand)).toBe(5)
  })
})

describe('GET /api/inventory-items — list (bare array, household-scoped)', () => {
  it('returns a BARE ARRAY, household-scoped (foreign excluded)', async () => {
    setTestUserId(USER)
    await callHandler(handler, {
      method: 'POST', path: '/api/inventory-items',
      body: { name: 'list-member-' + RUN, type: 'durable', category: 'containers', quantity: 1 },
    })
    const { status, body } = await callHandler(handler, { method: 'GET', path: '/api/inventory-items' })
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    const ids = body.map((r) => r.id)
    expect(ids).not.toContain(foreignItemId)
  })

  it('soft-deleted rows excluded from list', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/inventory-items',
      body: { name: 'soft-del-' + RUN, type: 'durable', category: 'other', quantity: 1 },
    })
    const id = created.body.id
    expect(id).toBeTruthy()
    await directSql`UPDATE inventory_items SET deleted_at = NOW() WHERE id = ${id}`
    const { body } = await callHandler(handler, { method: 'GET', path: '/api/inventory-items' })
    expect(body.map((r) => r.id)).not.toContain(id)
  })
})

describe('GET /api/inventory-items/:id — single', () => {
  it('own item -> 200 with featured_photo_view_url key', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/inventory-items',
      body: { name: 'single-get-' + RUN, type: 'durable', category: 'growing_media', quantity: 1 },
    })
    const id = created.body.id
    const { status, body } = await callHandler(handler, { method: 'GET', path: `/api/inventory-items/${id}` })
    expect(status).toBe(200)
    expect(body.id).toBe(id)
    expect(body).toHaveProperty('featured_photo_view_url') // single-GET adds presigned-url key (null without a linked photo)
  })

  it('foreign-owner item -> 404', async () => {
    setTestUserId(USER)
    const { status } = await callHandler(handler, { method: 'GET', path: `/api/inventory-items/${foreignItemId}` })
    expect(status).toBe(404)
  })

  it('non-existent UUID -> 404', async () => {
    setTestUserId(USER)
    const { status } = await callHandler(handler, {
      method: 'GET', path: `/api/inventory-items/00000000-0000-4000-8000-000000000000`,
    })
    expect(status).toBe(404)
  })
})

describe('PUT /api/inventory-items/:id — update (replace semantics)', () => {
  it('foreign-owner -> 404', async () => {
    setTestUserId(USER)
    const { status } = await callHandler(handler, {
      method: 'PUT', path: `/api/inventory-items/${foreignItemId}`, body: { name: 'hijack', type: 'durable', category: 'tools', quantity: 1 },
    })
    expect(status).toBe(404)
  })

  it('complete-payload update -> 200, name changed, persisted (write->read-back)', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/inventory-items',
      body: { name: 'before-' + RUN, type: 'durable', category: 'tools', quantity: 1 },
    })
    const id = created.body.id
    // Handler is "replace editable fields" — frontend sends a COMPLETE payload (type/category are NOT NULL).
    const { status, body } = await callHandler(handler, {
      method: 'PUT', path: `/api/inventory-items/${id}`,
      body: { name: 'after-' + RUN, type: 'durable', category: 'tools', quantity: 4, notes: 'kept' },
    })
    expect(status).toBe(200)
    expect(body.name).toBe('after-' + RUN)
    expect(body.notes).toBe('kept')
    expect(Number(body.quantity)).toBe(4)
    const rows = await directSql`SELECT name, notes FROM inventory_items WHERE id = ${id}`
    expect(rows[0].name).toBe('after-' + RUN)
    expect(rows[0].notes).toBe('kept')
  })

  it('invalid category enum in PUT -> 400 (validateUpdate before SQL)', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/inventory-items',
      body: { name: 'put-cat-' + RUN, type: 'durable', category: 'tools', quantity: 1 },
    })
    const { status, body } = await callHandler(handler, {
      method: 'PUT', path: `/api/inventory-items/${created.body.id}`,
      body: { category: 'time-machine' },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/category must be one of/i)
  })
})

describe('DELETE /api/inventory-items/:id — soft-delete', () => {
  it('own item DELETE -> 200 {ok:true}; deleted_at set; GET single then 404', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/inventory-items',
      body: { name: 'del-target-' + RUN, type: 'durable', category: 'shelving', quantity: 1 },
    })
    const id = created.body.id
    const { status, body } = await callHandler(handler, { method: 'DELETE', path: `/api/inventory-items/${id}` })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    const rows = await directSql`SELECT deleted_at FROM inventory_items WHERE id = ${id}`
    expect(rows[0].deleted_at).toBeTruthy()
    const get = await callHandler(handler, { method: 'GET', path: `/api/inventory-items/${id}` })
    expect(get.status).toBe(404)
  })

  it('DELETE non-existent -> 404 (handler is NOT idempotent)', async () => {
    setTestUserId(USER)
    const { status } = await callHandler(handler, {
      method: 'DELETE', path: `/api/inventory-items/00000000-0000-4000-8000-0000000000cc`,
    })
    expect(status).toBe(404)
  })
})

// ============================================================================
// SKIPPED — variety surface. TICKET-VARIETY-INV.
// The deployed inventory_items schema HAS `variety_id` (FK -> plant_varieties ON DELETE RESTRICT)
// AND a live CHECK `chk_inventory_seed_requires_variety: (category <> 'seeds' OR variety_id IS NOT NULL)`
// on BOTH staging and prod — but lambda/inventory-items/index.js implements NO variety logic
// (no validateVarietyId, no variety_id in INSERT/UPDATE column lists, no plant_varieties JOIN).
// Consequence (real prod bug, surfaced to Dave): creating a `seeds` item through the Lambda hits
// chk_inventory_seed_requires_variety and returns a raw 23514 -> 400 "Constraint violation",
// because the handler never accepts/sets variety_id. Un-skip these when the Lambda is wired.
// Note: `variety_crop_type` (asserted by the prior version) is itself invalid — plant_varieties
// has no crop_type column anywhere; a joined variety field must use a real column (species/genus).
// ============================================================================
describe('variety surface (TICKET-VARIETY-INV — Lambda now wired)', () => {
  let varietyId
  beforeAll(async () => {
    setTestUserId(USER)
    const v = await directSql`
      INSERT INTO plant_varieties (name, created_by)
      VALUES (${'int-inv-variety-' + RUN}, ${USER})
      RETURNING id
    `
    varietyId = v[0].id
  })
  afterAll(async () => {
    await directSql`DELETE FROM inventory_items WHERE created_by = ${USER} AND variety_id IS NOT NULL`
    // entity registry FK ON DELETE RESTRICT — clear auto-created cultivar entity rows first.
    await directSql`DELETE FROM entity WHERE entity_type='cultivar' AND cultivar_ref_id IN (SELECT id FROM plant_varieties WHERE created_by = ${USER})`
    await directSql`DELETE FROM plant_varieties WHERE created_by = ${USER}`
  })

  it('POST variety_id with non-seeds category -> 400', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/inventory-items',
      body: { name: 'wrong-cat-var-' + RUN, type: 'durable', category: 'tools', quantity: 1, variety_id: varietyId },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/variety_id is only allowed when category is seeds/i)
  })

  it('valid seeds POST WITH variety_id -> 201, variety_id stored', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/inventory-items',
      body: { name: 'tomato-seed-' + RUN, type: 'durable', category: 'seeds', quantity: 1, variety_id: varietyId },
    })
    expect(status).toBe(201)
    expect(body.variety_id).toBe(varietyId)
  })

  it('GET list/single expose variety_name via plant_varieties JOIN', async () => {
    setTestUserId(USER)
    const { body } = await callHandler(handler, { method: 'GET', path: '/api/inventory-items' })
    for (const row of body) expect(row).toHaveProperty('variety_name')
  })

  it('PUT variety_id SET on a seeds item (write-path)', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/inventory-items',
      body: { name: 'set-var-' + RUN, type: 'durable', category: 'seeds', quantity: 1, variety_id: varietyId },
    })
    const id = created.body.id
    const set = await callHandler(handler, {
      method: 'PUT', path: `/api/inventory-items/${id}`,
      body: { name: 'set-var-' + RUN, type: 'durable', category: 'seeds', quantity: 1, variety_id: varietyId },
    })
    expect(set.body.variety_id).toBe(varietyId)
  })
})

// SKIPPED — list query filters. Handler ignores queryStringParameters entirely (no ?category / ?variety_id).
describe.skip('list query filters (handler does not implement query filters yet)', () => {
  it('?category= filters the list', async () => {
    setTestUserId(USER)
    const { body } = await callHandler(handler, { method: 'GET', path: '/api/inventory-items?category=seeds' })
    for (const row of body) expect(row.category).toBe('seeds')
  })
})

// BUG-SEEDYEARNOOP-001 — year_harvested against REAL Postgres.
//
// This block exists because every other guard on this column reads SOURCE TEXT.
// put-year-harvested.test.js asserts the SET list contains the CASE and not a bare assignment;
// InventoryDetail.yearHarvested.test.jsx asserts what the client puts on the wire. Neither
// EXECUTES the statement, so neither can see a driver-level failure — and the presence guard binds
// a parameter inside a CASE, which is exactly the shape where @neondatabase/serverless has bitten
// this repo before (it cannot type a standalone null; here the CASE's ELSE branch supplies the
// integer type). "The SQL says the right thing" and "Postgres does the right thing" are different
// claims, and only this file can make the second one.
//
// The middle test is the one that matters. Four prod rows carry an irreplaceable year — the Hopi
// Black Dye Sunflower's 2025 exists structurally in this column and nowhere else — and they
// survived until today only because the SET list omitted the column entirely. Now that it is
// assigned, their protection is the ELSE branch and nothing else. This asserts that protection by
// running it, rather than by reading it.
describe('PUT year_harvested — presence guard against real Postgres (BUG-SEEDYEARNOOP-001)', () => {
  let varietyId
  let itemId

  beforeAll(async () => {
    setTestUserId(USER)
    const v = await directSql`
      INSERT INTO plant_varieties (name, created_by)
      VALUES (${'int-yh-variety-' + RUN}, ${USER})
      RETURNING id
    `
    varietyId = v[0].id
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/inventory-items',
      body: { name: 'yh-lot-' + RUN, type: 'durable', category: 'seeds', quantity: 1, variety_id: varietyId },
    })
    expect(created.status).toBe(201)
    itemId = created.body.id
  })

  afterAll(async () => {
    await directSql`DELETE FROM inventory_items WHERE id = ${itemId}`
    await directSql`DELETE FROM entity WHERE entity_type='cultivar' AND cultivar_ref_id = ${varietyId}`
    await directSql`DELETE FROM plant_varieties WHERE id = ${varietyId}`
  })

  const put = (extra) => callHandler(handler, {
    method: 'PUT', path: `/api/inventory-items/${itemId}`,
    body: { name: 'yh-lot-' + RUN, type: 'durable', category: 'seeds', quantity: 1, variety_id: varietyId, ...extra },
  })

  it('writes the year and stores it (write -> read-back)', async () => {
    setTestUserId(USER)
    const { status, body } = await put({ year_harvested: 1986 })
    expect(status).toBe(200)
    expect(body.year_harvested).toBe(1986)
    const rows = await directSql`SELECT year_harvested FROM inventory_items WHERE id = ${itemId}`
    expect(rows[0].year_harvested).toBe(1986)
  })

  it('PRESERVES the stored year when the key is omitted — the four curated rows', async () => {
    // The decisive assertion of this file. A bare assignment would null the column here and answer
    // 200, and no source-text guard can tell the two apart at runtime. The preceding test leaves
    // 1986 in place; this payload does not mention the column at all.
    setTestUserId(USER)
    const { status, body } = await put({})
    expect(status).toBe(200)
    expect(body.year_harvested).toBe(1986)
    const rows = await directSql`SELECT year_harvested FROM inventory_items WHERE id = ${itemId}`
    expect(rows[0].year_harvested).toBe(1986)
  })

  it('clears the year on an explicit null — presence, not truthiness', async () => {
    // The other half of the guard. If the sentinel tested `!= null` instead of hasOwnProperty this
    // would silently keep 1986 and a year entered by mistake would be unremovable.
    setTestUserId(USER)
    const { status, body } = await put({ year_harvested: null })
    expect(status).toBe(200)
    expect(body.year_harvested).toBe(null)
    const rows = await directSql`SELECT year_harvested FROM inventory_items WHERE id = ${itemId}`
    expect(rows[0].year_harvested).toBe(null)
  })
})
