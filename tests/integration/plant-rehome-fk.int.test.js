// tests/integration/plant-rehome-fk.int.test.js
// BUG-PLANTREHOMEFK-001 — the containment/authorization axis on plant_projects.
// Folds BUG-TASKDETACHFK-001 (tasks.project_id).
//
// THE DEFECT. plants.project_id and tasks.project_id were ON DELETE SET NULL against
// plant_projects(id). One statement — `DELETE FROM plant_projects WHERE id = '<container>'` — silently
// stripped every child planting out of its container and dropped it into the PROJECT-LESS ARM, where
// the read/write predicate in lambda/plants/index.js keys on the planting's OWN created_by instead of
// the container's. Nothing was deleted, nothing errored, and nothing recorded where the row used to
// live. The history axis off the same parent (event_log.project_id, photos.project_id,
// harvest_log.project_id) has refused that act with 23503 since V4-SOFTDELCASCADE-001; the
// containment axis beside it was named in that migration and deferred. v4-plantrehomefk-001 closes it.
//
// WHAT THIS FILE PROVES, in order:
//   1. the mechanism, executed by hand — the exact UPDATE the SET NULL cascade performed still moves
//      a row between authorization arms, so the stakes are real and not theoretical;
//   2. the fix — a hard container delete is now REFUSED with 23503 naming plants, and the planting
//      keeps its project_id rather than being half-re-homed;
//   3. that RESTRICT did not over-block — an EMPTY container still deletes cleanly;
//   4. the escape hatch — an explicit `UPDATE ... SET project_id = NULL` unblocks the delete, which
//      is the whole of the fix: the transition is now stated rather than inferred;
//   5. a schema pin on the two FKs the migration flipped, and on the one it deliberately did NOT;
//   6. a GENERALISED class guard: every FK referencing plant_projects must have a REVIEWED ON DELETE
//      action. (5) pins today's instances; (6) is what catches the next table nobody has written yet.
//
// Test (1) performs the cascade's UPDATE directly rather than reverting the FK mid-suite. That is
// deliberate, for the reason evt-anchor-delete.int.test.js gives: directSql is the neon HTTP driver,
// where every call is its own transaction, so a DDL revert could not be rolled back and would leave
// the branch mis-shaped for every test after it. `UPDATE plants SET project_id = NULL WHERE ...` IS,
// byte for byte, the write ON DELETE SET NULL issued.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, testRunId, insertProject } from './_harness.js'

const RUN = testRunId()
const USER = `plantrehomefk-${RUN}`
const FOREIGN_USER = `plantrehomefk-foreign-${RUN}`

let containerId        // holds plantings — the delete target that must now be refused
let emptyContainerId   // holds nothing — must still delete, proving RESTRICT did not over-block
let escapeContainerId  // used by the escape-hatch test
let ownPlantId         // created_by = USER, inside USER's container
let foreignPlantId     // created_by = FOREIGN_USER, inside USER's container — the crossing case
let escapePlantId
let taskId

async function sqlstateOf(fn) {
  try { await fn(); return null } catch (e) { return e.code ?? e.sourceError?.code ?? String(e.message) }
}

async function newPlanting({ project = null, name, createdBy = USER }) {
  const rows = await directSql`
    INSERT INTO plants (project_id, name, created_by)
    VALUES (${project}, ${name}, ${createdBy}) RETURNING id`
  return rows[0].id
}

beforeAll(async () => {
  containerId = (await insertProject({ name: `plantrehomefk-c-${RUN}`, createdBy: USER })).id
  emptyContainerId = (await insertProject({ name: `plantrehomefk-empty-${RUN}`, createdBy: USER })).id
  escapeContainerId = (await insertProject({ name: `plantrehomefk-esc-${RUN}`, createdBy: USER })).id

  ownPlantId = await newPlanting({ project: containerId, name: `plantrehomefk-own-${RUN}` })
  // The crossing case, seeded via directSql rather than POST /api/plants ON PURPOSE. The API gates
  // body.project_id through loadOwnedProject() and 400s, so this row cannot be minted through the
  // handler — but 24 rows shaped exactly like it exist in live prod today from rescue-intake. The
  // guard has to hold for rows the API never minted, which is why it cannot rest on the API check.
  foreignPlantId = await newPlanting({
    project: containerId, name: `plantrehomefk-foreign-${RUN}`, createdBy: FOREIGN_USER,
  })
  escapePlantId = await newPlanting({ project: escapeContainerId, name: `plantrehomefk-esc-p-${RUN}` })

  const t = await directSql`
    INSERT INTO tasks (title, project_id, created_by)
    VALUES (${`plantrehomefk-task-${RUN}`}, ${containerId}, ${USER}) RETURNING id`
  taskId = t[0].id
})

