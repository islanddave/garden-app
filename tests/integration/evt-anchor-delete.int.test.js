// tests/integration/evt-anchor-delete.int.test.js
// BUG-EVTANCHORDEL-001 — the delete-cascade / anchor-CHECK contradiction on event_log.
//
// THE DEFECT. event_log has CHECK event_log_has_anchor (plant_id IS NOT NULL OR project_id IS NOT
// NULL) while event_log.plant_id was ON DELETE SET NULL. Hard-deleting a planting makes the FK's own
// cascade write plant_id = NULL; when the row's project_id is also NULL the cascade has just produced
// a row that violates the table's own CHECK, and the DELETE dies with 23514. The schema declared an
// action it was not permitted to perform.
//
// WHAT THIS FILE PROVES, in order:
//   1. the mechanism, executed by hand — the exact UPDATE the SET NULL cascade performs still raises
//      23514, so the invariant is intact and the old cascade genuinely could not have succeeded;
//   2. the fix — a hard plant delete is now REFUSED with 23503 naming event_log, instead of being
//      half-performed and rejected by a CHECK that names nothing useful;
//   3. the escape hatch — archive_plant_events() preserves the history and unblocks the delete;
//   4. a schema pin on the three FKs the migration flipped;
//   5. a GENERALISED class guard: no FK column anywhere in the schema may be SET NULL while it is an
//      arm of a disjunctive anchor CHECK. (4) pins today's instances; (5) is what actually catches
//      the next one, in a table nobody has written yet.
//
// Test (1) reproduces the fault by performing the cascade's UPDATE directly rather than by reverting
// the FK mid-suite. That is deliberate: directSql is the neon HTTP driver, where every call is its
// own transaction, so a DDL revert could not be rolled back and would leave the branch mis-shaped for
// every test after it. `UPDATE event_log SET plant_id = NULL WHERE id = <project-less event>` IS,
// byte for byte, the write ON DELETE SET NULL issues — so this is the real mechanism, not a proxy.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, testRunId, insertProject } from './_harness.js'

const RUN = testRunId()
const USER = `evtanchordel-${RUN}`

let projectId          // a real container, for the WITH-project planting
let plantlessProjectId
let projectlessPlantId // project_id IS NULL — the planting whose event has plant_id as its SOLE anchor
let projectedPlantId   // project_id set — its events keep a project anchor
let soleAnchorEventId
let projectedEventId

async function newPlanting({ project = null, name }) {
  const rows = await directSql`
    INSERT INTO plants (project_id, name, created_by)
    VALUES (${project}, ${name}, ${USER}) RETURNING id`
  return rows[0].id
}

async function newEvent({ plant = null, project = null, type = 'observation' }) {
  const rows = await directSql`
    INSERT INTO event_log (plant_id, project_id, event_type, event_date, logged_by, created_by)
    VALUES (${plant}, ${project}, ${type}, NOW(), ${USER}, ${USER}) RETURNING id`
  return rows[0].id
}

// Returns the SQLSTATE of a failed statement, or null if it unexpectedly succeeded.
async function sqlstateOf(fn) {
  try { await fn(); return null } catch (e) { return e.code ?? e.sourceError?.code ?? String(e.message) }
}

