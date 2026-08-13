// tests/integration/archive-preservation-guard.int.test.js
// BUG-ARCHPRESERVGUARD-001 — the archive routines guard calibration evidence and photos, but not
// preservation provenance. Audit finding I7.
//
// THE DEFECT. archive_plant_events() and archive_container_events() both DELETE harvest_log rows as
// a deliberate step (moving them to harvest_log_archive). preservation_log.harvest_log_id is
// ON DELETE SET NULL, so that delete silently stripped the provenance from every put-up made from
// those harvests: the jar stayed, its source vanished. Both routines already refused to touch the
// other two evidence classes — cultivar_weight_sample and photos — each with a NAMED error raised
// BEFORE any write. Preservation records are the same kind of thing and had no guard at all.
//
// SCOPE NOTE, and it is the interesting part of this ticket. An earlier draft ALSO flipped
// preservation_log.harvest_log_id / .plant_id from SET NULL to RESTRICT as a backstop. v4-putup-001's
// gates caught that, and reading it showed the SET NULL was a STATED design choice, not an oversight:
//     plant_id       ... ON DELETE SET NULL,  -- planting deleted -> keep put-up history
//     harvest_log_id ... ON DELETE SET NULL,  -- OPTIONAL provenance (L8)
// A jar of pickles outlives its planting record, and a NULL provenance link is a legitimate state
// there. So the FK question is a product decision (filed as V4-PRESERVFKACTION-001) and this
// migration closes exactly what the audit filed: the ROUTINES' guard list. These tests therefore
// assert the FK is STILL SET NULL, deliberately.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, testRunId, insertProject } from './_harness.js'

const RUN = testRunId()
const USER = `archpreserv-${RUN}`

let projectId, plantId, eventId, harvestId, preservationId, varietyId

async function errOf(fn) {
  try { await fn(); return null } catch (e) { return `${e.message} ${e.sourceError?.message ?? ''} ${e.hint ?? ''} ${e.detail ?? ''}` }
}

beforeAll(async () => {
  projectId = (await insertProject({ name: `archpreserv-proj-${RUN}`, createdBy: USER })).id
  const pl = await directSql`
    INSERT INTO plants (project_id, name, created_by)
    VALUES (${projectId}, ${'archpreserv-plant-' + RUN}, ${USER}) RETURNING id`
  plantId = pl[0].id

  const ev = await directSql`
    INSERT INTO event_log (plant_id, project_id, event_type, event_date, logged_by, created_by)
    VALUES (${plantId}, ${projectId}, 'harvest', NOW(), ${USER}, ${USER}) RETURNING id`
  eventId = ev[0].id

  const hv = await directSql`
    INSERT INTO harvest_log (event_id, project_id, quantity, unit, created_by)
    VALUES (${eventId}, ${projectId}, 2, 'lb', ${USER}) RETURNING id`
  harvestId = hv[0].id

  // chk_preservation_log_attribution (L7) requires at least one of {crop_type_slug, variety_id}.
  const vr = await directSql`
    INSERT INTO plant_varieties (name, created_by)
    VALUES (${'archpreserv-cv-' + RUN}, ${USER}) RETURNING id`
  varietyId = vr[0].id

  // The put-up: a jar made FROM that harvest. This is the row whose provenance used to vanish.
  const pr = await directSql`
    INSERT INTO preservation_log (user_id, preserved_at, method, quantity_value, quantity_unit,
                                  variety_id, harvest_log_id, plant_id)
    VALUES (${USER}, NOW(), 'jam_preserve', 3, 'jar', ${varietyId}, ${harvestId}, ${plantId})
    RETURNING id`
  preservationId = pr[0].id
})

afterAll(async () => {
  await directSql`DELETE FROM preservation_log WHERE user_id = ${USER}`
  await directSql`DELETE FROM harvest_log WHERE created_by = ${USER}`
  await directSql`DELETE FROM event_log WHERE created_by = ${USER}`
  await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id = ${plantId}`
  await directSql`DELETE FROM plants WHERE created_by = ${USER}`
  await directSql`DELETE FROM entity WHERE cultivar_ref_id IN (
    SELECT id FROM plant_varieties WHERE created_by = ${USER})`
  await directSql`DELETE FROM plant_varieties WHERE created_by = ${USER}`
  await directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`
})