afterAll(async () => {
  // CHILD-FIRST, and now enforced rather than merely conventional: plants.project_id and
  // tasks.project_id are ON DELETE RESTRICT, so a container cannot be dropped until it is empty.
  // This ordering is the teardown discipline the migration's README asks every suite to adopt.
  await directSql`DELETE FROM tasks WHERE created_by = ${USER}`
  await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id IN (
    SELECT id FROM plants WHERE created_by IN (${USER}, ${FOREIGN_USER}))`
  await directSql`DELETE FROM plants WHERE created_by IN (${USER}, ${FOREIGN_USER})`
  await directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`
})

describe('BUG-PLANTREHOMEFK-001 — the mechanism, and what it actually cost', () => {
  it('the cascade write moves a planting between authorization arms, not merely between values', async () => {
    // This is what SET NULL did implicitly to every child of a deleted container. Performed here on
    // a throwaway row so the consequence is visible: while project_id is set, the row is reachable
    // through the container's created_by (USER). Null it, and the ONLY key left is the row's own
    // created_by (FOREIGN_USER) — a different arm of the predicate, and a different owner.
    const scratch = await newPlanting({
      project: containerId, name: `plantrehomefk-scratch-${RUN}`, createdBy: FOREIGN_USER,
    })

    const [before] = await directSql`
      SELECT p.created_by AS own, pp.created_by AS container_owner
        FROM plants p JOIN plant_projects pp ON pp.id = p.project_id WHERE p.id = ${scratch}`
    expect(before.container_owner).toBe(USER)
    expect(before.own).toBe(FOREIGN_USER)

    await directSql`UPDATE plants SET project_id = NULL WHERE id = ${scratch}`

    const [after] = await directSql`
      SELECT project_id, created_by FROM plants WHERE id = ${scratch}`
    expect(after.project_id, 'the row is now in the project-less arm').toBeNull()
    expect(after.created_by,
      'and its authorization now keys on ITS OWN created_by, which is not the container owner')
      .toBe(FOREIGN_USER)

    await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id = ${scratch}`
    await directSql`DELETE FROM plants WHERE id = ${scratch}`
  })

  it('a sentinel-owned row re-homes into unreachability, which is why fail-closed is not free', async () => {
    // The 24 real prod instances are owned by `rescue-intake-longriver-20260712`, a non-Clerk
    // sentinel that matches NO caller. Re-homing those rows does not expose them — it makes them
    // permanently invisible through the API while leaving them in the table. Fail-closed is the
    // right default and it is exactly what makes this unrecoverable, so the FK is the layer that
    // has to refuse.
    const sentinel = 'rescue-intake-sentinel-' + RUN
    const scratch = await newPlanting({
      project: containerId, name: `plantrehomefk-sentinel-${RUN}`, createdBy: sentinel,
    })
    await directSql`UPDATE plants SET project_id = NULL WHERE id = ${scratch}`
    const [row] = await directSql`SELECT project_id, created_by FROM plants WHERE id = ${scratch}`
    expect(row.project_id).toBeNull()
    expect(row.created_by, 'matches no household member and no Clerk sub — reachable by nobody')
      .toBe(sentinel)

    await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id = ${scratch}`
    await directSql`DELETE FROM plants WHERE id = ${scratch}`
  })
})

