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
// V5-SEEDQTY-001 widens lambda/plants' seed-lots SELECT to carry seed_count / seed_weight_g. The
// reverse read is exercised from here rather than from plants.int.test.js because the lot — and the
// measurement that makes the assertion mean anything — is written through THIS handler.
import { handler as plantsHandler } from '../../lambda/plants/index.js'

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

// ============================================================================
// V5-SEEDQTY-001 — PUT /api/inventory-items/:id/seed-measure.
//
// THE ONLY LAYER THAT CAN PROVE ANY OF THIS. lambda/_test-stubs/state.js:20 is
// `sqlHandler: () => []` — the Lambda unit suite records SQL text and executes none of it, so it
// reaches no constraint, no WHERE predicate and no stored row. Everything that carries risk on this
// route is therefore only observable here:
//   1. the four CHECKs armed by migrations/v5-seedqty-001/0a-additive-ddl.sql actually exist and
//      actually refuse (the count/weight nonneg pair, each paired with a 0 green control so a suite
//      that stopped executing cannot read as a pass);
//   2. presence vs ABSENCE genuinely differ against a STORED value — `{}` preserves, `{k:null}`
//      clears — which no text assertion can distinguish;
//   3. the three columns really are unreachable from the wide PUT, so an unrelated edit cannot
//      revert a count (BUG-INVLOSTUPDATE-001's shape).
// Every assertion reads the row back with directSql rather than trusting the handler's echo (L-108).
//
// PENDING THE DDL: these fail until 0a-additive-ddl.sql is applied to the branch under test. That is
// the intended ordering, not a broken test — the columns do not exist on prod as of 2026-09-04.
//
// A SEPARATE USER from the blocks above, deliberately: the `variety surface` describe's afterAll
// deletes `plant_varieties WHERE created_by = USER`, and these lots hold a variety_id FK. Its own
// namespace cannot be caught by that sweep whatever order the hooks end up running in.
// ============================================================================
describe('V5-SEEDQTY-001 — PUT /:id/seed-measure (seed count + weight)', () => {
  const QTY_USER = `user_int_invqty_${RUN}`
  let qtyVarietyId

  // Every seeds row must carry a variety (chk_inventory_seed_requires_variety), and both new CHECKs
  // require `type = 'consumable'` as well as `category = 'seeds'` — so a durable seeds row, which
  // the block above creates quite legally, cannot record a measurement. quantity_on_hand is 1 and
  // never null: consumable_requires_quantity_on_hand, and 1 is the CONTAINER count, which is the
  // whole point of the ticket.
  const createSeedLot = async (extra = {}) => callHandler(handler, {
    method: 'POST',
    path: '/api/inventory-items',
    body: {
      name: `qty-lot-${RUN}-${Math.random().toString(36).slice(2, 6)}`,
      type: 'consumable',
      category: 'seeds',
      unit: 'packet',
      quantity_on_hand: 1,
      variety_id: qtyVarietyId,
      ...extra,
    },
  })

  const measure = async (id, body) => callHandler(handler, {
    method: 'PUT', path: `/api/inventory-items/${id}/seed-measure`, body,
  })

  const stored = async (id) => (await directSql`
    SELECT seed_count, seed_weight_g, seed_count_estimated, quantity_on_hand, unit
      FROM inventory_items WHERE id = ${id}
  `)[0]

  beforeAll(async () => {
    setTestUserId(QTY_USER)
    const v = await directSql`
      INSERT INTO plant_varieties (name, created_by)
      VALUES (${'qty-variety-' + RUN}, ${QTY_USER}) RETURNING id`
    qtyVarietyId = v[0].id
  })

  afterAll(async () => {
    await directSql`DELETE FROM inventory_items WHERE created_by = ${QTY_USER}`
    // entity carries a cultivar_ref_id FK ON DELETE RESTRICT into plant_varieties — the auto-created
    // registry row goes first or the variety delete reds the suite in teardown.
    await directSql`DELETE FROM entity WHERE entity_type='cultivar' AND cultivar_ref_id IN (SELECT id FROM plant_varieties WHERE created_by = ${QTY_USER})`
    await directSql`DELETE FROM plant_varieties WHERE created_by = ${QTY_USER}`
  })

  it('writes a seed count and stores it — quantity_on_hand stays the CONTAINER count', async () => {
    setTestUserId(QTY_USER)
    const created = await createSeedLot()
    expect(created.status, `POST -> ${JSON.stringify(created.body)}`).toBe(201)
    const id = created.body.id

    const { status, body } = await measure(id, { seed_count: 185, seed_count_estimated: false })
    expect(status, `seed-measure -> ${JSON.stringify(body)}`).toBe(200)
    expect(body.seed_count).toBe(185)

    const row = await stored(id)
    expect(row.seed_count).toBe(185)
    expect(row.seed_count_estimated).toBe(false)
    // The bug this ticket closes, asserted directly: the count must NOT have landed in the quantity
    // column, and the unit must still be the container word. Prod today reads `185.000 packet`.
    expect(Number(row.quantity_on_hand)).toBe(1)
    expect(row.unit).toBe('packet')
  })

  it('a body that omits EVERY key leaves the stored measurement alone', async () => {
    // The presence contract, and the half a text-only test cannot reach. Template:
    // seed-lifecycle.int.test.js's "advancing WITHOUT mentioning seed_process".
    setTestUserId(QTY_USER)
    const { body: lot } = await createSeedLot()
    await measure(lot.id, { seed_count: 185, seed_weight_g: 0.5, seed_count_estimated: false })

    const { status } = await measure(lot.id, {})
    expect(status).toBe(200)

    const row = await stored(lot.id)
    expect(row.seed_count).toBe(185)
    expect(Number(row.seed_weight_g)).toBe(0.5)
    expect(row.seed_count_estimated).toBe(false)
  })

  it('an EXPLICIT null clears it — presence and absence must differ', async () => {
    setTestUserId(QTY_USER)
    const { body: lot } = await createSeedLot()
    await measure(lot.id, { seed_count: 185 })

    const { status } = await measure(lot.id, { seed_count: null })
    expect(status).toBe(200)
    expect((await stored(lot.id)).seed_count).toBeNull()
  })

  it('0 is a MEASURED FACT, stored and distinguishable from unrecorded', async () => {
    // "I counted them; the packet is empty" must survive. A truthiness test anywhere on this path
    // collapses it into "nobody has counted", which is the one thing the column exists to separate.
    setTestUserId(QTY_USER)
    const { body: lot } = await createSeedLot()
    const { status } = await measure(lot.id, { seed_count: 0, seed_weight_g: 0 })
    expect(status).toBe(200)
    const row = await stored(lot.id)
    expect(row.seed_count).toBe(0)
    expect(Number(row.seed_weight_g)).toBe(0)
  })

  it('REFUSES a negative seed_count (chk_inventory_seed_count_nonneg), and 0 is the green control', async () => {
    // The handler deliberately does NOT range-check in JS, so this executes the constraint itself.
    // Without the 0 arm below, a suite that had stopped running — or a route that 400s on every
    // body — would read as a pass.
    setTestUserId(QTY_USER)
    const { body: lot } = await createSeedLot()

    const bad = await measure(lot.id, { seed_count: -1 })
    expect(bad.status, `-1 was accepted: ${JSON.stringify(bad.body)}`).toBe(400)
    expect(bad.body.error, 'the constraint name leaked to the user').not.toMatch(/chk_/)
    expect(bad.body.error).toMatch(/cannot be negative/i)
    expect((await stored(lot.id)).seed_count, 'the refused write still landed').toBeNull()

    const good = await measure(lot.id, { seed_count: 0 })
    expect(good.status, `0 was refused: ${JSON.stringify(good.body)}`).toBe(200)
    expect((await stored(lot.id)).seed_count).toBe(0)
  })

  it('REFUSES a negative seed_weight_g (chk_inventory_seed_weight_nonneg), and 0 is the green control', async () => {
    // Same rule as the count — both columns are `>= 0`. The asymmetry in the first draft of this
    // ticket (count >= 0, weight > 0) was removed; do not reintroduce it.
    setTestUserId(QTY_USER)
    const { body: lot } = await createSeedLot()

    const bad = await measure(lot.id, { seed_weight_g: -1 })
    expect(bad.status, `-1 was accepted: ${JSON.stringify(bad.body)}`).toBe(400)
    expect(bad.body.error).not.toMatch(/chk_/)
    expect(bad.body.error).toMatch(/cannot be negative/i)
    expect((await stored(lot.id)).seed_weight_g, 'the refused write still landed').toBeNull()

    const good = await measure(lot.id, { seed_weight_g: 0 })
    expect(good.status, `0 was refused: ${JSON.stringify(good.body)}`).toBe(200)
    expect(Number((await stored(lot.id)).seed_weight_g)).toBe(0)
  })

  it('stores grams to 1 mg — numeric(10,3), not an integer column', async () => {
    // formatSeedWeight renders sub-gram lots in milligrams, so the third decimal has to survive the
    // round trip. numeric comes back from @neondatabase/serverless as a STRING; Number() it.
    setTestUserId(QTY_USER)
    const { body: lot } = await createSeedLot()
    const { status } = await measure(lot.id, { seed_weight_g: 0.055 })
    expect(status).toBe(200)
    expect(Number((await stored(lot.id)).seed_weight_g)).toBe(0.055)
  })

  it('a wide PUT that omits everything leaves seed_count UNCHANGED', async () => {
    // THE HEADLINE REGRESSION GUARD. src/hooks/useInventory.js adjustQuantity round-trips the entire
    // raw list row through the wide PUT with no strip list, so if these columns were ever added to
    // that SET list — even behind a presence guard, since updateItem merges a list loaded at mount —
    // a +/- tap on /inventory would write back a stale count and answer 200.
    setTestUserId(QTY_USER)
    const { body: lot } = await createSeedLot()
    await measure(lot.id, { seed_count: 185, seed_weight_g: 0.5, seed_count_estimated: false })

    const put = await callHandler(handler, {
      method: 'PUT', path: `/api/inventory-items/${lot.id}`,
      body: {
        name: lot.name, type: 'consumable', category: 'seeds', unit: 'packet',
        quantity_on_hand: 2, variety_id: qtyVarietyId,
      },
    })
    expect(put.status, `wide PUT -> ${JSON.stringify(put.body)}`).toBe(200)

    const row = await stored(lot.id)
    expect(row.seed_count, 'the wide PUT reverted the seed count').toBe(185)
    expect(Number(row.seed_weight_g)).toBe(0.5)
    expect(row.seed_count_estimated).toBe(false)
    // …and the container count IS still editable there, so this is not passing because the PUT did
    // nothing at all.
    expect(Number(row.quantity_on_hand)).toBe(2)
  })

  it('refuses to measure a lot in another household — 404, same as a missing one', async () => {
    setTestUserId(QTY_USER)
    const { body: lot } = await createSeedLot()
    setTestUserId(FOREIGN_USER)
    const { status } = await measure(lot.id, { seed_count: 1 })
    expect(status).toBe(404)
    setTestUserId(QTY_USER)
    expect((await stored(lot.id)).seed_count).toBeNull()
  })

  it('refuses to measure a NON-SEED item — 404 (the seeds-only predicate in the WHERE)', async () => {
    setTestUserId(QTY_USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/inventory-items',
      body: { name: 'qty-tool-' + RUN, type: 'durable', category: 'tools', quantity: 1 },
    })
    const { status } = await measure(created.body.id, { seed_count: 5 })
    expect(status).toBe(404)
  })

  it('a seeds row that is DURABLE gets the constraint, not a 404 lying about a row it can see', async () => {
    // Both seeds-only CHECKs assert `type = 'consumable'` as well. The route deliberately does not
    // add that conjunct to its WHERE: the row is real and the caller owns it, so the honest answer
    // is the rule, not "not found".
    setTestUserId(QTY_USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/inventory-items',
      body: {
        name: 'qty-durable-seeds-' + RUN, type: 'durable', category: 'seeds',
        quantity: 1, variety_id: qtyVarietyId,
      },
    })
    expect(created.status, `POST -> ${JSON.stringify(created.body)}`).toBe(201)
    const { status, body } = await measure(created.body.id, { seed_count: 5 })
    expect(status).toBe(400)
    expect(body.error).not.toMatch(/chk_/)
    expect(body.error).toMatch(/consumable/i)
  })

  it('the /seed-lots read on lambda/plants carries the count through', async () => {
    // Lane A item 4: without the widened SELECT the planting seed-lot list shows a silently blank
    // field. Read through the plants handler, not through inventory-items, because that is the
    // statement that was widened.
    setTestUserId(QTY_USER)
    const p = await directSql`
      INSERT INTO plants (project_id, name, created_by)
      VALUES (NULL, ${'qty-parent-' + RUN}, ${QTY_USER}) RETURNING id`
    const parentId = p[0].id
    const { body: lot } = await createSeedLot({ source_plant_id: parentId })
    await measure(lot.id, { seed_count: 185, seed_weight_g: 0.5 })

    const { status, body } = await callHandler(plantsHandler, {
      method: 'GET', path: `/api/plants/${parentId}/seed-lots`,
    })
    expect(status, `seed-lots -> ${JSON.stringify(body)}`).toBe(200)
    const row = body.seed_lots.find((r) => r.id === lot.id)
    expect(row, 'the lot is missing from the reverse read entirely').toBeTruthy()
    expect(row.seed_count).toBe(185)
    expect(Number(row.seed_weight_g)).toBe(0.5)
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
