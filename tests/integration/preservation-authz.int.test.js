// preservation-authz.int.test.js — 0A.5 Phase-1 leak-lock for the preservation Lambda
// (lambda/preservation/index.js). Real handler vs an ephemeral Neon branch (harness stubs
// SecretsManager + Clerk; SQL is REAL). Compensating control for the RLS-off posture (see _authz.js).
//
// AUTH MODEL: household-scoped on `user_id = ANY(householdIds)` (owner column is user_id) +
// `deleted_at IS NULL`, on GET/:id (index.js:397), PUT/:id (:473-475), DELETE/:id (:487-488) and the
// list (:508). Denied = 404 (RETURNING gate on both PUT and DELETE — cleaner than storage-location).
// The generic matrix covers those. A SECOND ownership surface — planting attribution — is pinned by
// the custom block below: loadPlanting (:181-192) is household-scoped, so a put-up cannot be
// attributed to another household's plant_id (which would leak that planting's name/variety back
// through the read surfaces, and write a cross-household FK).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, setTestUserId, testRunId } from './_harness.js'
import { describeAuthzMatrix } from './_authz.js'
import { handler as preservationHandler } from '../../lambda/preservation/index.js'

// crop_type_slug is an FK to the static crop_types vocab (attribution CHECK needs crop_type_slug OR
// variety_id). Grab a real slug once — top-level await against directSql, same pattern as
// tags-authz's HAS_TAGS probe.
const CROP = (await directSql`SELECT slug FROM crop_types ORDER BY slug LIMIT 1`)[0].slug

// ── generic matrix: GET/:id read + PUT write + deleted_at ──────────────────────────────────────
describeAuthzMatrix({
  name: 'preservation /api/preservation/:id',
  handler: preservationHandler,
  seedResource: async (owner) => {
    const r = await directSql`
      INSERT INTO preservation_log (user_id, crop_type_slug, preserved_at, method, quantity_value, quantity_unit)
      VALUES (${owner}, ${CROP}, '2026-07-01', 'whole_freeze', ${1}, 'pint') RETURNING id`
    return r[0].id
  },
  read: (id) => ({ method: 'GET', path: `/api/preservation/${id}` }),
  // PUT is a FULL replace validated by validateUpdate (validateCommon) — send a complete valid
  // payload. blanch_freeze avoids the method='other' method_other_text requirement; omitting
  // source_kind leaves validateUpdate's provenance check inert and the stored (null) source intact.
  write: (id) => ({
    method: 'PUT', path: `/api/preservation/${id}`,
    body: { crop_type_slug: CROP, method: 'blanch_freeze', quantity_value: 2, quantity_unit: 'jar', preserved_at: '2026-07-02' },
  }),
  softDelete: async (id) => { await directSql`UPDATE preservation_log SET deleted_at = NOW() WHERE id = ${id}` },
  readBack: async (id) => {
    const r = await directSql`SELECT quantity_unit FROM preservation_log WHERE id = ${id}`
    return r[0] ?? null
  },
  cleanup: async (ctx) => {
    await directSql`DELETE FROM preservation_log WHERE user_id = ${ctx.__owner}`
  },
})

// ── cross-tenant plant_id attribution — custom (0A.5) ──────────────────────────────────────────
// A put-up may cite a plant_id; the handler DERIVES crop/variety from that planting via
// loadPlanting, which is household-scoped. Owner referencing their OWN planting → 201. Owner
// referencing a FOREIGN household's planting → loadPlanting returns null →
// reconcilePlantAttribution rejects with 400 (no existence oracle) and NO row lands. Dropping the
// `= ANY(householdIds)` scope from loadPlanting flips both assertions (201 + a row with the foreign
// plant_id), so this bites.
describe('AUTHZ preservation cross-tenant plant_id /api/preservation — attribution household gate (0A.5)', () => {
  const RUN = testRunId()
  const OWNER = `authz_presv_owner_${RUN}`
  const FOREIGN = `authz_presv_foreign_${RUN}`
  let ownerProj, foreignProj, ownerPlantId, foreignPlantId

  beforeAll(async () => {
    const op = await directSql`
      INSERT INTO plant_projects (name, slug, created_by)
      VALUES (${'authz-presv-op-' + RUN}, ${'authz-presv-op-' + RUN}, ${OWNER}) RETURNING id`
    ownerProj = op[0].id
    const fp = await directSql`
      INSERT INTO plant_projects (name, slug, created_by)
      VALUES (${'authz-presv-fp-' + RUN}, ${'authz-presv-fp-' + RUN}, ${FOREIGN}) RETURNING id`
    foreignProj = fp[0].id
    const opl = await directSql`
      INSERT INTO plants (project_id, name, created_by)
      VALUES (${ownerProj}, ${'authz-presv-oplant-' + RUN}, ${OWNER}) RETURNING id`
    ownerPlantId = opl[0].id
    const fpl = await directSql`
      INSERT INTO plants (project_id, name, created_by)
      VALUES (${foreignProj}, ${'authz-presv-fplant-' + RUN}, ${FOREIGN}) RETURNING id`
    foreignPlantId = fpl[0].id
  })

  afterAll(async () => {
    // entity registry (planting_ref_id) FK is ON DELETE RESTRICT — clear entity rows before plants.
    await directSql`DELETE FROM preservation_log WHERE user_id IN (${OWNER}, ${FOREIGN})`
    await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id IN (${ownerPlantId}, ${foreignPlantId})`
    await directSql`DELETE FROM plants WHERE created_by IN (${OWNER}, ${FOREIGN})`
    await directSql`DELETE FROM plant_projects WHERE created_by IN (${OWNER}, ${FOREIGN})`
  })

  // crop_type_slug carried alongside plant_id so a variety-less fixture planting still satisfies the
  // "that planting has no variety — pick a crop as well" guard; the plant_id is what's under test.
  const putUpBody = (plantId) => ({
    plant_id: plantId, crop_type_slug: CROP,
    method: 'whole_freeze', quantity_value: 1, quantity_unit: 'pint', preserved_at: '2026-07-01',
  })

  it('owner POST citing OWN planting → 201 (positive control)', async () => {
    setTestUserId(OWNER)
    const { status, body } = await callHandler(preservationHandler, { method: 'POST', path: '/api/preservation', body: putUpBody(ownerPlantId) })
    expect(status).toBe(201)
    expect(body.plant_id).toBe(ownerPlantId)
  })

  it('owner POST citing a FOREIGN household planting → 400, no row created', async () => {
    setTestUserId(OWNER)
    const { status, body } = await callHandler(preservationHandler, { method: 'POST', path: '/api/preservation', body: putUpBody(foreignPlantId) })
    expect(status).toBe(400)
    expect(body.error).toMatch(/planting you can log against/i)
    const rows = await directSql`SELECT 1 FROM preservation_log WHERE plant_id = ${foreignPlantId} AND user_id = ${OWNER} AND deleted_at IS NULL`
    expect(rows.length).toBe(0) // cross-household attribution / existence-oracle regression guard
  })
})
