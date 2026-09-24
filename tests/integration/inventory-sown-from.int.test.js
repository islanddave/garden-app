// tests/integration/inventory-sown-from.int.test.js
// V5-SEEDSTAB-001 slice 3 (design section 9) — sown_from on GET /api/inventory-items/:id, on real Postgres.
//
// WHY THIS FILE EXISTS. BUG-SEEDDETAIL500-001 was a seed-detail SELECT that named a column garden_node
// does not have: every unit test was green (they read source text or run against a stub that never
// parses SQL), and every seed page in prod answered 500. sown_from is a NEW statement on that same
// route — a garden_node read joined to container — so it gets the check that bug did not: the real
// handler, the real driver, a real branch of staging's schema. lambda/inventory-items/sown-from.test.js
// holds the statement's WHERE to the plants Lambda's default views; this file proves Postgres runs it
// and that each clause does what it says on rows built to trip it.
//
// THE CONTRACT (lambda/inventory-items/index.js, the seeds branch of the by-id GET):
//   · sown_from lists every planting whose source_inventory_item_id is the packet, newest sowing first,
//     as { id, name, sown_at, status };
//   · and hides, IN SQL: a soft-deleted planting, an archived planting, a live planting in an ARCHIVED
//     container (Archive-Hiding Rule), and a planting another household owns — while a container-less
//     planting of this household is listed (the ownership arm is NULL-safe on the LEFT JOIN);
//   · germination.sowings is unchanged: exactly what the pre-slice statement returns for the packet;
//   · a non-seed item answers sown_from = null.
//
// FIXTURES are this file's own (`int-test-` namespaced users), built with the final state in the
// INSERT so no plants UPDATE trigger is involved. Teardown deletes plantings BEFORE the packet:
// plants.source_inventory_item_id is ON DELETE RESTRICT, and the global sweep (_cleanup.js STEPS)
// deletes inventory_items before plants, so a planting left behind would pin the packet as a leak.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId, insertProject } from './_harness.js'
import { settle, assertFixtureId } from './_cleanup.js'
import { handler } from '../../lambda/inventory-items/index.js'

const RUN = testRunId()
const USER = `user_int_sownfrom_${RUN}`
const FOREIGN = `user_int_sownfrom_foreign_${RUN}`

const get = (id) => callHandler(handler, { method: 'GET', path: `/api/inventory-items/${id}`, userId: USER })

let varietyId, itemId, otherItemId, toolId
let cLive, cArchived
let pLive, pNone, pArchived, pInArchived, pDeleted, pForeign, pOtherItem

async function packet(tag, extra = {}) {
  const res = await callHandler(handler, {
    method: 'POST', path: '/api/inventory-items', userId: USER,
    body: {
      name: `int-sownfrom-${tag}-${RUN}`, type: 'consumable', category: 'seeds', unit: 'packet',
      quantity_on_hand: 1, variety_id: varietyId, ...extra,
    },
  })
  expect(res.status, `POST packet -> ${JSON.stringify(res.body)}`).toBe(201)
  return res.body.id
}

async function planting(tag, {
  container = null, item = itemId, createdBy = USER, archived = false, deleted = false,
  sownAt = null, status = null, seedsSown = null, seedsGerminated = null,
} = {}) {
  const rows = await directSql`
    INSERT INTO plants (project_id, name, created_by, source_inventory_item_id, sown_at, status,
                        seeds_sown, seeds_germinated, archived_at, deleted_at)
    VALUES (${container}, ${`int-sownfrom-${tag}-${RUN}`}, ${createdBy}, ${item}, ${sownAt}, ${status},
            ${seedsSown}, ${seedsGerminated},
            CASE WHEN ${archived}::boolean THEN NOW() END,
            CASE WHEN ${deleted}::boolean THEN NOW() END)
    RETURNING id`
  return rows[0].id
}

beforeAll(async () => {
  setTestUserId(USER)
  const v = await directSql`
    INSERT INTO plant_varieties (name, created_by) VALUES (${`int-sownfrom-variety-${RUN}`}, ${USER}) RETURNING id`
  varietyId = v[0].id
  itemId = await packet('packet')
  otherItemId = await packet('other-packet')
  const tool = await callHandler(handler, {
    method: 'POST', path: '/api/inventory-items', userId: USER,
    body: { name: `int-sownfrom-tool-${RUN}`, type: 'durable', category: 'tools', quantity: 1 },
  })
  expect(tool.status, `POST tool -> ${JSON.stringify(tool.body)}`).toBe(201)
  toolId = tool.body.id

  cLive = (await insertProject({ name: `int-sownfrom-live-${RUN}`, createdBy: USER })).id
  cArchived = (await insertProject({ name: `int-sownfrom-archived-${RUN}`, createdBy: USER })).id
  await directSql`UPDATE plant_projects SET archived_at = NOW() WHERE id = ${cArchived}`

  // Listed — a planting in a live container, and a container-less one of this household.
  pLive = await planting('live', { container: cLive, sownAt: '2026-05-02', status: 'vegetative', seedsSown: 10, seedsGerminated: 7 })
  pNone = await planting('none', { sownAt: '2026-06-10', status: 'harvested' })
  // Hidden — one per clause.
  pArchived = await planting('archived', { container: cLive, archived: true, sownAt: '2026-06-20', status: 'vegetative', seedsSown: 5, seedsGerminated: 5 })
  pInArchived = await planting('in-archived', { container: cArchived, sownAt: '2026-06-21', status: 'vegetative' })
  pDeleted = await planting('deleted', { container: cLive, deleted: true, sownAt: '2026-06-22', status: 'vegetative', seedsSown: 3, seedsGerminated: 1 })
  pForeign = await planting('foreign', { createdBy: FOREIGN, sownAt: '2026-06-23', status: 'vegetative' })
  // Another packet's planting: never this packet's.
  pOtherItem = await planting('other-item', { container: cLive, item: otherItemId, sownAt: '2026-06-24', status: 'vegetative' })
})

