// tests/integration/batch-photo-reparent.int.test.js — W-BATCHNULL.
//
// WHAT THIS FILE IS ACTUALLY FOR. It was commissioned to prove a bug. It proves the bug does not
// exist, and then pins the thing that prevents it so nobody has to re-derive this a third time.
//
// THE CLAIM UNDER TEST (photo-removal-plan-V100 §W-BATCHNULL, restated by lane photodelete §7):
// the undo paths null photos.event_id and re-parent with a bare COALESCE from the event, so a
// batched event with project_id AND plant_id both NULL, whose photo's only parent is event_id,
// re-parents to all-NULL, violates photos_must_have_parent (23514), aborts the whole
// sql.transaction, and — because event_batches.undone_at stays NULL — strands the batch
// permanently un-undoable.
//
// WHY IT CANNOT HAPPEN. Every step of that chain is real except its first premise. An event_log row
// with both anchors NULL cannot be stored: `CHECK event_log_has_anchor (plant_id IS NOT NULL OR
// project_id IS NOT NULL)`. It is marked NOT VALID, which skips the initial table scan ONLY — it is
// fully enforced on INSERT and UPDATE. So at least one of e.project_id / e.plant_id is always
// non-NULL, the COALESCEs propagate it onto the photo, and the photo always lands parented. The
// guard is one join away from the statement, in a different table, which is exactly why three
// separate documents missed it.
//
// The fallback arm shipped anyway (intake_status -> 'pending_tag' when every parent would be NULL),
// as defence-in-depth: event_log_has_anchor is still NOT VALID and v4-evtanchordel-001 is actively
// reshaping event anchoring. Tests 1-2 below are what make that arm honest — if the anchor CHECK is
// ever dropped or relaxed, they go red and tell the reader that W-BATCHNULL just became live.
//
// TEST TIERS, deliberately. The events unit suite is static-source (undo-cascade.test.js reads
// index.js and regexes SQL text) and cannot execute a statement, produce a 23514, or prove any row
// changed. Everything below runs the REAL handler against real Postgres and asserts by read-back.
// The static guards in undo-cascade.test.js are wiring guards only; these are the behaviour.
//
// SECOND PURPOSE, and the one with live blast radius: the fallback added a CASE over intake_status
// to the statement that detaches photos on EVERY event undo — 11,557 live batched events exercise
// this path. A CASE that misfires would silently dump parented photos into the quick-tag inbox, or
// clobber an 'upload_failed' marker. Tests 5-7 are the negative assertions that pin the ELSE arm.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId, insertProject } from './_harness.js'
import { handler } from '../../lambda/events/index.js'

const RUN = testRunId()
const USER = `user_int_batchnull_${RUN}`

let projectId
let plantId

async function newEvent({ project = null, plant = null, batchId = null, type = 'observation' }) {
  const meta = batchId ? JSON.stringify({ batch_id: batchId, batch_v: 1 }) : null
  const rows = await directSql`
    INSERT INTO event_log (project_id, plant_id, event_type, event_date, is_public,
                           logged_by, created_by, metadata)
    VALUES (${project}, ${plant}, ${type}, NOW(), true, ${USER}, ${USER}, ${meta}::jsonb)
    RETURNING id`
  return rows[0].id
}

// A photo whose ONLY parent is the event — the shape the whole ticket is about.
async function newEventOnlyPhoto(eventId, intakeStatus = null) {
  const rows = await directSql`
    INSERT INTO photos (event_id, storage_path, created_by, intake_status)
    VALUES (${eventId}, ${`int/batchnull/${RUN}/${Math.random().toString(36).slice(2)}.jpg`},
            ${USER}, ${intakeStatus})
    RETURNING id`
  return rows[0].id
}

async function newBatch() {
  const rows = await directSql`
    INSERT INTO event_batches (idempotency_key, created_by, event_type, scope_json, event_date,
                               item_count, status)
    VALUES (${`batchnull-${RUN}-${Math.random().toString(36).slice(2)}`}, ${USER}, 'observation',
            ${JSON.stringify({ type: 'project' })}::jsonb, NOW()::date, 1, 'complete')
    RETURNING id`
  return rows[0].id
}

const photo = async (id) => (await directSql`
  SELECT event_id, project_id, plant_id, location_id, inventory_item_id, space_id,
         intake_status, deleted_at
    FROM photos WHERE id = ${id}`)[0]