describe('BUG-PLANTREHOMEFK-001 — the fix: RESTRICT refuses instead of silently re-homing', () => {
  it('hard-deleting a container that holds a planting fails 23503', async () => {
    const code = await sqlstateOf(() =>
      directSql`DELETE FROM plant_projects WHERE id = ${containerId}`)
    // 23503 = foreign_key_violation. Pre-fix this "succeeded", detaching every child planting.
    expect(code).toBe('23503')
  })

  it('the refusal names plants, so the obstacle is diagnosable from the error alone', async () => {
    let msg = ''
    try { await directSql`DELETE FROM plant_projects WHERE id = ${containerId}` }
    catch (e) { msg = `${e.message} ${e.sourceError?.message ?? ''} ${e.constraint ?? ''}` }
    expect(msg).toMatch(/plants/)
  })

  it('NOTHING is half-done: both plantings keep their container after the refused delete', async () => {
    // The defining property of the old behaviour was that it half-succeeded. Assert the absence of
    // a partial re-home explicitly rather than trusting the error code.
    const rows = await directSql`
      SELECT id, project_id FROM plants WHERE id IN (${ownPlantId}, ${foreignPlantId})`
    expect(rows).toHaveLength(2)
    for (const r of rows) expect(r.project_id).toBe(containerId)
    const [c] = await directSql`SELECT id FROM plant_projects WHERE id = ${containerId}`
    expect(c.id).toBe(containerId)
  })

  it('refuses for the FOREIGN-created planting too — the crossing case is the whole point', async () => {
    // entity.planting_ref_id is itself ON DELETE RESTRICT (DRG-ENGINE-002), so the registry row goes
    // first — the same child-before-parent discipline this migration is imposing one level up.
    await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id = ${ownPlantId}`
    await directSql`DELETE FROM plants WHERE id = ${ownPlantId}`
    // Only the foreign-created planting (and the task) still hold the container. If the FK keyed on
    // anything ownership-aware it would let this one through; it does not, and must not.
    const code = await sqlstateOf(() =>
      directSql`DELETE FROM plant_projects WHERE id = ${containerId}`)
    expect(code).toBe('23503')
    const [row] = await directSql`SELECT project_id FROM plants WHERE id = ${foreignPlantId}`
    expect(row.project_id).toBe(containerId)
  })

  it('BUG-TASKDETACHFK-001: a task alone also blocks the delete', async () => {
    await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id = ${foreignPlantId}`
    await directSql`DELETE FROM plants WHERE id = ${foreignPlantId}`
    // The container is now empty of plantings — the task is the sole remaining child.
    const code = await sqlstateOf(() =>
      directSql`DELETE FROM plant_projects WHERE id = ${containerId}`)
    expect(code).toBe('23503')
    const [t] = await directSql`SELECT project_id FROM tasks WHERE id = ${taskId}`
    expect(t.project_id).toBe(containerId)
  })

  it('did NOT over-block: an empty container still deletes cleanly', async () => {
    // A RESTRICT that refuses everything would pass every test above while breaking the one
    // operation that must keep working.
    const code = await sqlstateOf(() =>
      directSql`DELETE FROM plant_projects WHERE id = ${emptyContainerId}`)
    expect(code).toBeNull()
    const rows = await directSql`SELECT id FROM plant_projects WHERE id = ${emptyContainerId}`
    expect(rows).toHaveLength(0)
  })
})

describe('BUG-PLANTREHOMEFK-001 — the escape hatch is an explicit statement, not a routine', () => {
  it('an explicit re-home unblocks the delete — the same act, now stated rather than inferred', async () => {
    // SOFTDELCASCADE shipped archive_container_events() because those rows had to be PRESERVED.
    // A planting needs no cold store, it needs a DECISION — so this migration ships no routine and
    // the supported path is one statement an operator has to type.
    expect(await sqlstateOf(() =>
      directSql`DELETE FROM plant_projects WHERE id = ${escapeContainerId}`)).toBe('23503')

    await directSql`UPDATE plants SET project_id = NULL WHERE project_id = ${escapeContainerId}`

    expect(await sqlstateOf(() =>
      directSql`DELETE FROM plant_projects WHERE id = ${escapeContainerId}`)).toBeNull()
    const [row] = await directSql`SELECT project_id FROM plants WHERE id = ${escapePlantId}`
    expect(row.project_id, 'the planting survives, now deliberately project-less').toBeNull()
  })
})