afterAll(async () => {
  assertFixtureId(USER, FOREIGN)
  await settle('inventory-sown-from', [
    // plants_entity_ins makes an entity row per planting, and entity is ON DELETE RESTRICT against
    // plants — it goes first (plants-archived-container.int.test.js, same order).
    () => directSql`DELETE FROM entity WHERE entity_type = 'planting' AND planting_ref_id IN (
                      SELECT id FROM plants WHERE created_by IN (${USER}, ${FOREIGN}))`,
    () => directSql`DELETE FROM entity_memory WHERE plant_id IN (SELECT id FROM plants WHERE created_by IN (${USER}, ${FOREIGN}))`,
    // BEFORE the packets: plants.source_inventory_item_id is ON DELETE RESTRICT.
    () => directSql`DELETE FROM plants WHERE created_by IN (${USER}, ${FOREIGN})`,
    () => directSql`DELETE FROM entity_memory WHERE project_id IN (SELECT id FROM plant_projects WHERE created_by = ${USER})`,
    () => directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`,
    () => directSql`DELETE FROM inventory_items WHERE created_by = ${USER}`,
    // entity carries a cultivar_ref_id FK ON DELETE RESTRICT into plant_varieties.
    () => directSql`DELETE FROM entity WHERE entity_type = 'cultivar' AND cultivar_ref_id IN (SELECT id FROM plant_varieties WHERE created_by = ${USER})`,
    () => directSql`DELETE FROM plant_varieties WHERE created_by = ${USER}`,
  ])
})

describe('GET /api/inventory-items/:id — sown_from on real Postgres (V5-SEEDSTAB-001 slice 3)', () => {
  it('PRECONDITION: each hidden planting is hidden by exactly one thing', async () => {
    const rows = await directSql`
      SELECT p.id, p.deleted_at IS NOT NULL AS deleted, p.archived_at IS NOT NULL AS archived,
             pp.archived_at IS NOT NULL AS container_archived, p.created_by, p.source_inventory_item_id AS item
        FROM plants p LEFT JOIN plant_projects pp ON pp.id = p.project_id
       WHERE p.created_by IN (${USER}, ${FOREIGN})`
    const by = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(by[pArchived]).toMatchObject({ deleted: false, archived: true, container_archived: false })
    expect(by[pInArchived]).toMatchObject({ deleted: false, archived: false, container_archived: true })
    expect(by[pDeleted]).toMatchObject({ deleted: true, archived: false, container_archived: false })
    expect(by[pForeign]).toMatchObject({ deleted: false, archived: false, created_by: FOREIGN, item: itemId })
    expect(by[pOtherItem].item).toBe(otherItemId)
  })

  it('lists this household\'s live plantings from the packet, newest sowing first, as the four link fields', async () => {
    setTestUserId(USER)
    const { status, body } = await get(itemId)
    expect(status, JSON.stringify(body)).toBe(200)
    expect(Array.isArray(body.sown_from), 'sown_from is not an array on a seed row').toBe(true)
    // Presence first — the container-less planting proves the ownership arm is NULL-safe on the join.
    expect(body.sown_from.map((r) => r.id)).toEqual([pNone, pLive])
    expect(Object.keys(body.sown_from[0]).sort()).toEqual(['id', 'name', 'sown_at', 'status'])
    expect(body.sown_from[1]).toMatchObject({ id: pLive, name: `int-sownfrom-live-${RUN}`, status: 'vegetative' })
    expect(String(body.sown_from[1].sown_at).slice(0, 10)).toBe('2026-05-02')
  })

  it('hides, in SQL, the archived, the archived-container, the deleted, the foreign and the other packet\'s plantings', async () => {
    setTestUserId(USER)
    const ids = (await get(itemId)).body.sown_from.map((r) => r.id)
    expect(ids, 'an ARCHIVED planting is linked').not.toContain(pArchived)
    expect(ids, 'a planting in an ARCHIVED container is linked').not.toContain(pInArchived)
    expect(ids, 'a soft-deleted planting is linked').not.toContain(pDeleted)
    expect(ids, 'another household\'s planting is linked').not.toContain(pForeign)
    expect(ids, 'another packet\'s planting is linked').not.toContain(pOtherItem)
  })

  it('leaves germination exactly as the pre-slice statement computes it', async () => {
    setTestUserId(USER)
    const { body } = await get(itemId)
    const expected = await directSql`
      SELECT p.id, p.display_name AS name, p.sown_at, p.seeds_sown, p.seeds_germinated
        FROM public.garden_node p
       WHERE p.source_inventory_item_id = ${itemId}
         AND p.deleted_at IS NULL
         AND p.seeds_sown IS NOT NULL
       ORDER BY p.sown_at DESC NULLS LAST, p.id`
    expect(JSON.stringify(body.germination.sowings)).toBe(JSON.stringify(expected))
    expect(expected.length, 'the fixture must give germination something to show').toBeGreaterThan(0)
  })

  it('a non-seed item answers sown_from = null, and another household cannot read the packet at all', async () => {
    setTestUserId(USER)
    const tool = await get(toolId)
    expect(tool.status).toBe(200)
    expect(tool.body.sown_from).toBeNull()
    setTestUserId(FOREIGN)
    try {
      const foreign = await callHandler(handler, { method: 'GET', path: `/api/inventory-items/${itemId}`, userId: FOREIGN })
      expect(foreign.status).toBe(404)
    } finally {
      setTestUserId(USER)
    }
  })
})