describe('BUG-ARCHPRESERVGUARD-001 — the mechanism the guard exists to prevent', () => {
  it('the FK really is SET NULL, so an unguarded harvest delete WOULD strip provenance', async () => {
    // Pins the premise rather than assuming it. This is also the assertion that would break first
    // if V4-PRESERVFKACTION-001 is ever decided in favour of RESTRICT — at which point this file
    // and v4-putup-001's gates need revisiting together.
    const [row] = await directSql`
      SELECT confdeltype FROM pg_constraint WHERE conname = 'preservation_log_harvest_log_id_fkey'`
    expect(row.confdeltype).toBe('n')
  })
})

describe('BUG-ARCHPRESERVGUARD-001 — archive_plant_events refuses', () => {
  it('refuses to archive a harvest that backs a put-up, naming preservation_log', async () => {
    const msg = await errOf(() =>
      directSql`SELECT * FROM archive_plant_events(${plantId}::uuid, 'int-test')`)
    expect(msg, 'the routine must refuse rather than silently null the provenance').toBeTruthy()
    expect(msg).toMatch(/preservation_log/)
  })

  it('NOTHING is half-done: the harvest, the event and the provenance link all survive', async () => {
    // The guard runs BEFORE any write, so a refused call must leave the world untouched — including
    // the photo detach, which happens after it.
    const [h] = await directSql`SELECT id FROM harvest_log WHERE id = ${harvestId}`
    expect(h.id).toBe(harvestId)
    const [e] = await directSql`SELECT id FROM event_log WHERE id = ${eventId}`
    expect(e.id).toBe(eventId)
    const [p] = await directSql`SELECT harvest_log_id FROM preservation_log WHERE id = ${preservationId}`
    expect(p.harvest_log_id, 'this is the value the defect used to null').toBe(harvestId)
  })
})

describe('BUG-ARCHPRESERVGUARD-001 — archive_container_events refuses too', () => {
  it('the container variant carries the same guard, mirroring its own delete predicate', async () => {
    const msg = await errOf(() =>
      directSql`SELECT * FROM archive_container_events(${projectId}::uuid, 'int-test')`)
    expect(msg).toBeTruthy()
    expect(msg).toMatch(/preservation_log/)
  })
})

describe('BUG-ARCHPRESERVGUARD-001 — the escape hatch, and no over-blocking', () => {
  it('clearing the provenance link on purpose unblocks the archive', async () => {
    // The guard's HINT asks the operator to clear or re-point the link first. That is the supported
    // path: the decision is made explicitly instead of being made silently by a cascade.
    await directSql`
      UPDATE preservation_log SET harvest_log_id = NULL WHERE id = ${preservationId}`

    const res = await directSql`SELECT * FROM archive_plant_events(${plantId}::uuid, 'int-test')`
    expect(res[0].harvests_archived, 'the harvest is archived once nothing depends on it').toBe(1)
    expect(res[0].events_archived).toBe(1)

    // The put-up itself is untouched — it was never the routine's to delete.
    const [p] = await directSql`SELECT id, quantity_value FROM preservation_log WHERE id = ${preservationId}`
    expect(p.id).toBe(preservationId)

    // And the harvest is in the cold store, keyed by its ORIGINAL id — which is why a preservation
    // pointer would still have been meaningful had the FK not nulled it.
    const [a] = await directSql`SELECT id FROM harvest_log_archive WHERE id = ${harvestId}`
    expect(a.id).toBe(harvestId)
  })
})

describe('BUG-ARCHPRESERVGUARD-001 — pins', () => {
  it('both routines carry the guard, and it precedes the harvest delete in each', async () => {
    // Positional, mirroring V4-SOFTDELCASCADE-001's detach-before-delete technique. A guard placed
    // below the DELETE is decoration: the rows would already be nulled before anything raised.
    const rows = await directSql`
      SELECT p.proname,
             position('preservation_log' in p.prosrc)              AS guard_at,
             position('DELETE FROM public.harvest_log' in p.prosrc) AS delete_at
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
       WHERE p.proname IN ('archive_plant_events','archive_container_events')`
    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(r.guard_at, `${r.proname} must mention preservation_log`).toBeGreaterThan(0)
      expect(r.guard_at, `${r.proname}: guard must precede the harvest delete`).toBeLessThan(r.delete_at)
    }
  })

  it('M3: user_achievements.trigger_event_id is DELIBERATELY still SET NULL', async () => {
    // The audit folded M3 into this row; re-examined, it is not a defect. Nulling a reward's
    // provenance pointer is standing policy (V4-EVTCASCADE-001) and — unlike a preservation record —
    // the event survives in event_log_archive, so the provenance stays recoverable.
    const [row] = await directSql`
      SELECT confdeltype FROM pg_constraint WHERE conname = 'user_achievements_trigger_event_id_fkey'`
    expect(row.confdeltype).toBe('n')
  })
})