describe('BUG-PLANTREHOMEFK-001 — schema pins and the class guard', () => {
  it('plants.project_id and tasks.project_id are ON DELETE RESTRICT', async () => {
    const rows = await directSql`
      SELECT conname, confdeltype FROM pg_constraint
       WHERE conname IN ('plants_project_id_fkey','tasks_project_id_fkey')`
    expect(rows).toHaveLength(2)
    for (const r of rows) expect(r.confdeltype).toBe('r')
  })

  it('plant_projects.parent_project_id is DELIBERATELY still SET NULL', async () => {
    // The most load-bearing pin in this file. parent_project_id keeps SET NULL on a POLICY question,
    // NOT a technical one — and the distinction was established by measurement after the first
    // draft asserted the opposite. Measured 2026-08-13 on an ephemeral branch off staging: a
    // same-statement parent+child delete, and a 3-level chain, SUCCEED under SET NULL, RESTRICT and
    // NO ACTION alike; only the parent-alone-with-surviving-child case differs, where SET NULL
    // flattens silently and both RESTRICT and NO ACTION refuse with 23503. This whole suite was
    // re-run with the column flipped to RESTRICT: zero pre-existing failures, the only reds being
    // this test and the class guard below. So RESTRICT is SAFE here; what is undecided is whether a
    // parent container SHOULD be undeletable while it has children, or whether promoting its
    // children to top-level is correct. If you are here because this failed: that question needs an
    // answer on the record, not a schema change that assumes one.
    const [row] = await directSql`
      SELECT confdeltype FROM pg_constraint
       WHERE conname = 'plant_projects_parent_project_id_fkey'`
    expect(row.confdeltype).toBe('n')
  })

  // ── The one that matters most ────────────────────────────────────────────────────────────────
  // BUG-PLANTREHOMEFK-001 is a CLASS, not an instance: plant_projects is the ownership scope for
  // everything hanging off it, so ANY new child FK silently inherits a policy decision about what a
  // container delete does to it. The pins above cover the FKs that existed on 2026-08-13. This one
  // fails on child number twelve, in a table that does not exist yet — a new FK to plant_projects
  // cannot land without someone writing down which action it gets and why.
  it('every FK referencing plant_projects has a REVIEWED ON DELETE action (class guard)', async () => {
    const REVIEWED = {
      // Containment + authorization. RESTRICT: a container delete is refused, never silent.
      'plants.plants_project_id_fkey': 'r',
      'tasks.tasks_project_id_fkey': 'r',
      // History. RESTRICT via V4-SOFTDELCASCADE-001 / BUG-EVTANCHORDEL-001.
      'event_log.event_log_project_id_fkey': 'r',
      'photos.photos_project_id_fkey': 'r',
      'harvest_log.harvest_log_project_id_fkey': 'r',
      // Self-referential hierarchy. SET NULL deliberately — see the pin above.
      'plant_projects.plant_projects_parent_project_id_fkey': 'n',
      // Derived caches and closure rows, rebuilt from live data. Cascading with the container is
      // correct: none of these is user-authored content.
      'entity_memory.entity_memory_project_id_fkey': 'c',
      'container_closure.container_closure_ancestor_id_fkey': 'c',
      'container_closure.container_closure_descendant_id_fkey': 'c',
      'inactive_project_dismissals.inactive_project_dismissals_project_id_fkey': 'c',
      // A provenance pointer on the global cultivar catalogue; already refuses.
      'plant_varieties.plant_varieties_source_proj_rescope_fk': 'a',
    }
    const rows = await directSql`
      SELECT t.relname || '.' || c.conname AS key, c.confdeltype
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
       WHERE c.contype = 'f' AND c.confrelid = 'public.plant_projects'::regclass`

    const unreviewed = rows.filter(r => !(r.key in REVIEWED)).map(r => r.key)
    expect(unreviewed,
      'a new FK to plant_projects landed without a reviewed ON DELETE action — decide what a ' +
      'container delete does to it, then add it to REVIEWED with the reason').toEqual([])

    const drifted = rows
      .filter(r => r.key in REVIEWED && r.confdeltype !== REVIEWED[r.key])
      .map(r => `${r.key}: expected ${REVIEWED[r.key]}, got ${r.confdeltype}`)
    expect(drifted, 'a reviewed FK changed action without this map being updated').toEqual([])

    const missing = Object.keys(REVIEWED).filter(k => !rows.some(r => r.key === k))
    expect(missing, 'a reviewed FK disappeared — dropping one silently removes its protection')
      .toEqual([])
  })
})