const hasAnyParent = (p) =>
  p.project_id != null || p.plant_id != null || p.location_id != null ||
  p.inventory_item_id != null || p.space_id != null || p.event_id != null ||
  p.intake_status === 'pending_tag'

beforeAll(async () => {
  setTestUserId(USER)
  projectId = (await insertProject({ name: `int-batchnull-${RUN}`, createdBy: USER })).id
  const pl = await directSql`
    INSERT INTO plants (project_id, name, created_by)
    VALUES (${projectId}, ${`int-batchnull-plant-${RUN}`}, ${USER}) RETURNING id`
  plantId = pl[0].id
})

afterAll(async () => {
  await directSql`DELETE FROM photos WHERE created_by = ${USER}`
  await directSql`DELETE FROM event_log WHERE created_by = ${USER}`
  await directSql`DELETE FROM event_batches WHERE created_by = ${USER}`
  await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id IN (
                    SELECT id FROM plants WHERE created_by = ${USER})`
  await directSql`DELETE FROM entity_memory WHERE plant_id IN (
                    SELECT id FROM plants WHERE created_by = ${USER})`
  await directSql`DELETE FROM plants WHERE created_by = ${USER}`
  await directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`
})

// ─── 1-2: the guard that makes W-BATCHNULL unreachable. Red here == the ticket is live again. ────
describe('W-BATCHNULL — the premise, tested rather than believed', () => {
  it('event_log_has_anchor still exists on event_log, covering BOTH anchor columns', async () => {
    const [row] = await directSql`
      SELECT pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = 'event_log' AND t.relkind = 'r'
         AND c.conname = 'event_log_has_anchor' AND c.contype = 'c'`
    // Not merely "a constraint by that name exists" — the DEFINITION must still name both arms.
    // Relaxing it to a single arm, or to a weaker predicate, is precisely the change that would
    // make the fallback in lambda/events/index.js load-bearing.
    expect(row?.def).toBeTruthy()
    expect(row.def).toMatch(/plant_id IS NOT NULL/)
    expect(row.def).toMatch(/project_id IS NOT NULL/)
  })

  it('refuses to store a both-anchors-NULL event — executed, not read from the catalogue', async () => {
    // NOT VALID does not mean unenforced. This is the assertion that proves it, by attempting the
    // exact row the ticket's failure mode requires and watching Postgres reject it.
    let code = null
    let msg = ''
    try {
      await directSql`
        INSERT INTO event_log (project_id, plant_id, event_type, event_date, is_public,
                               logged_by, created_by)
        VALUES (NULL, NULL, 'observation', NOW(), true, ${USER}, ${USER})`
    } catch (e) {
      code = e.code ?? e.sourceError?.code ?? null
      msg = `${e.message} ${e.constraint ?? ''} ${e.sourceError?.constraint ?? ''}`
    }
    expect(code).toBe('23514')
    expect(msg).toMatch(/event_log_has_anchor/)
  })
})

// ─── 3-4: the two undo paths, driven end to end, over every shape the anchor CHECK admits. ───────
describe('W-BATCHNULL — batch undo detaches photos without ever orphaning one', () => {
  // The plan's own AC1, adjusted to a batch the database can actually hold: the transaction must
  // COMMIT, the photo must survive, and the rest of the batch must apply. Pre-fix this passed too —
  // stated plainly because it is the evidence that the ticket was not a live bug.
  it.each([
    ['project-anchored (the 11,557-row prod shape)', true, false],
    ['plant-anchored, project_id NULL (the project-less planting)', false, true],
    ['both anchors', true, true],
  ])('commits and keeps the photo parented — %s', async (_label, withProject, withPlant) => {
    const batchId = await newBatch()
    const eventId = await newEvent({
      project: withProject ? projectId : null,
      plant: withPlant ? plantId : null,
      batchId,
    })
    const photoId = await newEventOnlyPhoto(eventId)

    const res = await callHandler(handler, { method: 'DELETE', path: `/api/events/batch/${batchId}` })
    expect(res.status).toBe(200)

    const p = await photo(photoId)
    expect(p.deleted_at).toBeNull()          // Soft-Delete-Only: an undo never deletes a photo.
    expect(p.event_id).toBeNull()            // detached from the dead parent
    expect(hasAnyParent(p)).toBe(true)       // photos_must_have_parent, asserted as state
    // The event really was undone — otherwise "photo survived" would be vacuously true.
    const [ev] = await directSql`SELECT deleted_at FROM event_log WHERE id = ${eventId}`
    expect(ev.deleted_at).not.toBeNull()
  })
})

