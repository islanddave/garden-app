// seed-lifecycle.int.test.js — the FIRST execution of the seed-saving surface against a real
// Postgres. Closes the S1-gate the 2026-09-02 crucible called non-negotiable.
//
// WHY THIS FILE EXISTS. Every pre-existing seed test in this repo runs against
// `stubState.sqlHandler`, which captures SQL as TEXT and never executes it. That proves a string
// was built; it proves nothing about the database. Consequently the four things that actually
// carry the risk on this surface were structurally unreachable from the test target:
//   1. the CHECK constraints (seed_stage / seed_process / chk_inventory_seed_requires_variety)
//   2. the FK's ON DELETE RESTRICT on source_plant_id
//   3. the /seed-stage CTE's atomicity — that a refused UPDATE writes NO log row
//   4. the COALESCE(${enteredAt}::timestamptz, NOW()) cast on a backdated entry
// All four are asserted below by reading the row back with directSql, never by trusting the
// handler's own echo (L-108).
//
// Schema introspected live on an ephemeral Neon branch forked off staging, 2026-09-02:
//   inventory_items.seed_stage    CHECK: NULL | fermenting | drying | stored
//   inventory_items.seed_process  CHECK: NULL | wet | dry          (two values, not three)
//   inventory_items.source_plant_id uuid NULL -> plants(id) ON DELETE RESTRICT
//   chk_inventory_seed_requires_variety :: category <> 'seeds' OR variety_id IS NOT NULL
//   seed_lot_stage_log(inventory_item_id, stage, entered_at NOT NULL, note, created_by NOT NULL)
//
// NOTE ON entered_at: it is a column on seed_lot_stage_log, NOT on inventory_items.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId } from './_harness.js'
import { handler } from '../../lambda/inventory-items/index.js'

const RUN = testRunId()
const USER = `user_int_seed_${RUN}`
const FOREIGN_USER = `user_int_seed_foreign_${RUN}`

let varietyId
let parentPlantId
let foreignPlantId
let toolItemId

// Create a seed lot through the real POST route. Every seeds row must carry variety_id
// (chk_inventory_seed_requires_variety), and a consumable must carry unit + quantity_on_hand.
async function createSeedLot(extra = {}) {
  return callHandler(handler, {
    method: 'POST',
    path: '/api/inventory-items',
    body: {
      name: `seed-lot-${RUN}-${Math.random().toString(36).slice(2, 6)}`,
      type: 'consumable',
      category: 'seeds',
      unit: 'packet',
      quantity_on_hand: 1,
      variety_id: varietyId,
      ...extra,
    },
  })
}

beforeAll(async () => {
  setTestUserId(USER)

  const v = await directSql`
    INSERT INTO plant_varieties (name, created_by)
    VALUES (${'variety-' + RUN}, ${USER}) RETURNING id`
  varietyId = v[0].id

  const p = await directSql`
    INSERT INTO plants (project_id, name, created_by)
    VALUES (NULL, ${'parent-plant-' + RUN}, ${USER}) RETURNING id`
  parentPlantId = p[0].id

  const fp = await directSql`
    INSERT INTO plants (project_id, name, created_by)
    VALUES (NULL, ${'foreign-plant-' + RUN}, ${FOREIGN_USER}) RETURNING id`
  foreignPlantId = fp[0].id

  // A non-seed item, to prove the seeds-only predicates on both sub-routes.
  const t = await directSql`
    INSERT INTO inventory_items (user_id, created_by, type, name, category, quantity)
    VALUES (${USER}, ${USER}, ${'durable'}, ${'tool-' + RUN}, ${'tools'}, ${1}) RETURNING id`
  toolItemId = t[0].id
})

