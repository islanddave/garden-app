// seed-lots-reverse.int.test.js — real-Postgres coverage of GET /api/plants/:id/seed-lots.
//
// WHY THIS EXISTS. The lane that built that route said plainly that nothing on it had executed
// against a database: the plants unit suite is mock-SQL, so its two-layer scoping, the LEFT JOIN's
// null behaviour and the `public.cultivar` view rename were asserted as SQL TEXT only. That is the
// exact gap the 2026-09-02 crucible raised against the whole seed feature, and shipping a new route
// with it would repeat the finding rather than close it.
//
// The thing worth executing here is the JOIN to `public.cultivar`. It is a VIEW over
// plant_varieties that renames name -> display_name, and reading `pv.name` through it is precisely
// the shape that passed a green audit, a green unit suite AND a green integration run while
// 500-ing every seed packet detail page in prod (BUG-SEEDDETAIL500-001). Only a real database
// can tell those two apart.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId } from './_harness.js'
import { handler } from '../../lambda/plants/index.js'

const RUN = testRunId()
const USER = `user_int_seedrev_${RUN}`
const FOREIGN_USER = `user_int_seedrev_foreign_${RUN}`

let varietyId
let plantId
let foreignPlantId
let lotA
let lotB

// qty defaults to 0, not null: consumable_requires_quantity_on_hand refuses null on a seeds row.
// See the beforeAll comment — this is the constraint, not a style choice.
async function makeLot({ name, createdBy, sourcePlant, stage = null, qty = 0 }) {
  const [row] = await directSql`
    INSERT INTO inventory_items (user_id, created_by, type, name, category, unit,
                                 quantity_on_hand, variety_id, status, source_plant_id, seed_stage)
    VALUES (${createdBy}, ${createdBy}, 'consumable', ${name}, 'seeds', 'packet',
            ${qty}, ${varietyId}, 'active', ${sourcePlant}, ${stage})
    RETURNING id`
  return row.id
}

beforeAll(async () => {
  setTestUserId(USER)

  const [v] = await directSql`
    INSERT INTO plant_varieties (name, created_by)
    VALUES (${'int-test-seedrev-var-' + RUN}, ${USER}) RETURNING id`
  varietyId = v.id

  const [p] = await directSql`
    INSERT INTO plants (project_id, name, created_by)
    VALUES (NULL, ${'int-test-seedrev-plant-' + RUN}, ${USER}) RETURNING id`
  plantId = p.id

  const [fp] = await directSql`
    INSERT INTO plants (project_id, name, created_by)
    VALUES (NULL, ${'int-test-seedrev-foreign-' + RUN}, ${FOREIGN_USER}) RETURNING id`
  foreignPlantId = fp.id

  // Two lots off the same plant: one counted, one saved-but-not-yet-counted.
  //
  // MEASURED, not assumed — a first draft of this file used qty: null for the uncounted lot and the
  // INSERT was refused: `violates check constraint "consumable_requires_quantity_on_hand"`. seeds is
  // a consumable-only category (src/lib/inventoryEnums.js declares types: ['consumable']), and that
  // CHECK is `type <> 'consumable' OR quantity_on_hand IS NOT NULL`. So a seeds lot CANNOT carry a
  // null count from any app surface, and "saved but not counted yet" is representable only as 0 —
  // which is exactly what SaveSeedSheet posts, and why. The client's null-handling is defensive
  // against a hand-written row rather than a state this flow can produce.
  lotA = await makeLot({ name: 'int-test-lot-a-' + RUN, createdBy: USER, sourcePlant: plantId, stage: 'drying', qty: 3 })
  lotB = await makeLot({ name: 'int-test-lot-b-' + RUN, createdBy: USER, sourcePlant: plantId, stage: null, qty: 0 })
})

afterAll(async () => {
  await directSql`DELETE FROM inventory_items WHERE created_by IN (${USER}, ${FOREIGN_USER})`
})