beforeAll(async () => {
  const p = await insertProject({ name: `evtanchordel-proj-${RUN}`, createdBy: USER })
  projectId = p.id
  const p2 = await insertProject({ name: `evtanchordel-proj2-${RUN}`, createdBy: USER })
  plantlessProjectId = p2.id

  projectlessPlantId = await newPlanting({ project: null, name: `evtanchordel-projectless-${RUN}` })
  projectedPlantId   = await newPlanting({ project: projectId, name: `evtanchordel-projected-${RUN}` })

  // The bug's precondition: plant_id is the ONLY anchor this row has.
  soleAnchorEventId = await newEvent({ plant: projectlessPlantId, project: null })
  // The contrast case: same shape, but a surviving second anchor.
  projectedEventId  = await newEvent({ plant: projectedPlantId, project: projectId })

  // plants already carries THREE other ON DELETE RESTRICT parents — entity.planting_ref_id,
  // entity_memory.plant_id and evidence.garden_node_id — and the `plants_entity_ins` trigger creates
  // an entity row for every new planting. Postgres reports whichever FK it checks first, so without
  // this the delete-refusal assertions below would be measuring entity_planting_ref_id_fkey rather
  // than the constraint under test. Clearing them makes event_log the SOLE remaining blocker.
  //
  // (That those three already exist is itself the argument for this migration: RESTRICT is the
  // established way plants are guarded here, and event_log.plant_id's SET NULL was the outlier.)
  await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id IN (
                    SELECT id FROM plants WHERE created_by = ${USER})`
  await directSql`DELETE FROM entity_memory WHERE plant_id IN (
                    SELECT id FROM plants WHERE created_by = ${USER})`
})

afterAll(async () => {
  // Under ON DELETE RESTRICT the events must go before the plantings — which is the whole point of
  // the fix: the ordering is now enforced by the DB instead of discovered through a 23514.
  await directSql`DELETE FROM event_log WHERE created_by = ${USER}`
  await directSql`DELETE FROM event_log_archive WHERE created_by = ${USER}`
  await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id IN (
                    SELECT id FROM plants WHERE created_by = ${USER})`
  await directSql`DELETE FROM entity_memory WHERE plant_id IN (
                    SELECT id FROM plants WHERE created_by = ${USER})`
  await directSql`DELETE FROM plants WHERE created_by = ${USER}`
  await directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`
})

describe('BUG-EVTANCHORDEL-001 — the 23514 mechanism', () => {
  it('nulling the sole anchor raises 23514 — the exact write ON DELETE SET NULL performed', async () => {
    const code = await sqlstateOf(() =>
      directSql`UPDATE event_log SET plant_id = NULL WHERE id = ${soleAnchorEventId}`)
    expect(code).toBe('23514')
  })

  it('names event_log_has_anchor, so the failure is the anchor invariant and not some other CHECK', async () => {
    let msg = ''
    try { await directSql`UPDATE event_log SET plant_id = NULL WHERE id = ${soleAnchorEventId}` }
    catch (e) { msg = `${e.message} ${e.constraint ?? ''} ${e.sourceError?.constraint ?? ''}` }
    expect(msg).toMatch(/event_log_has_anchor/)
  })

  it('the same write is HARMLESS when a project anchor survives — this is why prod never hit it', async () => {
    // 12,100 of 12,100 prod event rows carry a project_id, so every real cascade to date landed
    // here rather than on the failing arm. The bug is latent, not absent: the anchor CHECK exists
    // precisely to let plant-only events be written, and the first one makes its planting
    // undeletable.
    await directSql`UPDATE event_log SET plant_id = NULL WHERE id = ${projectedEventId}`
    const [row] = await directSql`SELECT plant_id, project_id FROM event_log WHERE id = ${projectedEventId}`
    expect(row.plant_id).toBeNull()
    expect(row.project_id).toBe(projectId)
    await directSql`UPDATE event_log SET plant_id = ${projectedPlantId} WHERE id = ${projectedEventId}`
  })
})

describe('BUG-EVTANCHORDEL-001 — the fix: RESTRICT refuses instead of half-deleting', () => {
  it('hard-deleting a project-less planting with an event fails 23503, NOT 23514', async () => {
    const code = await sqlstateOf(() =>
      directSql`DELETE FROM plants WHERE id = ${projectlessPlantId}`)
    // 23503 = foreign_key_violation. Pre-fix this was 23514 (check_violation) — a CHECK failing on a
    // row the caller never wrote, with nothing in the message pointing at the DELETE that caused it.
    expect(code).toBe('23503')
  })

  it('the refusal names event_log, so the obstacle is diagnosable from the error alone', async () => {
    let msg = ''
    try { await directSql`DELETE FROM plants WHERE id = ${projectlessPlantId}` }
    catch (e) { msg = `${e.message} ${e.sourceError?.message ?? ''} ${e.constraint ?? ''}` }
    expect(msg).toMatch(/event_log/)
  })

  it('refuses for a PROJECTED planting too — history is never silently detached from its planting', async () => {
    // Pre-fix this delete "succeeded" by nulling plant_id, quietly destroying the per-planting
    // attribution of every event. plant_projects hold multiple sibling plantings, so a project-only
    // anchor cannot say WHICH planting was watered or harvested.
    const code = await sqlstateOf(() => directSql`DELETE FROM plants WHERE id = ${projectedPlantId}`)
    expect(code).toBe('23503')
  })

  it('the planting and its event are both still there after the refused delete', async () => {
    const [p] = await directSql`SELECT id FROM plants WHERE id = ${projectlessPlantId}`
    const [e] = await directSql`SELECT plant_id FROM event_log WHERE id = ${soleAnchorEventId}`
    expect(p.id).toBe(projectlessPlantId)
    expect(e.plant_id).toBe(projectlessPlantId)
  })
})

describe('BUG-EVTANCHORDEL-001 — archive_plant_events() is the supported way through', () => {
  it('archives the history, then the planting deletes cleanly', async () => {
    const [res] = await directSql`SELECT * FROM archive_plant_events(${projectlessPlantId}::uuid, 'int-test')`
    expect(Number(res.events_archived)).toBe(1)

    const [live] = await directSql`SELECT count(*)::int AS n FROM event_log WHERE plant_id = ${projectlessPlantId}`
    expect(live.n).toBe(0)

    // The planting is now deletable — and this is the ONLY thing that makes it deletable.
    await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id = ${projectlessPlantId}`
    await directSql`DELETE FROM entity_memory WHERE plant_id = ${projectlessPlantId}`
    await directSql`DELETE FROM plants WHERE id = ${projectlessPlantId}`
    const gone = await directSql`SELECT id FROM plants WHERE id = ${projectlessPlantId}`
    expect(gone.length).toBe(0)
  })

  it('the archived event survives IN FULL — nothing about it is lost, only relocated', async () => {
    const [a] = await directSql`
      SELECT id, plant_id, event_type, created_by, archived_reason, archived_plant_id, row_data
        FROM event_log_archive WHERE id = ${soleAnchorEventId}`
    expect(a.id).toBe(soleAnchorEventId)
    expect(a.plant_id).toBe(projectlessPlantId)          // the anchor is PRESERVED, not nulled
    expect(a.archived_plant_id).toBe(projectlessPlantId)
    expect(a.archived_reason).toBe('int-test')
    // row_data is the complete original row, so the archive cannot drift as event_log gains columns.
    expect(a.row_data.event_type).toBe('observation')
    expect(a.row_data.created_by).toBe(USER)
    expect(a.row_data.logged_by).toBe(USER)
  })

  it('is idempotent — a second call on a plant with no events is a no-op, not an error', async () => {
    const [res] = await directSql`SELECT * FROM archive_plant_events(${projectedPlantId}::uuid, 'int-test-noop')`
    // projectedPlantId still HAS an event, so this one does move a row; re-running finds nothing.
    expect(Number(res.events_archived)).toBe(1)
    const [again] = await directSql`SELECT * FROM archive_plant_events(${projectedPlantId}::uuid, 'int-test-noop')`
    expect(Number(again.events_archived)).toBe(0)
    expect(Number(again.harvests_archived)).toBe(0)
    expect(Number(again.photos_detached)).toBe(0)
  })

  it('rejects a NULL plant id rather than archiving every anchorless event in the table', async () => {
    const code = await sqlstateOf(() => directSql`SELECT * FROM archive_plant_events(NULL::uuid)`)
    expect(code).not.toBeNull()
  })
})

