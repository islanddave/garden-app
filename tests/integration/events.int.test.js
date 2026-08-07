// events.int.test.js — full integration coverage for the events Lambda.
// Runs the REAL handler (lambda/events/index.js) against an ephemeral Neon branch
// with SecretsManager + Clerk stubbed by the harness (vi.mock factories).
//
// Every assertion verified against lambda/events/index.js at dev HEAD e4b3305 +
// lambda/events/validators.js (not against the Phase-2 design doc, which has guesses).
// Notes inline mark which handler line each assertion verifies.
//
// Surfaces covered: POST validation + create + noon-anchor + flagged/severity matrix;
// GET list (array shape, project_id filter, soft-delete exclusion);
// GET single (UUID-oblivious 404 + foreign-owner 404 + match shape);
// PATCH resolve (body validation + flagged-only gate + resolved_at/by set).
//
// Batch routes (POST /api/events/batch + GET batches + DELETE undo) are a separate
// follow-up bite — they need plants-schema setup and a clean blast radius.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId, insertProject } from './_harness.js'
import { handler } from '../../lambda/events/index.js'

const RUN = testRunId()
const USER = `user_int_events_${RUN}`
const FOREIGN_USER = `user_int_events_foreign_${RUN}`
let projectId
let foreignProjectId
let foreignEventId

beforeAll(async () => {
  setTestUserId(USER)
  projectId = (await insertProject({ name: 'int-evt-' + RUN, createdBy: USER })).id

  // Foreign-owner fixture for 404 / scope tests.
  foreignProjectId = (await insertProject({ name: 'int-evt-foreign-' + RUN, createdBy: FOREIGN_USER })).id
  // Insert a foreign event directly so the scope test has something to NOT see.
  const fe = await directSql`
    INSERT INTO event_log
      (project_id, event_type, event_date, is_public, logged_by, created_by)
    VALUES
      (${foreignProjectId}, 'observation', NOW(), true, ${FOREIGN_USER}, ${FOREIGN_USER})
    RETURNING id
  `
  foreignEventId = fe[0].id
})