describe('GET /api/plants/:id/seed-lots — the reverse provenance read', () => {
  it('returns the lots saved from this planting', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'GET', path: `/api/plants/${plantId}/seed-lots`,
    })
    expect(status, `GET -> ${JSON.stringify(body)}`).toBe(200)
    expect(body.plant_id).toBe(plantId)
    expect(body.seed_lots.map((l) => l.id).sort()).toEqual([lotA, lotB].sort())
  })

  it('the cultivar VIEW rename resolves — variety_name is populated, not undefined', async () => {
    // The BUG-SEEDDETAIL500-001 shape. public.cultivar renames name -> display_name; selecting the
    // wrong one raises 42703 against a real database and is invisible to a mock-SQL suite.
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'GET', path: `/api/plants/${plantId}/seed-lots`,
    })
    expect(status).toBe(200)
    for (const lot of body.seed_lots) {
      expect(lot).toHaveProperty('variety_name')
      expect(lot.variety_name).toBe(`int-test-seedrev-var-${RUN}`)
    }
  })

  it('carries the count and the stage through, including a zero count', async () => {
    setTestUserId(USER)
    const { body } = await callHandler(handler, {
      method: 'GET', path: `/api/plants/${plantId}/seed-lots`,
    })
    const a = body.seed_lots.find((l) => l.id === lotA)
    const b = body.seed_lots.find((l) => l.id === lotB)
    expect(Number(a.quantity_on_hand)).toBe(3)
    expect(Number(b.quantity_on_hand)).toBe(0)
    expect(a.seed_stage).toBe('drying')
    expect(b.seed_stage).toBeNull()
  })

  it('a seeds lot cannot carry a NULL count — the constraint refuses it', async () => {
    // Pins the fact the fixture comment above records, so the reasoning cannot silently rot: the
    // "never counted" state is 0, not null, and the app's create path is right to post 0.
    await expect(
      directSql`
        INSERT INTO inventory_items (user_id, created_by, type, name, category, unit,
                                     quantity_on_hand, variety_id, status)
        VALUES (${USER}, ${USER}, 'consumable', ${'int-test-nullqty-' + RUN}, 'seeds', 'packet',
                NULL, ${varietyId}, 'active')`
    ).rejects.toThrow(/consumable_requires_quantity_on_hand/i)
  })

  it('a planting with no saved seed returns an empty list, not a 404', async () => {
    setTestUserId(USER)
    const [bare] = await directSql`
      INSERT INTO plants (project_id, name, created_by)
      VALUES (NULL, ${'int-test-seedrev-bare-' + RUN}, ${USER}) RETURNING id`
    const { status, body } = await callHandler(handler, {
      method: 'GET', path: `/api/plants/${bare.id}/seed-lots`,
    })
    expect(status).toBe(200)
    expect(body.seed_lots).toEqual([])
  })

  it("a foreign household's planting 404s and leaks nothing", async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'GET', path: `/api/plants/${foreignPlantId}/seed-lots`,
    })
    expect(status).toBe(404)
    expect(JSON.stringify(body)).not.toContain('int-test-lot-')
  })

  it('SCOPES ON THE LOT AS WELL AS THE PARENT — a foreign lot on a visible planting is excluded', async () => {
    // The reason the route carries two layers rather than one. Two members can hold plantings under
    // one container, so scoping only the parent would hand back another member's packets through a
    // planting the caller can legitimately see. Unreachable from a mock-SQL suite.
    const foreignLot = await makeLot({
      name: 'int-test-lot-foreign-' + RUN, createdBy: FOREIGN_USER, sourcePlant: plantId,
    })
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'GET', path: `/api/plants/${plantId}/seed-lots`,
    })
    expect(status).toBe(200)
    expect(body.seed_lots.map((l) => l.id)).not.toContain(foreignLot)
    await directSql`DELETE FROM inventory_items WHERE id = ${foreignLot}`
  })

  it('excludes a soft-deleted lot', async () => {
    const gone = await makeLot({
      name: 'int-test-lot-deleted-' + RUN, createdBy: USER, sourcePlant: plantId,
    })
    await directSql`UPDATE inventory_items SET deleted_at = NOW() WHERE id = ${gone}`
    setTestUserId(USER)
    const { body } = await callHandler(handler, {
      method: 'GET', path: `/api/plants/${plantId}/seed-lots`,
    })
    expect(body.seed_lots.map((l) => l.id)).not.toContain(gone)
  })

  it('a malformed planting id is a 404, not a 500', async () => {
    // loadOwnedPlantingRef's UUID_RE guard. Without it this is a 22P02 out of the catch as a 500.
    setTestUserId(USER)
    const { status } = await callHandler(handler, {
      method: 'GET', path: '/api/plants/not-a-uuid/seed-lots',
    })
    expect(status).toBe(404)
  })

  it('rejects a non-GET method', async () => {
    setTestUserId(USER)
    const { status } = await callHandler(handler, {
      method: 'POST', path: `/api/plants/${plantId}/seed-lots`, body: {},
    })
    expect(status).toBe(405)
  })
})