afterAll(async () => {
  // Only the rows this file's OWN FKs make undeletable-in-place are unwound by hand:
  // seed_lot_stage_log.inventory_item_id has no ON DELETE clause (NO ACTION), and
  // source_plant_id is ON DELETE RESTRICT, so the log rows and the items must go before
  // anything tries to remove a parent plant.
  //
  // plants and plant_varieties are DELIBERATELY left to the namespaced sweep in _cleanup.js.
  // Deleting them here fails: `entity` carries planting_ref_id/cultivar_ref_id FKs into both,
  // and the sweep is the thing that knows that ordering. Doing it by hand here reds the suite
  // in teardown while the sweep quietly succeeds a moment later.
  await directSql`
    DELETE FROM seed_lot_stage_log
     WHERE inventory_item_id IN (SELECT id FROM inventory_items WHERE created_by IN (${USER}, ${FOREIGN_USER}))`
  await directSql`DELETE FROM inventory_items WHERE created_by IN (${USER}, ${FOREIGN_USER})`
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE S1-GATE: create lot -> PATCH parent -> GET -> advance stage -> GET, against a real DB.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('seed lot write path — create -> link parent -> advance stages', () => {
  let lotId

  it('POST /api/inventory-items creates a seed lot', async () => {
    setTestUserId(USER)
    const { status, body } = await createSeedLot()
    expect(status, `POST -> ${JSON.stringify(body)}`).toBe(201)
    expect(body.category).toBe('seeds')
    expect(body.variety_id).toBe(varietyId)
    expect(body.seed_stage ?? null).toBeNull()
    lotId = body.id
  })

  it('PATCH /:id/source-plant links the parent planting', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'PATCH', path: `/api/inventory-items/${lotId}/source-plant`,
      body: { source_plant_id: parentPlantId },
    })
    expect(status, `PATCH -> ${JSON.stringify(body)}`).toBe(200)
    expect(body.source_plant_id).toBe(parentPlantId)
  })

  it('the parent is actually IN THE ROW, not just echoed (directSql read-back)', async () => {
    const [row] = await directSql`SELECT source_plant_id FROM inventory_items WHERE id = ${lotId}`
    expect(row.source_plant_id).toBe(parentPlantId)
  })

  it('GET /:id returns the linked parent', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'GET', path: `/api/inventory-items/${lotId}`,
    })
    expect(status).toBe(200)
    expect(body.source_plant_id).toBe(parentPlantId)
  })

  it('POST /:id/seed-stage opens the lot at fermenting and carries the process', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: `/api/inventory-items/${lotId}/seed-stage`,
      body: { stage: 'fermenting', seed_process: 'wet', note: 'jar on the sill' },
    })
    expect(status, `POST stage -> ${JSON.stringify(body)}`).toBe(201)
    expect(body.stage).toBe('fermenting')

    const [row] = await directSql`
      SELECT seed_stage, seed_process FROM inventory_items WHERE id = ${lotId}`
    expect(row.seed_stage).toBe('fermenting')
    expect(row.seed_process).toBe('wet')
  })

  it('advancing WITHOUT mentioning seed_process leaves the stored process alone', async () => {
    // Presence, not truthiness — the route's documented contract. An advance that does not
    // mention the key must not erase a process already set.
    setTestUserId(USER)
    const { status } = await callHandler(handler, {
      method: 'POST', path: `/api/inventory-items/${lotId}/seed-stage`, body: { stage: 'drying' },
    })
    expect(status).toBe(201)
    const [row] = await directSql`
      SELECT seed_stage, seed_process FROM inventory_items WHERE id = ${lotId}`
    expect(row.seed_stage).toBe('drying')
    expect(row.seed_process).toBe('wet')
  })

  it('advances to stored and GET /:id/seed-stage returns the full ordered history', async () => {
    setTestUserId(USER)
    await callHandler(handler, {
      method: 'POST', path: `/api/inventory-items/${lotId}/seed-stage`, body: { stage: 'stored' },
    })
    const { status, body } = await callHandler(handler, {
      method: 'GET', path: `/api/inventory-items/${lotId}/seed-stage`,
    })
    expect(status).toBe(200)
    expect(body).toHaveLength(3)
    expect(body.map((r) => r.stage)).toEqual(['stored', 'drying', 'fermenting']) // entered_at DESC

    const [row] = await directSql`SELECT seed_stage FROM inventory_items WHERE id = ${lotId}`
    expect(row.seed_stage).toBe('stored')
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The constraints and behaviours that a mock-SQL suite CANNOT reach.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('constraints that have never executed', () => {
  it('a seeds row without variety_id is refused by the HANDLER, before the DB CHECK', async () => {
    // Measured, not assumed: the app guard fires first and returns its own message, so the
    // DB CHECK is never reached on this path. Both layers are asserted — separately — because
    // "the constraint protects us" and "the handler protects us" are different claims and only
    // one of them is what a client actually sees.
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/inventory-items',
      body: {
        name: `no-variety-${RUN}`, type: 'consumable', category: 'seeds',
        unit: 'packet', quantity_on_hand: 1,
      },
    })
    expect(status, `POST -> ${JSON.stringify(body)}`).toBe(400)
    expect(String(body.error)).toMatch(/variety_id is required for seeds/i)
  })

  it('chk_inventory_seed_requires_variety is ARMED in the database, not merely declared', async () => {
    // A CHECK never violated in a test is indistinguishable from a CHECK never armed. This
    // bypasses the handler entirely and proves the constraint itself refuses the row.
    await expect(
      directSql`
        INSERT INTO inventory_items (user_id, created_by, type, name, category, unit, quantity_on_hand)
        VALUES (${USER}, ${USER}, ${'consumable'}, ${'raw-no-variety-' + RUN}, ${'seeds'}, ${'packet'}, ${1})`
    ).rejects.toThrow(/chk_inventory_seed_requires_variety/i)
  })

  it('source_plant_id FK is ON DELETE RESTRICT — the parent plant cannot be hard-deleted', async () => {
    setTestUserId(USER)
    const { body: lot } = await createSeedLot()
    await callHandler(handler, {
      method: 'PATCH', path: `/api/inventory-items/${lot.id}/source-plant`,
      body: { source_plant_id: parentPlantId },
    })
    await expect(
      directSql`DELETE FROM plants WHERE id = ${parentPlantId}`
    ).rejects.toThrow(/violates foreign key|source_plant_id/i)

    // leave the fixture linkable for later tests
    await directSql`UPDATE inventory_items SET source_plant_id = NULL WHERE id = ${lot.id}`
  })

  it('seed_stage CHECK rejects a value the route would have let through only by accident', async () => {
    setTestUserId(USER)
    const { body: lot } = await createSeedLot()
    await expect(
      directSql`UPDATE inventory_items SET seed_stage = ${'sprouted'} WHERE id = ${lot.id}`
    ).rejects.toThrow(/seed_stage/i)
  })

  it('backdated entered_at survives the ::timestamptz cast', async () => {
    setTestUserId(USER)
    const { body: lot } = await createSeedLot()
    const backdate = '2026-08-01T12:00:00.000Z'
    const { status } = await callHandler(handler, {
      method: 'POST', path: `/api/inventory-items/${lot.id}/seed-stage`,
      body: { stage: 'fermenting', entered_at: backdate },
    })
    expect(status).toBe(201)
    const [row] = await directSql`
      SELECT entered_at FROM seed_lot_stage_log WHERE inventory_item_id = ${lot.id}`
    expect(new Date(row.entered_at).toISOString()).toBe(backdate)
  })

  it('PUT seed_stage: null clears the stage (the documented clear path)', async () => {
    setTestUserId(USER)
    const { body: lot } = await createSeedLot()
    await callHandler(handler, {
      method: 'POST', path: `/api/inventory-items/${lot.id}/seed-stage`, body: { stage: 'drying' },
    })
    const { status } = await callHandler(handler, {
      method: 'PUT', path: `/api/inventory-items/${lot.id}`,
      body: {
        name: lot.name, type: 'consumable', category: 'seeds', unit: 'packet',
        quantity_on_hand: 1, variety_id: varietyId, seed_stage: null,
      },
    })
    expect(status).toBe(200)
    const [row] = await directSql`SELECT seed_stage FROM inventory_items WHERE id = ${lot.id}`
    expect(row.seed_stage).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Authorization and atomicity — the failure modes that leak or corrupt rather than 500.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('authz + CTE atomicity', () => {
  it('a foreign plant is refused as a parent, with no existence oracle', async () => {
    setTestUserId(USER)
    const { body: lot } = await createSeedLot()
    const { status, body } = await callHandler(handler, {
      method: 'PATCH', path: `/api/inventory-items/${lot.id}/source-plant`,
      body: { source_plant_id: foreignPlantId },
    })
    expect(status).toBe(400)
    expect(String(body.error)).not.toContain(foreignPlantId)

    const [row] = await directSql`SELECT source_plant_id FROM inventory_items WHERE id = ${lot.id}`
    expect(row.source_plant_id).toBeNull()
  })

  it('a non-UUID source_plant_id is refused before it reaches the FK', async () => {
    setTestUserId(USER)
    const { body: lot } = await createSeedLot()
    const { status } = await callHandler(handler, {
      method: 'PATCH', path: `/api/inventory-items/${lot.id}/source-plant`,
      body: { source_plant_id: 'not-a-uuid' },
    })
    expect(status).toBe(400)
  })

  it('source-plant on a NON-seed item 404s and changes nothing', async () => {
    setTestUserId(USER)
    const { status } = await callHandler(handler, {
      method: 'PATCH', path: `/api/inventory-items/${toolItemId}/source-plant`,
      body: { source_plant_id: parentPlantId },
    })
    expect(status).toBe(404)
    const [row] = await directSql`SELECT source_plant_id FROM inventory_items WHERE id = ${toolItemId}`
    expect(row.source_plant_id).toBeNull()
  })

  it('CTE ATOMICITY: a refused stage advance writes NO log row', async () => {
    // The whole point of the single-statement CTE. If the UPDATE matches nothing, `upd` is empty,
    // the INSERT selects from it, and zero rows are written. A mock-SQL suite cannot observe this
    // at all — it is the difference between a 404 and a 404 that also littered the log table.
    setTestUserId(USER)
    const before = await directSql`
      SELECT count(*)::int AS n FROM seed_lot_stage_log WHERE inventory_item_id = ${toolItemId}`
    const { status } = await callHandler(handler, {
      method: 'POST', path: `/api/inventory-items/${toolItemId}/seed-stage`,
      body: { stage: 'fermenting' },
    })
    expect(status).toBe(404)
    const after = await directSql`
      SELECT count(*)::int AS n FROM seed_lot_stage_log WHERE inventory_item_id = ${toolItemId}`
    expect(after[0].n).toBe(before[0].n)
    expect(after[0].n).toBe(0)
  })

  it("a foreign household's lot 404s on stage advance and writes no log row", async () => {
    setTestUserId(USER)
    const { body: lot } = await createSeedLot()
    setTestUserId(FOREIGN_USER)
    const { status } = await callHandler(handler, {
      method: 'POST', path: `/api/inventory-items/${lot.id}/seed-stage`,
      body: { stage: 'fermenting' },
    })
    expect(status).toBe(404)
    const [row] = await directSql`
      SELECT count(*)::int AS n FROM seed_lot_stage_log WHERE inventory_item_id = ${lot.id}`
    expect(row.n).toBe(0)
    setTestUserId(USER)
  })

  it("a foreign household cannot read a lot's stage history", async () => {
    setTestUserId(USER)
    const { body: lot } = await createSeedLot()
    await callHandler(handler, {
      method: 'POST', path: `/api/inventory-items/${lot.id}/seed-stage`, body: { stage: 'drying' },
    })
    setTestUserId(FOREIGN_USER)
    const { status, body } = await callHandler(handler, {
      method: 'GET', path: `/api/inventory-items/${lot.id}/seed-stage`,
    })
    expect(status).toBe(200)
    expect(body).toEqual([]) // scoped through the parent, so a guessed id yields nothing
    setTestUserId(USER)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// BUG-SEEDPOSTDROPSPARENT-001 — asserts the CORRECTED contract.
// RED until the POST INSERT names source_plant_id. Today the field is in neither the column list
// nor the VALUES, so the route returns 201 and RETURNING * echoes null: a silent drop with no
// retry signal, sitting directly on the "create a new seed" path.
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────────────────────
// V4-SEEDORIGIN-001 — the non-planting origin. These execute the four CHECKs the migration added,
// which is the only way to tell a constraint that is ARMED from one that is merely declared.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('source_kind — origin for seed that came from no planting of ours', () => {
  it('PATCH /:id/source-kind records a store-bought origin (the Carolina Reaper case)', async () => {
    setTestUserId(USER)
    const { body: lot } = await createSeedLot()
    const { status, body } = await callHandler(handler, {
      method: 'PATCH', path: `/api/inventory-items/${lot.id}/source-kind`,
      body: { source_kind: 'store' },
    })
    expect(status, `PATCH -> ${JSON.stringify(body)}`).toBe(200)
    const [row] = await directSql`SELECT source_kind FROM inventory_items WHERE id = ${lot.id}`
    expect(row.source_kind).toBe('store')
  })

  it('rejects a value outside the shipped vocabulary', async () => {
    setTestUserId(USER)
    const { body: lot } = await createSeedLot()
    const { status, body } = await callHandler(handler, {
      method: 'PATCH', path: `/api/inventory-items/${lot.id}/source-kind`,
      body: { source_kind: 'plant_swap' },
    })
    expect(status).toBe(400)
    expect(String(body.error)).toMatch(/must be one of/i)
  })

  it('null clears it — "not recorded" stays reachable', async () => {
    setTestUserId(USER)
    const { body: lot } = await createSeedLot()
    await callHandler(handler, {
      method: 'PATCH', path: `/api/inventory-items/${lot.id}/source-kind`, body: { source_kind: 'gift' },
    })
    const { status } = await callHandler(handler, {
      method: 'PATCH', path: `/api/inventory-items/${lot.id}/source-kind`, body: { source_kind: null },
    })
    expect(status).toBe(200)
    const [row] = await directSql`SELECT source_kind FROM inventory_items WHERE id = ${lot.id}`
    expect(row.source_kind).toBeNull()
  })

  it('a body that never mentions the key is a 400, not a silent clear', async () => {
    setTestUserId(USER)
    const { body: lot } = await createSeedLot()
    const { status } = await callHandler(handler, {
      method: 'PATCH', path: `/api/inventory-items/${lot.id}/source-kind`, body: {},
    })
    expect(status).toBe(400)
  })

  it('MUTUAL EXCLUSION — a lot cannot claim a shop origin AND a parent plant', async () => {
    setTestUserId(USER)
    const { body: lot } = await createSeedLot()
    await callHandler(handler, {
      method: 'PATCH', path: `/api/inventory-items/${lot.id}/source-plant`,
      body: { source_plant_id: parentPlantId },
    })
    const { status, body } = await callHandler(handler, {
      method: 'PATCH', path: `/api/inventory-items/${lot.id}/source-kind`,
      body: { source_kind: 'store' },
    })
    expect(status).toBe(400)
    expect(String(body.error)).toMatch(/own_garden/i)
    const [row] = await directSql`SELECT source_kind FROM inventory_items WHERE id = ${lot.id}`
    expect(row.source_kind).toBeNull()
    await directSql`UPDATE inventory_items SET source_plant_id = NULL WHERE id = ${lot.id}`
  })

  it('own_garden IS allowed alongside a parent plant', async () => {
    setTestUserId(USER)
    const { body: lot } = await createSeedLot()
    await callHandler(handler, {
      method: 'PATCH', path: `/api/inventory-items/${lot.id}/source-plant`,
      body: { source_plant_id: parentPlantId },
    })
    const { status } = await callHandler(handler, {
      method: 'PATCH', path: `/api/inventory-items/${lot.id}/source-kind`,
      body: { source_kind: 'own_garden' },
    })
    expect(status).toBe(200)
    await directSql`UPDATE inventory_items SET source_plant_id = NULL WHERE id = ${lot.id}`
  })

  it('chk_inventory_seed_source_plant is ARMED in the database, not merely declared', async () => {
    setTestUserId(USER)
    const { body: lot } = await createSeedLot()
    // Bypass the handler entirely — set both columns in one statement so no JS guard can intervene.
    await expect(
      directSql`UPDATE inventory_items
                   SET source_kind = ${'store'}, source_plant_id = ${parentPlantId}
                 WHERE id = ${lot.id}`
    ).rejects.toThrow(/chk_inventory_seed_source_plant/i)
  })

  it('chk_inventory_source_kind_seeds_only is ARMED — a tool cannot carry an origin', async () => {
    await expect(
      directSql`UPDATE inventory_items SET source_kind = ${'store'} WHERE id = ${toolItemId}`
    ).rejects.toThrow(/chk_inventory_source_kind_seeds_only/i)
  })

  it('source-kind on a NON-seed item 404s', async () => {
    setTestUserId(USER)
    const { status } = await callHandler(handler, {
      method: 'PATCH', path: `/api/inventory-items/${toolItemId}/source-kind`,
      body: { source_kind: 'store' },
    })
    expect(status).toBe(404)
  })

  it('POST persists source_kind rather than silently dropping it', async () => {
    setTestUserId(USER)
    const { status, body } = await createSeedLot({ source_kind: 'foraged' })
    expect(status).toBe(201)
    expect(body.source_kind).toBe('foraged')
    const [row] = await directSql`SELECT source_kind FROM inventory_items WHERE id = ${body.id}`
    expect(row.source_kind).toBe('foraged')
  })

  it('POST refuses a conflicting origin+parent pair up front', async () => {
    setTestUserId(USER)
    const { status } = await createSeedLot({ source_kind: 'store', source_plant_id: parentPlantId })
    expect(status).toBe(400)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// V4-SOWSTAGE-001 — the sowability link. This is the defect that ran in BOTH directions.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('sowability tracks the seed stage', () => {
  it('the view projects seed_stage and seed_process', async () => {
    const cols = await directSql`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'v_sow_candidates'
         AND column_name IN ('seed_stage', 'seed_process')`
    expect(cols).toHaveLength(2)
  })

  it('a fermenting lot is still LISTED as a candidate, carrying its stage', async () => {
    // Deliberately not filtered out of the view: the diversion is client-side so an in-process lot
    // stays visible and marked rather than vanishing for two weeks. What the view must do is carry
    // the stage so the client CAN divert it — before this migration it did not, and a jar of wet
    // seed was indistinguishable from a finished packet.
    setTestUserId(USER)
    const { body: lot } = await createSeedLot()
    await callHandler(handler, {
      method: 'POST', path: `/api/inventory-items/${lot.id}/seed-stage`,
      body: { stage: 'fermenting', seed_process: 'wet' },
    })
    const [row] = await directSql`
      SELECT seed_stage, seed_process FROM v_sow_candidates WHERE inventory_item_id = ${lot.id}`
    expect(row).toBeTruthy()
    expect(row.seed_stage).toBe('fermenting')
    expect(row.seed_process).toBe('wet')
  })

  it('a never-staged packet carries a null stage, which reads as sowable', async () => {
    setTestUserId(USER)
    const { body: lot } = await createSeedLot()
    const [row] = await directSql`
      SELECT seed_stage FROM v_sow_candidates WHERE inventory_item_id = ${lot.id}`
    expect(row.seed_stage).toBeNull()
  })

  it('the projection did not change which rows are candidates', async () => {
    // The five continuous rowcount gates on this view pin it to the unfiltered base join. Asserted
    // here too, self-differencing, so it stays true as the population changes.
    const [n] = await directSql`
      SELECT (SELECT count(*) FROM v_sow_candidates)
           - (SELECT count(*) FROM inventory_items i
                JOIN plant_varieties v ON v.id = i.variety_id
               WHERE i.category = 'seeds' AND i.deleted_at IS NULL
                 AND i.status = 'active' AND v.deleted_at IS NULL) AS diff`
    expect(Number(n.diff)).toBe(0)
  })
})

describe('POST must not silently drop source_plant_id', () => {
  it('POST with source_plant_id persists it', async () => {
    setTestUserId(USER)
    const { status, body } = await createSeedLot({ source_plant_id: parentPlantId })
    expect(status).toBe(201)
    expect(body.source_plant_id).toBe(parentPlantId)
    const [row] = await directSql`SELECT source_plant_id FROM inventory_items WHERE id = ${body.id}`
    expect(row.source_plant_id).toBe(parentPlantId)
    await directSql`UPDATE inventory_items SET source_plant_id = NULL WHERE id = ${body.id}`
  })

  it('POST with a FOREIGN source_plant_id must not create the row silently linked', async () => {
    setTestUserId(USER)
    const { status, body } = await createSeedLot({ source_plant_id: foreignPlantId })
    expect(status).toBe(400)
    expect(String(body.error ?? '')).not.toContain(foreignPlantId)
  })
})
