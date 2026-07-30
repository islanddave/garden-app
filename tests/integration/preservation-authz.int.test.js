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

// ── cross-tenant storage_location_id + harvest_log_id — write-FK household gate (0A.5) ───────────
// Two MORE ownership surfaces on the SAME write paths: a put-up may cite storage_location_id (owner
// column user_id) and harvest_log_id (owner column created_by). The FK enforces existence, NOT
// ownership — before loadStorageLocation/loadHarvestLog (index.js), an authed user could POST/PUT
// their OWN row carrying ANOTHER household's storage_location_id and read its label + kind back
// through the four read surfaces that LEFT JOIN storage_location (empirically POST 201 → GET returns
// the foreign label/kind). The explicit-use_by_target arm is the exact bypass that reached it: it
// skipped the only pre-existing storage lookup (the L6 shelf-life kind read), which was itself
// non-rejecting. harvest_log has no read JOIN today → its arm is defense-in-depth against the same
// leak class. Dropping either `= ANY(householdIds)` predicate flips the reject arms (201 + a row
// carrying the foreign id), so this bites — same contract as the plant_id block above.
describe('AUTHZ preservation cross-tenant storage_location_id + harvest_log_id — write-FK household gate (0A.5)', () => {
  const RUN = testRunId()
  const OWNER = `authz_presv_wfk_owner_${RUN}`
  const FOREIGN = `authz_presv_wfk_foreign_${RUN}`
  let ownerStorageId, foreignStorageId, ownerHarvestId, foreignHarvestId

  beforeAll(async () => {
    // Owner + foreign storage locations (owner column is user_id).
    ownerStorageId = (await directSql`
      INSERT INTO storage_location (user_id, label, kind)
      VALUES (${OWNER}, ${'authz-wfk-own-' + RUN}, ${'deep_freezer'}) RETURNING id`)[0].id
    foreignStorageId = (await directSql`
      INSERT INTO storage_location (user_id, label, kind)
      VALUES (${FOREIGN}, ${'FOREIGN-SECRET-FREEZER-' + RUN}, ${'deep_freezer'}) RETURNING id`)[0].id

    // Owner harvest_log chain (project → event → harvest_log; created_by is loadHarvestLog's anchor).
    const op = (await directSql`INSERT INTO plant_projects (name, slug, created_by) VALUES (${'authz-wfk-op-' + RUN}, ${'authz-wfk-op-' + RUN}, ${OWNER}) RETURNING id`)[0].id
    const oe = (await directSql`INSERT INTO event_log (project_id, event_type, event_date, is_public, logged_by, created_by) VALUES (${op}, 'harvest', NOW(), false, ${OWNER}, ${OWNER}) RETURNING id`)[0].id
    ownerHarvestId = (await directSql`INSERT INTO harvest_log (event_id, project_id, quantity, unit, created_by) VALUES (${oe}, ${op}, ${3}, ${'lb'}, ${OWNER}) RETURNING id`)[0].id

    // Foreign harvest_log chain (another household).
    const fp = (await directSql`INSERT INTO plant_projects (name, slug, created_by) VALUES (${'authz-wfk-fp-' + RUN}, ${'authz-wfk-fp-' + RUN}, ${FOREIGN}) RETURNING id`)[0].id
    const fe = (await directSql`INSERT INTO event_log (project_id, event_type, event_date, is_public, logged_by, created_by) VALUES (${fp}, 'harvest', NOW(), false, ${FOREIGN}, ${FOREIGN}) RETURNING id`)[0].id
    foreignHarvestId = (await directSql`INSERT INTO harvest_log (event_id, project_id, quantity, unit, created_by) VALUES (${fe}, ${fp}, ${3}, ${'lb'}, ${FOREIGN}) RETURNING id`)[0].id
  })

  afterAll(async () => {
    // FK order: preservation_log (SET NULL FKs, so safe first) → harvest_log → event_log →
    // plant_projects (ON DELETE RESTRICT up the chain) → storage_location.
    await directSql`DELETE FROM preservation_log WHERE user_id IN (${OWNER}, ${FOREIGN})`
    await directSql`DELETE FROM harvest_log WHERE created_by IN (${OWNER}, ${FOREIGN})`
    await directSql`DELETE FROM event_log WHERE created_by IN (${OWNER}, ${FOREIGN})`
    await directSql`DELETE FROM plant_projects WHERE created_by IN (${OWNER}, ${FOREIGN})`
    await directSql`DELETE FROM storage_location WHERE user_id IN (${OWNER}, ${FOREIGN})`
  })

  // whole_freeze needs no method_other_text; crop_type_slug satisfies attribution so plant_id stays
  // out of it — the FK under test is storage_location_id / harvest_log_id, nothing else.
  const putUp = (extra) => ({
    crop_type_slug: CROP, method: 'whole_freeze', quantity_value: 1, quantity_unit: 'pint',
    preserved_at: '2026-07-01', ...extra,
  })

  it('owner POST citing OWN storage_location + OWN harvest_log → 201 (positive control)', async () => {
    setTestUserId(OWNER)
    const { status, body } = await callHandler(preservationHandler, {
      method: 'POST', path: '/api/preservation',
      body: putUp({ storage_location_id: ownerStorageId, harvest_log_id: ownerHarvestId }),
    })
    expect(status).toBe(201)
    expect(body.storage_location_id).toBe(ownerStorageId)
    expect(body.harvest_log_id).toBe(ownerHarvestId)
  })

  it('owner POST citing a FOREIGN storage_location — WITH an explicit use_by_target (the bypass) → 400, no row', async () => {
    setTestUserId(OWNER)
    const { status, body } = await callHandler(preservationHandler, {
      method: 'POST', path: '/api/preservation',
      body: putUp({ storage_location_id: foreignStorageId, use_by_target: '2026-12-01' }),
    })
    expect(status).toBe(400)
    // No existence oracle — the error must not confirm the foreign row exists or echo its label.
    expect(body.error).not.toMatch(/household|permission|exists|freezer/i)
    const rows = await directSql`SELECT 1 FROM preservation_log WHERE storage_location_id = ${foreignStorageId}`
    expect(rows.length).toBe(0) // the confirmed exploit is closed: nothing stored carrying the foreign id
  })

  it('owner POST citing a FOREIGN storage_location — without use_by_target → 400', async () => {
    setTestUserId(OWNER)
    const { status } = await callHandler(preservationHandler, {
      method: 'POST', path: '/api/preservation',
      body: putUp({ storage_location_id: foreignStorageId }),
    })
    expect(status).toBe(400)
  })

  it('owner POST citing a FOREIGN harvest_log → 400, no row (defense-in-depth)', async () => {
    setTestUserId(OWNER)
    const { status } = await callHandler(preservationHandler, {
      method: 'POST', path: '/api/preservation',
      body: putUp({ harvest_log_id: foreignHarvestId }),
    })
    expect(status).toBe(400)
    const rows = await directSql`SELECT 1 FROM preservation_log WHERE harvest_log_id = ${foreignHarvestId}`
    expect(rows.length).toBe(0)
  })

  it('owner PUT cannot drift an own put-up onto a FOREIGN storage_location → 400, row UNCHANGED', async () => {
    setTestUserId(OWNER)
    const created = await callHandler(preservationHandler, {
      method: 'POST', path: '/api/preservation',
      body: putUp({ storage_location_id: ownerStorageId }),
    })
    expect(created.status).toBe(201)
    const { status } = await callHandler(preservationHandler, {
      method: 'PUT', path: `/api/preservation/${created.body.id}`,
      body: putUp({ storage_location_id: foreignStorageId }),
    })
    expect(status).toBe(400)
    // The denied write must not have mutated the FK — still the OWN storage location.
    const rows = await directSql`SELECT storage_location_id FROM preservation_log WHERE id = ${created.body.id}`
    expect(rows[0].storage_location_id).toBe(ownerStorageId)
  })
})