// CI ORDERING (integration-test.yml branches off `staging` and does NOT apply migrations, so the
// schema moves independently of this file). These assertions are HARDCODED, not capability-detected
// — a guard that adapts to whichever schema it finds cannot fail when the fix is missing, which is
// the only thing it exists to do. The cost is a strict ordering requirement:
// v4-evtanchordel-001 MUST be applied to staging BEFORE this file lands on dev. It was (2026-08-04,
// 11/11 post-gates), so CI is green. Re-seeding staging from a pre-migration prod, or rolling
// STAGING back, reds this file until the migration is re-applied — that is correct signal, not drift.
describe('BUG-EVTANCHORDEL-001 — schema pins', () => {
  it('the three flipped FKs are ON DELETE RESTRICT', async () => {
    const rows = await directSql`
      SELECT conname, confdeltype FROM pg_constraint
       WHERE conname IN ('event_log_plant_id_fkey','photos_plant_id_fkey','photos_location_id_fkey')`
    expect(rows.length).toBe(3)
    for (const r of rows) expect(`${r.conname}=${r.confdeltype}`).toBe(`${r.conname}=r`)
  })

  it('event_log_has_anchor still exists — the fix keeps the invariant rather than relaxing it', async () => {
    const rows = await directSql`
      SELECT conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = 'event_log' AND t.relkind = 'r' AND c.conname = 'event_log_has_anchor'`
    expect(rows.length).toBe(1)
  })

  // ── The one that matters most ────────────────────────────────────────────────────────────────
  // BUG-EVTANCHORDEL-001 is a CLASS, not an instance: any FK column that is an arm of a disjunctive
  // "must have at least one parent" CHECK is unsafe as SET NULL, because the cascade's own UPDATE can
  // remove the last anchor and the CHECK then rejects the row it just produced. The tests above pin
  // the three instances that existed on 2026-08-04. This one fails on instance number four, in a
  // table that does not exist yet.
  //
  // Detection: a CHECK is treated as a disjunctive anchor guard when its expression is a chain of
  // `<col> IS NOT NULL` arms joined by OR (or the `SUM(x IS NOT NULL)::int = 1` XOR spelling), and it
  // references the FK column. The allow-list carries CHECKs that merely MENTION a SET-NULL column
  // without requiring it to be non-null — nulling those columns satisfies the CHECK rather than
  // violating it, so they are not members of the class.
  it('no FK column in a disjunctive anchor CHECK is ON DELETE SET NULL (class guard)', async () => {
    const ALLOWED = new Set([
      // chk_preservation_log_source_plant is (source_kind IS NULL OR source_kind='own_garden' OR
      // plant_id IS NULL). Nulling plant_id SATISFIES it. Verified live 2026-08-04; recorded here so
      // the next sweep does not re-litigate it.
      'preservation_log.plant_id.chk_preservation_log_source_plant',
    ])
    const rows = await directSql`
      WITH setnull_fk AS (
        SELECT c.conrelid AS reloid, unnest(c.conkey) AS attnum
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid AND t.relkind = 'r'
          JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
         WHERE c.contype = 'f' AND c.confdeltype IN ('n','d')
      ), anchor_check AS (
        SELECT c.conrelid AS reloid, c.conname, pg_get_constraintdef(c.oid) AS def,
               unnest(c.conkey) AS attnum
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid AND t.relkind = 'r'
          JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
         WHERE c.contype = 'c'
           AND (pg_get_constraintdef(c.oid) LIKE '%IS NOT NULL) OR %'
                OR pg_get_constraintdef(c.oid) LIKE '%IS NOT NULL))::integer%')
      )
      SELECT t.relname || '.' || a.attname || '.' || k.conname AS key, k.def
        FROM setnull_fk f
        JOIN anchor_check k ON k.reloid = f.reloid AND k.attnum = f.attnum
        JOIN pg_class t ON t.oid = f.reloid
        JOIN pg_attribute a ON a.attrelid = f.reloid AND a.attnum = f.attnum`
    const offenders = rows.filter(r => !ALLOWED.has(r.key))
    expect(offenders.map(r => r.key)).toEqual([])
  })
})