afterAll(async () => {
  await directSql`DELETE FROM xp_events WHERE user_id IN (${USER}, ${FOREIGN_USER})`
  await directSql`DELETE FROM user_achievements WHERE user_id IN (${USER}, ${FOREIGN_USER})`
  await directSql`DELETE FROM user_stats WHERE user_id IN (${USER}, ${FOREIGN_USER})`
  await directSql`DELETE FROM app_events WHERE user_clerk_sub IN (${USER}, ${FOREIGN_USER})`
  await directSql`DELETE FROM entity_memory WHERE project_id IN (${projectId}, ${foreignProjectId})`
  // BUG-HARVESTEDIT-001: harvest_log BEFORE event_log — harvest_log_event_id_fkey is a hard FK, so
  // deleting the parent first fails outright. Ordering matters here the same way the space-photos
  // teardown orders photos before spaces.
  await directSql`DELETE FROM harvest_log WHERE created_by IN (${USER}, ${FOREIGN_USER})`
  await directSql`DELETE FROM event_log WHERE created_by IN (${USER}, ${FOREIGN_USER})`
  // CAL-2: the germination describe seeds real plantings. Clear their auto-created entity-registry
  // rows (FK planting_ref_id ON DELETE RESTRICT) + plant-level entity_memory BEFORE deleting plants.
  await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id IN (SELECT id FROM plants WHERE created_by IN (${USER}, ${FOREIGN_USER}))`
  await directSql`DELETE FROM entity_memory WHERE plant_id IN (SELECT id FROM plants WHERE created_by IN (${USER}, ${FOREIGN_USER}))`
  await directSql`DELETE FROM plants WHERE created_by IN (${USER}, ${FOREIGN_USER})`
  await directSql`DELETE FROM plant_projects WHERE created_by IN (${USER}, ${FOREIGN_USER})`
})

// BUG-HARVESTEDIT-001 — PUT /api/events/:id.
//
// This route did not exist: EventDetail's Save has always PUT here and fallen through to a 405, so
// editing ANY event was silently broken in prod. The harvest half is the one with data
// consequences — harvest_log had a single INSERT and no UPDATE, making quantity/unit/quality and
// the CAL-1 weight columns write-once, with the Harvests totals reading those columns.
//
// Integration and not source-text assertions because every risk here is database-shaped: a real
// UPDATE against the live CHECKs (chk_harvest_log_weight_pairing is the one that turns a partial
// write into a 23514), the weight recompute joining through garden_node -> cultivar -> crop_types,
// and cross-household scoping via the container join.
describe('PUT /api/events/:id — BUG-HARVESTEDIT-001', () => {
  // ISOLATED project. Sibling describes reset state with a broad
  // `DELETE FROM event_log WHERE project_id = ...`, which a harvest_log child row blocks outright
  // (harvest_log_event_id_fkey). Sharing the main project made two unrelated rain tests fail — the
  // fixtures, not the code. Own project + own teardown keeps that blast radius at zero.
  let hProjectId
  beforeAll(async () => {
    hProjectId = (await insertProject({ name: 'int-evt-harvest-' + RUN, createdBy: USER })).id
  })
  afterAll(async () => {
    await directSql`DELETE FROM harvest_log WHERE event_id IN (SELECT id FROM event_log WHERE project_id = ${hProjectId})`
    await directSql`DELETE FROM entity_memory WHERE project_id = ${hProjectId}`
    await directSql`DELETE FROM event_log WHERE project_id = ${hProjectId}`
  })

  const put = (id, body) => callHandler(handler, { method: 'PUT', path: `/api/events/${id}`, body, userId: USER })

  async function makeHarvest({ quantity = 5, unit = 'count' } = {}) {
    const res = await callHandler(handler, {
      method: 'POST', path: '/api/events', userId: USER,
      body: {
        project_id: hProjectId, event_type: 'harvest', event_date: new Date().toISOString(),
        harvest: { quantity, unit, quality_rating: 4 },
      },
    })
    expect(res.status, `harvest create failed: ${JSON.stringify(res.body)}`).toBe(201)
    return res.body.id ?? res.body.eventId
  }
  const harvestRow = async (eventId) =>
    (await directSql`SELECT quantity, unit, quality_rating, weight_grams, weight_estimated, weight_basis
                       FROM harvest_log WHERE event_id = ${eventId} AND deleted_at IS NULL`)[0]

  it('edits the harvest amount — the number the Harvests totals actually read', async () => {
    // The headline fix. Mutation: drop the harvest_log UPDATE and the row keeps its original 5.
    const id = await makeHarvest({ quantity: 5, unit: 'count' })
    const res = await put(id, {
      event_type: 'harvest', event_date: new Date().toISOString(), notes: 'corrected',
      harvest: { quantity: 12, unit: 'count', quality_rating: 4 },
    })
    expect(res.status).toBe(200)
    const row = await harvestRow(id)
    expect(Number(row.quantity)).toBe(12)
    expect(row.unit).toBe('count')
  })

  it('recomputes weight to MEASURED when the unit becomes a weight', async () => {
    // All 306 prod rows are count/cup/head/bunch, so weight_grams is NULL everywhere today. An edit
    // to a weight unit is the first thing that will ever populate it — and it must, or CAL-1 keeps
    // reading NULL for a harvest the user has now told it the weight of.
    const id = await makeHarvest({ quantity: 5, unit: 'count' })
    expect((await harvestRow(id)).weight_grams).toBeNull()
    const res = await put(id, {
      event_type: 'harvest', event_date: new Date().toISOString(),
      harvest: { quantity: 2, unit: 'lb', quality_rating: null },
    })
    expect(res.status).toBe(200)
    const row = await harvestRow(id)
    expect(Number(row.weight_grams)).toBeCloseTo(907.184, 2)   // 2 lb
    expect(row.weight_estimated).toBe(false)                    // measured, not estimated
  })

  it('CLEARS a stale weight when the unit goes back to a non-weight — both columns move together', async () => {
    // The both-or-neither CHECK (chk_harvest_log_weight_pairing) makes a half-update a hard 23514,
    // and a stale weight left behind would silently inflate the totals. Mutation: leave weight_grams
    // out of the UPDATE and this either reds on the value or 500s on the constraint.
    const id = await makeHarvest({ quantity: 3, unit: 'lb' })
    expect(Number((await harvestRow(id)).weight_grams)).toBeGreaterThan(0)
    const res = await put(id, {
      event_type: 'harvest', event_date: new Date().toISOString(),
      harvest: { quantity: 3, unit: 'count', quality_rating: null },
    })
    expect(res.status).toBe(200)
    const row = await harvestRow(id)
    expect(row.weight_grams).toBeNull()
    expect(row.weight_estimated).toBeNull()
  })

  // BUG-HARVWEIGHTBLANK-001, behavioural half. fe75398 guarded the PUT so an unrelated edit could
  // not blank a stored weight, but shipped with STATIC (SQL-text) coverage only — which is exactly
  // how it then broke the sibling clear-a-stale-weight test above without either half going red.
  // The two meanings of "the resolver returned NULL" are opposite instructions, so each needs a
  // round trip, not an assertion about the shape of the statement.
  //
  // plant_id is NULL on these rows, so every resolver tier misses precisely as it does for the live
  // Wild Blackberry rows (plant_varieties.unit_weights IS NULL). Seeding the weight directly is the
  // point: it is a weight the resolver CANNOT reproduce, which is what makes preserving it the only
  // way to keep it.
  const seedUnpriceableWeight = async ({ unit = 'count', quantity = 1 } = {}) => {
    const id = await makeHarvest({ quantity, unit })
    expect((await harvestRow(id)).weight_grams, 'fixture assumes the resolver prices nothing').toBeNull()
    await directSql`UPDATE harvest_log SET weight_grams = 7.20, weight_estimated = true,
                      weight_basis = 'cultivar' WHERE event_id = ${id} AND deleted_at IS NULL`
    return id
  }

  it('PRESERVES an unpriceable stored weight across an unrelated edit — quality star, unit unchanged', async () => {
    // The fe75398 case end to end. Mutation: drop the CASE guards and this reds at 7.20 -> null.
    const id = await seedUnpriceableWeight()
    const res = await put(id, {
      event_type: 'harvest', event_date: new Date().toISOString(),
      harvest: { quantity: 1, unit: 'count', quality_rating: 5 },
    })
    expect(res.status).toBe(200)
    const row = await harvestRow(id)
    expect(Number(row.weight_grams)).toBeCloseTo(7.20, 2)
    expect(row.weight_estimated).toBe(true)
    expect(row.weight_basis).toBe('cultivar')
    expect(row.quality_rating).toBe(5)
  })

  it('PRESERVES it across a non-weight unit change too — the old unit was never a weight', async () => {
    // Pins the guard to old-unit WEIGHT-NESS rather than to old-unit EQUALITY: count -> bunch leaves
    // the resolver just as blind, so there is still nothing better than the stored number.
    const id = await seedUnpriceableWeight()
    const res = await put(id, {
      event_type: 'harvest', event_date: new Date().toISOString(),
      harvest: { quantity: 1, unit: 'bunch', quality_rating: 4 },
    })
    expect(res.status).toBe(200)
    expect(Number((await harvestRow(id)).weight_grams)).toBeCloseTo(7.20, 2)
  })

  it('SCALES the preserved estimate when the quantity changes — 1 count -> 10 count', async () => {
    // An estimate is a pure function of the quantity (`quantity * per-unit factor`), so holding it
    // fixed while the quantity moves understates the row 10x — and since V4-HARVWEIGHTREAD-001 that
    // number is summed into the Harvests / PlantingDetail totals on screen. Mutation: drop the
    // ratio and this reds at 7.20.
    const id = await seedUnpriceableWeight({ quantity: 1 })
    const res = await put(id, {
      event_type: 'harvest', event_date: new Date().toISOString(),
      harvest: { quantity: 10, unit: 'count', quality_rating: 3 },
    })
    expect(res.status).toBe(200)
    const row = await harvestRow(id)
    expect(Number(row.weight_grams)).toBeCloseTo(72.0, 2)   // 7.20 g/count * 10
    expect(row.weight_estimated).toBe(true)                  // still an estimate, same provenance
    expect(row.weight_basis).toBe('cultivar')
  })

  it('scaling is exact in both directions — 4 count -> 1 count divides back down', async () => {
    // The ratio must not be one-way. Mutation: clamp it to >= 1 and this reds at 7.20.
    const id = await seedUnpriceableWeight({ quantity: 4 })   // 7.20 g total, i.e. 1.80 g/count
    const res = await put(id, {
      event_type: 'harvest', event_date: new Date().toISOString(),
      harvest: { quantity: 1, unit: 'count', quality_rating: 3 },
    })
    expect(res.status).toBe(200)
    expect(Number((await harvestRow(id)).weight_grams)).toBeCloseTo(1.80, 2)
  })

  it('an unchanged quantity is byte-identical — ratio 1, the fe75398 contract intact', async () => {
    // Guards the scaling against drifting the quality-star case it must leave alone.
    const id = await seedUnpriceableWeight({ quantity: 3 })
    const res = await put(id, {
      event_type: 'harvest', event_date: new Date().toISOString(),
      harvest: { quantity: 3, unit: 'count', quality_rating: 5 },
    })
    expect(res.status).toBe(200)
    const [row] = await directSql`SELECT weight_grams::text AS g FROM harvest_log
                                    WHERE event_id = ${id} AND deleted_at IS NULL`
    expect(Number(row.g)).toBe(7.2)
  })

  it('a USER-TYPED weight is NOT scaled — a weighing is an independent fact', async () => {
    // The asymmetry that makes the scaling defensible. The user put 4 picks on a scale and it read
    // 250 g; correcting the COUNT to 8 must not claim the scale said 500. This row never reaches the
    // preserve branch at all — the carry-forward feeds it back as p_user_grams — and this test is
    // what stops a later "simplify" from folding the two paths together.
    const res0 = await callHandler(handler, {
      method: 'POST', path: '/api/events', userId: USER,
      body: { project_id: hProjectId, event_type: 'harvest', event_date: new Date().toISOString(),
              harvest: { quantity: 4, unit: 'count', quality_rating: 3, weight: 250, weight_unit: 'g' } },
    })
    expect(res0.status, JSON.stringify(res0.body)).toBe(201)
    const id = res0.body.id ?? res0.body.eventId
    const res = await put(id, {
      event_type: 'harvest', event_date: new Date().toISOString(),
      harvest: { quantity: 8, unit: 'count', quality_rating: 3 },
    })
    expect(res.status).toBe(200)
    const row = await harvestRow(id)
    expect(Number(row.weight_grams)).toBeCloseTo(250, 2)
    expect(row.weight_basis).toBe('measured')
  })

  it('a zero stored quantity cannot 23514 the save — it keeps its weight instead of dividing by zero', async () => {
    // quantity carries no positivity CHECK, so 0 is storable. A bare ratio would NULL weight_grams
    // while weight_basis stayed 'cultivar', which is a hard 23514 on
    // chk_harvest_log_weight_basis_pairing — a 500 on the save path, the 2026-08-03 outage class.
    // Mutation: drop the COALESCE(..., 1) and this 500s.
    const id = await makeHarvest({ quantity: 5, unit: 'count' })
    await directSql`UPDATE harvest_log SET quantity = 0, weight_grams = 7.20, weight_estimated = true,
                      weight_basis = 'cultivar' WHERE event_id = ${id} AND deleted_at IS NULL`
    const res = await put(id, {
      event_type: 'harvest', event_date: new Date().toISOString(),
      harvest: { quantity: 6, unit: 'count', quality_rating: 3 },
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const row = await harvestRow(id)
    expect(Number(row.weight_grams)).toBeCloseTo(7.20, 2)
    expect(row.weight_basis).toBe('cultivar')
  })

  it('an EXPLICIT weight:null still clears an unpriceable stored weight', async () => {
    // The guard protects against INCIDENTAL blanking, never against the user removing their own
    // number. Mutation: drop `NOT ${hClearWeight}` from the CASE and the weight becomes unremovable.
    const id = await seedUnpriceableWeight()
    const res = await put(id, {
      event_type: 'harvest', event_date: new Date().toISOString(),
      harvest: { quantity: 1, unit: 'count', quality_rating: 3, weight: null },
    })
    expect(res.status).toBe(200)
    const row = await harvestRow(id)
    expect(row.weight_grams).toBeNull()
    expect(row.weight_estimated).toBeNull()
    expect(row.weight_basis).toBeNull()
  })

  it('preserves quality_rating when the client omits it from the sub-object as null', async () => {
    // BD-006 hides Quality from the form, so the edit form does not offer it. It must not be
    // silently destroyed by every save — the client re-sends the seeded value.
    const id = await makeHarvest({ quantity: 5, unit: 'count' })
    await put(id, {
      event_type: 'harvest', event_date: new Date().toISOString(),
      harvest: { quantity: 6, unit: 'count', quality_rating: 4 },
    })
    expect((await harvestRow(id)).quality_rating).toBe(4)
  })

  it('edits a NON-harvest event and leaves harvest_log entirely alone', async () => {
    // The absent-`harvest` path: every existing caller sends no harvest key, and that must remain
    // behaviourally identical to a plain event_log update.
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/events', userId: USER,
      body: { project_id: hProjectId, event_type: 'observation', event_date: new Date().toISOString(), notes: 'before' },
    })
    const id = created.body.id ?? created.body.eventId
    const res = await put(id, {
      event_type: 'observation', event_date: new Date().toISOString(), notes: 'after', quantity: '6 plants',
    })
    expect(res.status).toBe(200)
    expect(res.body.notes).toBe('after')
    expect(res.body.harvest).toBeNull()
    const [row] = await directSql`SELECT notes, quantity FROM event_log WHERE id = ${id}`
    expect(row.notes).toBe('after')
    expect(row.quantity).toBe('6 plants')
  })

  it('refuses to change a harvest event to another type while harvest details exist', async () => {
    // Explicit 400 rather than silently orphaning a harvest_log row, which would vanish from the
    // totals with no record of why. Mutation: drop the pairing guard and the row is orphaned.
    const id = await makeHarvest()
    const res = await put(id, { event_type: 'observation', event_date: new Date().toISOString() })
    expect(res.status).toBe(400)
    expect(await harvestRow(id)).toBeTruthy()
    const [row] = await directSql`SELECT event_type FROM event_log WHERE id = ${id}`
    expect(row.event_type).toBe('harvest')
  })

  it('refuses to convert a plain event INTO a harvest', async () => {
    // The other direction: there is no harvest_log row to update, and inventing one here would
    // duplicate the create path's CTE badly.
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/events', userId: USER,
      body: { project_id: hProjectId, event_type: 'observation', event_date: new Date().toISOString() },
    })
    const id = created.body.id ?? created.body.eventId
    const res = await put(id, {
      event_type: 'harvest', event_date: new Date().toISOString(),
      harvest: { quantity: 2, unit: 'count', quality_rating: null },
    })
    expect(res.status).toBe(400)
  })

  it('rejects an implausible quantity with the SAME rule the create path uses', async () => {
    // validateHarvestFields is shared between create and edit precisely so they cannot drift.
    const id = await makeHarvest()
    const res = await put(id, {
      event_type: 'harvest', event_date: new Date().toISOString(),
      harvest: { quantity: 99999, unit: 'lb', quality_rating: null },
    })
    expect(res.status).toBe(400)
    expect(Number((await harvestRow(id)).quantity)).toBe(5)
  })

  it("refuses another household's event with a 404, no existence oracle", async () => {
    const res = await put(foreignEventId, { event_type: 'observation', event_date: new Date().toISOString() })
    expect(res.status).toBe(404)
    const [row] = await directSql`SELECT event_type FROM event_log WHERE id = ${foreignEventId}`
    expect(row.event_type).toBe('observation')
  })

  it('GET returns the harvest row so the edit form can seed itself', async () => {
    // Without this the client cannot render the real amount at all — it only ever saw
    // event_log.quantity, a different field entirely.
    const id = await makeHarvest({ quantity: 7, unit: 'cup' })
    const res = await callHandler(handler, { method: 'GET', path: `/api/events/${id}`, userId: USER })
    expect(res.status).toBe(200)
    expect(res.body.harvest).toBeTruthy()
    expect(Number(res.body.harvest.quantity)).toBe(7)
    expect(res.body.harvest.unit).toBe('cup')
  })

  it('GET on a non-harvest event returns harvest null, not an error', async () => {
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/events', userId: USER,
      body: { project_id: hProjectId, event_type: 'observation', event_date: new Date().toISOString() },
    })
    const id = created.body.id ?? created.body.eventId
    const res = await callHandler(handler, { method: 'GET', path: `/api/events/${id}`, userId: USER })
    expect(res.status).toBe(200)
    expect(res.body.harvest).toBeNull()
  })
})

describe('POST /api/events — validation + create', () => {
  it('YYYY-MM-DD bare date → 201, stored at noon UTC (normalizeEventDate verified)', async () => {
    setTestUserId(USER)
    const bareDate = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10)
    const expected = bareDate + 'T12:00:00.000Z'
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: { project_id: projectId, event_type: 'observation', event_date: bareDate, notes: 'int-noon-anchor' },
    })
    expect(status).toBe(201) // handler line: return resp(201, {...newEvent, ...})
    expect(body.id).toBeTruthy()
    expect(body.event_type).toBe('observation')
    expect(body.project_id).toBe(projectId)
    const rows = await directSql`SELECT event_date FROM event_log WHERE id = ${body.id}`
    expect(rows).toHaveLength(1)
    expect(new Date(rows[0].event_date).toISOString()).toBe(expected)
  })

  it('full ISO datetime passes through unchanged (no noon-anchor rewrite)', async () => {
    setTestUserId(USER)
    const iso = '2026-04-15T14:30:00.000Z'
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: { project_id: projectId, event_type: 'watering', event_date: iso },
    })
    expect(status).toBe(201)
    const rows = await directSql`SELECT event_date FROM event_log WHERE id = ${body.id}`
    expect(new Date(rows[0].event_date).toISOString()).toBe(iso)
  })

  it('missing event_type → 400', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: { project_id: projectId },
    })
    expect(status).toBe(400) // validators.js: 'event_type is required'
    expect(body.error).toMatch(/event_type/i)
  })

  it('missing both project_id and plant_id → 400', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: { event_type: 'observation' },
    })
    // BUG-CAPTUREFLOW400-001: project_id alone is no longer required — plant_id satisfies it too.
    expect(status).toBe(400) // validators.js: 'project_id or plant_id is required'
    expect(body.error).toMatch(/project_id/i)
  })

  it('flagged_as_issue=true + severity=2 → 201, severity stored', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: {
        project_id: projectId, event_type: 'observation',
        flagged_as_issue: true, severity: 2, notes: 'flagged-with-severity',
      },
    })
    expect(status).toBe(201)
    expect(body.flagged_as_issue).toBe(true)
    expect(body.severity).toBe(2)
    const rows = await directSql`SELECT flagged_as_issue, severity FROM event_log WHERE id = ${body.id}`
    expect(rows[0].flagged_as_issue).toBe(true)
    expect(rows[0].severity).toBe(2)
  })

  it('flagged_as_issue=true + severity=null → 400 (F5: severity required when flagged)', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: { project_id: projectId, event_type: 'observation', flagged_as_issue: true },
    })
    expect(status).toBe(400) // validators.js F5
    expect(body.error).toMatch(/severity required when flagged_as_issue/i)
  })

  it('severity=2 without flagged_as_issue → 400 (validator gate — L-091 correction)', async () => {
    // This is the assertion the Phase-2 design doc had backwards: the design doc said
    // severity without flag silently nulls + returns success. Validator catches it at
    // 400 BEFORE the handler's `const severity = flagged ? body.severity : null` line.
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: { project_id: projectId, event_type: 'observation', severity: 2 },
    })
    expect(status).toBe(400) // validators.js: 'severity requires flagged_as_issue=true'
    expect(body.error).toMatch(/severity requires flagged_as_issue/i)
  })

  it('severity=99 (out of range) → 400 (F6: shape check first)', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: { project_id: projectId, event_type: 'observation', flagged_as_issue: true, severity: 99 },
    })
    expect(status).toBe(400) // validators.js F6
    expect(body.error).toMatch(/severity must be 1, 2, or 3/i)
  })

  it('event_type=harvest without harvest object → 400', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: { project_id: projectId, event_type: 'harvest' },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/harvest fields required/i)
  })

  it('non-harvest event with harvest object → 400 (cross-field guard)', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: {
        project_id: projectId, event_type: 'observation',
        harvest: { quantity: 1, unit: 'lb' },
      },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/harvest fields only valid on event_type=harvest/i)
  })
})

describe('GET /api/events — list (collection)', () => {
  it('returns ARRAY shape (not {events:[...]}), scoped to caller', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'GET', path: '/api/events',
    })
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true) // handler: return resp(200, rows) — rows is direct array
    // Every returned row must belong to our test project (single-user scope, no household env).
    for (const row of body) {
      expect(row.project_id).toBe(projectId)
    }
    // Foreign event must NOT appear (it belongs to foreignProjectId / FOREIGN_USER).
    const ids = body.map((r) => r.id)
    expect(ids).not.toContain(foreignEventId)
  })

  it('?project_id= filters list to that project', async () => {
    setTestUserId(USER)
    const { status, body } = await callHandler(handler, {
      method: 'GET', path: '/api/events',
    })
    expect(status).toBe(200)
    // We expect the same rows because USER only has events under projectId; smoke-check the filter exists.
    const all = body
    // Simulate a filter request: handler reads event.queryStringParameters?.project_id.
    const filtered = await handler({
      requestContext: { http: { method: 'GET' } },
      rawPath: '/api/events',
      headers: { authorization: 'Bearer stub' },
      queryStringParameters: { project_id: projectId },
    })
    expect(filtered.statusCode).toBe(200)
    const filteredRows = JSON.parse(filtered.body)
    expect(Array.isArray(filteredRows)).toBe(true)
    for (const row of filteredRows) expect(row.project_id).toBe(projectId)
    // Length should match (we only have rows under this project).
    expect(filteredRows.length).toBe(all.length)
  })

  it('soft-deleted rows excluded from list', async () => {
    setTestUserId(USER)
    // Create a fresh row, soft-delete it via directSql, confirm it's NOT in the GET list.
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: { project_id: projectId, event_type: 'observation', notes: 'will-be-soft-deleted' },
    })
    expect(created.status).toBe(201)
    const id = created.body.id
    await directSql`UPDATE event_log SET deleted_at = NOW() WHERE id = ${id}`
    const { body: listBody } = await callHandler(handler, { method: 'GET', path: '/api/events' })
    const ids = listBody.map((r) => r.id)
    expect(ids).not.toContain(id) // handler WHERE clause: e.deleted_at IS NULL
  })
})

describe('GET /api/events/:id — single', () => {
  it('non-UUID id → 404 (F9 UUID pre-validation, existence-oblivious)', async () => {
    setTestUserId(USER)
    const { status } = await callHandler(handler, {
      method: 'GET', path: '/api/events/not-a-uuid',
    })
    expect(status).toBe(404)
  })

  it('valid-format UUID for foreign-owner event → 404 (scope filter)', async () => {
    setTestUserId(USER) // calling as own USER, asking for FOREIGN_USER's event
    const { status } = await callHandler(handler, {
      method: 'GET', path: `/api/events/${foreignEventId}`,
    })
    expect(status).toBe(404)
  })

  it('own event → 200 with row shape', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: { project_id: projectId, event_type: 'pruning', notes: 'single-get-target' },
    })
    expect(created.status).toBe(201)
    const id = created.body.id
    const { status, body } = await callHandler(handler, {
      method: 'GET', path: `/api/events/${id}`,
    })
    expect(status).toBe(200)
    // Handler returns rows[0] directly (object), not {event: ...}
    expect(body.id).toBe(id)
    expect(body.event_type).toBe('pruning')
    expect(body.project_id).toBe(projectId)
    expect(body).toHaveProperty('project_name') // joined column
  })
})

describe('PATCH /api/events/:id — issue resolve', () => {
  it('non-UUID id → 404', async () => {
    setTestUserId(USER)
    const { status } = await callHandler(handler, {
      method: 'PATCH', path: '/api/events/not-a-uuid',
      body: { resolved: true },
    })
    expect(status).toBe(404)
  })

  it('body resolved!=true → 400', async () => {
    setTestUserId(USER)
    // Need a UUID to get past F9; use a random one — the validator fires before the UPDATE.
    const fakeUuid = '00000000-0000-4000-8000-000000000000'
    const { status, body } = await callHandler(handler, {
      method: 'PATCH', path: `/api/events/${fakeUuid}`,
      body: { resolved: false },
    })
    expect(status).toBe(400)
    expect(body.error).toMatch(/resolved must be true/i)
  })

  it('non-flagged event PATCH → 404 (UPDATE matches zero rows: flagged_as_issue=true gate)', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: { project_id: projectId, event_type: 'observation', notes: 'unflagged-no-resolve' },
    })
    expect(created.status).toBe(201)
    const id = created.body.id
    const { status } = await callHandler(handler, {
      method: 'PATCH', path: `/api/events/${id}`,
      body: { resolved: true },
    })
    expect(status).toBe(404) // RETURNING from UPDATE WHERE flagged_as_issue=true returns empty
  })

  it('flagged event PATCH → 200; resolved_at and resolved_by populated', async () => {
    setTestUserId(USER)
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: {
        project_id: projectId, event_type: 'observation',
        flagged_as_issue: true, severity: 1, notes: 'flagged-to-resolve',
      },
    })
    expect(created.status).toBe(201)
    const id = created.body.id
    const { status, body } = await callHandler(handler, {
      method: 'PATCH', path: `/api/events/${id}`,
      body: { resolved: true },
    })
    expect(status).toBe(200)
    expect(body.id).toBe(id)
    expect(body.flagged_as_issue).toBe(true)
    expect(body.severity).toBe(1)
    expect(body.resolved_at).toBeTruthy()
    expect(body.resolved_by).toBe(USER)
    // Read-back: DB row matches.
    const rows = await directSql`SELECT resolved_at, resolved_by FROM event_log WHERE id = ${id}`
    expect(rows[0].resolved_at).toBeTruthy()
    expect(rows[0].resolved_by).toBe(USER)
  })
})

// DRG-CARESTATUS-002 — rain events must advance entity_memory water memory the same
// as watering, so the dashboard water_due / bottom Alert bar drops the plant same-day.
// Split-path regression: daily-plan-read honored 'rain' (v2.8.0 DONE_EVENTS) but the
// entity_memory upsert in lambda/events/index.js only fired on 'watering'. Falsifiable:
// before the fix a rain POST left next_water_at NULL (water_due kept showing the plant).
describe('POST /api/events — rain advances water memory (Alert-bar split-path fix)', () => {
  it('rain event sets last_watered_at + future next_water_at (watering parity)', async () => {
    await directSql`DELETE FROM event_log WHERE project_id = ${projectId}`
    await directSql`DELETE FROM entity_memory WHERE project_id = ${projectId}`
    const when = new Date().toISOString()
    const { status } = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: { project_id: projectId, event_type: 'rain', event_date: when },
    })
    expect(status).toBe(201)
    const em = await directSql`
      SELECT last_watered_at, next_water_at FROM entity_memory WHERE project_id = ${projectId}
    `
    expect(em.length).toBe(1)
    expect(em[0].last_watered_at).toBeTruthy()
    // next_water_at = event_date + watering interval (>= +1 day) → strictly after the rain time.
    expect(em[0].next_water_at).toBeTruthy()
    expect(new Date(em[0].next_water_at).getTime()).toBeGreaterThan(new Date(when).getTime())
  })

  it('undoing the only rain event clears water memory (undo guard fires for rain)', async () => {
    await directSql`DELETE FROM event_log WHERE project_id = ${projectId}`
    await directSql`DELETE FROM entity_memory WHERE project_id = ${projectId}`
    const created = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: { project_id: projectId, event_type: 'rain', event_date: new Date().toISOString() },
    })
    expect(created.status).toBe(201)
    const id = created.body.id
    const before = await directSql`SELECT next_water_at FROM entity_memory WHERE project_id = ${projectId}`
    expect(before[0].next_water_at).toBeTruthy()
    const undo = await callHandler(handler, { method: 'DELETE', path: `/api/events/${id}` })
    expect(undo.status).toBe(200)
    const after = await directSql`
      SELECT last_watered_at, next_water_at FROM entity_memory WHERE project_id = ${projectId}
    `
    // No surviving watering/rain events → memory recomputed to NULL.
    expect(after[0].last_watered_at).toBeNull()
    expect(after[0].next_water_at).toBeNull()
  })
})

// CAL-2 — logging a `germination` event stamps the planting's germinated_at (event date),
// the FIRST time only, mirroring the shipped flowering/fruit_set status-advance UPDATEs.
// First integration coverage of an event-driven lifecycle-date write. germinated_at_approx=false
// (a real captured date). Ownership scoped via container.created_by = ANY(householdIds); with
// GARDEN_HOUSEHOLD_IDS unset in test, householdScope fails closed to [USER] (household.js:16).
describe('POST /api/events — germination stamps germinated_at, set-once (CAL-2)', () => {
  let plantingId
  let foreignPlantingId

  beforeAll(async () => {
    const p = await directSql`
      INSERT INTO plants (project_id, name, created_by)
      VALUES (${projectId}, ${'germ-' + RUN}, ${USER}) RETURNING id
    `
    plantingId = p[0].id
    const fp = await directSql`
      INSERT INTO plants (project_id, name, created_by)
      VALUES (${foreignProjectId}, ${'germ-foreign-' + RUN}, ${FOREIGN_USER}) RETURNING id
    `
    foreignPlantingId = fp[0].id
  })

  it('germination on own planting → germinated_at = event date, germinated_at_approx=false', async () => {
    setTestUserId(USER)
    const bareDate = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString().slice(0, 10)
    const { status } = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: { project_id: projectId, plant_id: plantingId, event_type: 'germination', event_date: bareDate },
    })
    expect(status).toBe(201)
    const rows = await directSql`SELECT germinated_at, germinated_at_approx FROM plants WHERE id = ${plantingId}`
    expect(rows[0].germinated_at).toBeTruthy()
    // Date-component assert (robust whether germinated_at is date or timestamptz — column type
    // is a manual ALTER not in repo migrations, L-085).
    expect(new Date(rows[0].germinated_at).toISOString().slice(0, 10)).toBe(bareDate)
    expect(rows[0].germinated_at_approx).toBe(false)
  })

  it('a second germination with a later date does NOT overwrite (set-once via germinated_at IS NULL)', async () => {
    setTestUserId(USER)
    const before = await directSql`SELECT germinated_at FROM plants WHERE id = ${plantingId}`
    const firstStamp = new Date(before[0].germinated_at).toISOString()
    const laterDate = new Date().toISOString().slice(0, 10)
    const { status } = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: { project_id: projectId, plant_id: plantingId, event_type: 'germination', event_date: laterDate },
    })
    expect(status).toBe(201) // the event row is still created; only the date-stamp is guarded
    const after = await directSql`SELECT germinated_at FROM plants WHERE id = ${plantingId}`
    expect(new Date(after[0].germinated_at).toISOString()).toBe(firstStamp)
  })

  it('project-level germination (no plant_id) advances no planting', async () => {
    setTestUserId(USER)
    const fresh = await directSql`
      INSERT INTO plants (project_id, name, created_by)
      VALUES (${projectId}, ${'germ-noplant-' + RUN}, ${USER}) RETURNING id
    `
    const { status } = await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: { project_id: projectId, event_type: 'germination', event_date: new Date().toISOString().slice(0, 10) },
    })
    expect(status).toBe(201)
    const rows = await directSql`SELECT germinated_at FROM plants WHERE id = ${fresh[0].id}`
    expect(rows[0].germinated_at).toBeNull() // p.id = null matches nothing
  })

  it('germination targeting a FOREIGN-owned planting leaves it NULL (household scope, L-087)', async () => {
    setTestUserId(USER)
    // As USER against FOREIGN_USER's planting. Whether the create handler accepts or rejects the
    // foreign plant_id, the UPDATE's pp.created_by = ANY(householdIds) guard (householdIds=[USER])
    // must leave the foreign planting's germinated_at NULL. Defense-in-depth invariant.
    await callHandler(handler, {
      method: 'POST', path: '/api/events',
      body: { project_id: foreignProjectId, plant_id: foreignPlantingId, event_type: 'germination', event_date: new Date().toISOString().slice(0, 10) },
    })
    const rows = await directSql`SELECT germinated_at FROM plants WHERE id = ${foreignPlantingId}`
    expect(rows[0].germinated_at).toBeNull()
  })
})