describe('W-BATCHNULL — single-event undo, same statement, same guarantee', () => {
  it('detaches and re-parents a project-anchored event’s photo', async () => {
    const eventId = await newEvent({ project: projectId, plant: plantId })
    const photoId = await newEventOnlyPhoto(eventId)

    const res = await callHandler(handler, { method: 'DELETE', path: `/api/events/${eventId}` })
    expect(res.status).toBe(200)

    const p = await photo(photoId)
    expect(p.deleted_at).toBeNull()
    expect(p.event_id).toBeNull()
    expect(p.project_id).toBe(projectId)
    expect(hasAnyParent(p)).toBe(true)
  })

  it('404s a project-less event BEFORE any write — the ownership JOIN, measured not assumed', async () => {
    // lane photodelete read `:1790`'s `JOIN container` correctly as an OWNERSHIP pre-read, then
    // concluded the single path was therefore exposed. Both halves are tested here: the JOIN is not
    // a parent-null guard by intent, but its null-exclusion is real, and it fires first — so
    // e.project_id can never be NULL by the time the photo statement runs. The event and its photo
    // must be COMPLETELY untouched, which is what makes this an ordering assertion and not just a
    // status-code assertion.
    const eventId = await newEvent({ project: null, plant: plantId })
    const photoId = await newEventOnlyPhoto(eventId)

    const res = await callHandler(handler, { method: 'DELETE', path: `/api/events/${eventId}` })
    expect(res.status).toBe(404)

    const [ev] = await directSql`SELECT deleted_at FROM event_log WHERE id = ${eventId}`
    expect(ev.deleted_at).toBeNull()
    const p = await photo(photoId)
    expect(p.event_id).toBe(eventId)
  })
})

// ─── 5-7: the NEGATIVE assertions. These cover the risk the FIX introduces, not the ticket. ──────
describe('W-BATCHNULL — the intake_status CASE must not misfire', () => {
  it('leaves intake_status NULL on a photo that re-parents normally', async () => {
    // The whole live blast radius of this change in one assertion: if the CASE's WHEN is ever
    // loosened (an OR where an AND belongs, a dropped conjunct), every photo detached by every undo
    // lands in the quick-tag inbox. 11,557 batched events feed this path.
    const eventId = await newEvent({ project: projectId, plant: plantId })
    const photoId = await newEventOnlyPhoto(eventId)

    await callHandler(handler, { method: 'DELETE', path: `/api/events/${eventId}` })

    const p = await photo(photoId)
    expect(p.intake_status).toBeNull()
    expect(p.project_id).toBe(projectId)
  })

  it('preserves an existing upload_failed marker through an undo (the ELSE arm)', async () => {
    // photos_intake_status_valid admits only 'pending_tag' and 'upload_failed'. The ELSE arm writes
    // ph.intake_status back to itself; a mutation to ELSE NULL would silently erase upload_failed
    // on every detach and pass every positive test above.
    const eventId = await newEvent({ project: projectId, plant: plantId })
    const photoId = await newEventOnlyPhoto(eventId, 'upload_failed')

    await callHandler(handler, { method: 'DELETE', path: `/api/events/${eventId}` })

    expect((await photo(photoId)).intake_status).toBe('upload_failed')
  })

  it('leaves a photo with its OWN parents alone, taking nothing from the event', async () => {
    // COALESCE precedence: an existing parent always wins. Guards the arms being swapped so the
    // event's anchors overwrite the photo's own.
    const otherProject = (await insertProject({ name: `int-batchnull-other-${RUN}`, createdBy: USER })).id
    const eventId = await newEvent({ project: projectId, plant: plantId })
    const rows = await directSql`
      INSERT INTO photos (event_id, project_id, storage_path, created_by)
      VALUES (${eventId}, ${otherProject}, ${`int/batchnull/${RUN}/own-parent.jpg`}, ${USER})
      RETURNING id`
    const photoId = rows[0].id

    await callHandler(handler, { method: 'DELETE', path: `/api/events/${eventId}` })

    const p = await photo(photoId)
    expect(p.project_id).toBe(otherProject)   // NOT projectId — the photo's own parent survived
    expect(p.intake_status).toBeNull()
    expect(p.event_id).toBeNull()
  })
})
