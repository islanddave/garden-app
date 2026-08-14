// PROPOSED — move to tests/integration/parent-proj-fk.int.test.js before running.
// Parked in the migration directory because the authoring lane's file boundary was
// `migrations/v4-parentprojfk-001/**` plus tests/integration/plant-rehome-fk.int.test.js only.
// NOT YET EXECUTED against a database. Run it as part of the staging step of the runbook.
//
// V4-PARENTPROJFK-001 — the container HIERARCHY axis on plant_projects.
//
// THE DEFECT. plant_projects.parent_project_id was ON DELETE SET NULL against plant_projects(id).
// One statement — `DELETE FROM plant_projects WHERE id = '<parent>'` — silently promoted every child
// CONTAINER to top-level. Nothing was deleted, nothing errored, and nothing recorded where the row
// used to hang: parent_project_id is the ONLY place the hierarchy is stored, and container_closure
// is derived from it and cascades away with the deleted parent. Every other axis off this parent had
// refused that act with 23503 since v4-plantrehomefk-001 / V4-SOFTDELCASCADE-001; this was the last
// silent flatten. v4-parentprojfk-001 closes it.
//
// WHAT THIS FILE PROVES, in order:
//   1. the mechanism, executed by hand — the exact UPDATE the SET NULL cascade performed destroys
//      structure that exists nowhere else, so the stakes are real and not theoretical;
//   2. the fix — a hard parent delete is now REFUSED with 23503 naming plant_projects, and the child
//      keeps its parent rather than being half-flattened;
//   3. that RESTRICT did not over-block — a CHILDLESS container still deletes cleanly;
//   4. that the same-statement parent+child delete still SUCCEEDS, which is the property every
//      teardown in the suite depends on and the one a self-referential RESTRICT is assumed to break;
//   5. both escape hatches — promote-to-top-level and re-home-to-grandparent;
//   6. the schema pin. (The generalised class guard over every FK referencing plant_projects lives in
//      plant-rehome-fk.int.test.js and is not duplicated here.)
//
// Test (1) performs the cascade's UPDATE directly rather than reverting the FK mid-suite. That is
// deliberate, for the reason evt-anchor-delete.int.test.js gives: directSql is the neon HTTP driver,
// where every call is its own transaction, so a DDL revert could not be rolled back and would leave
// the branch mis-shaped for every test after it. `UPDATE plant_projects SET parent_project_id = NULL
// WHERE parent_project_id = ...` IS, byte for byte, the write ON DELETE SET NULL issued.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, testRunId, insertProject } from './_harness.js'

const RUN = testRunId()
const USER = `parentprojfk-${RUN}`

let rootId        // depth 1 — grandparent
let midId         // depth 2 — has a parent AND children; the case that decides the ticket
let leafId        // depth 3 — child of mid
let childlessId   // no children; must still delete, proving RESTRICT did not over-block

async function sqlstateOf(fn) {
  try { await fn(); return null } catch (e) { return e.code ?? e.sourceError?.code ?? String(e.message) }
}

async function newContainer(name, parent = null) {
  const p = await insertProject({ name: `${name}-${RUN}`, createdBy: USER })
  if (parent) await directSql`UPDATE plant_projects SET parent_project_id = ${parent} WHERE id = ${p.id}`
  return p.id
}

beforeAll(async () => {
  rootId = await newContainer('parentprojfk-root')
  midId = await newContainer('parentprojfk-mid', rootId)
  leafId = await newContainer('parentprojfk-leaf', midId)
  childlessId = await newContainer('parentprojfk-childless', rootId)
})

afterAll(async () => {
  // ONE statement, on purpose. Under RESTRICT a same-statement delete of a parent and its children
  // succeeds — measured across SET NULL, RESTRICT and NO ACTION alike — and this teardown is itself
  // the assertion of that property for every other suite that uses the same shape.
  await directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`
})

describe('V4-PARENTPROJFK-001 — the mechanism, and what it actually cost', () => {
  it('the cascade write destroys structure recorded nowhere else', async () => {
    // This is what SET NULL did implicitly to every child of a deleted parent. Performed here on a
    // throwaway subtree so the consequence is visible: the child knows its parent, and after the
    // write nothing anywhere does.
    const scrapParent = await newContainer('parentprojfk-scrap-p')
    const scrapChild = await newContainer('parentprojfk-scrap-c', scrapParent)

    const [before] = await directSql`
      SELECT parent_project_id FROM plant_projects WHERE id = ${scrapChild}`
    expect(before.parent_project_id).toBe(scrapParent)

    await directSql`UPDATE plant_projects SET parent_project_id = NULL WHERE parent_project_id = ${scrapParent}`

    const [after] = await directSql`
      SELECT parent_project_id FROM plant_projects WHERE id = ${scrapChild}`
    expect(after.parent_project_id, 'the child is now a root, and nothing records that it was not')
      .toBeNull()
    // There is no second key to recover from — unlike a re-homed planting, which at least keeps its
    // own created_by. container_closure is DERIVED from parent_project_id, so it cannot help.
    const closure = await directSql`
      SELECT 1 FROM container_closure WHERE descendant_id = ${scrapChild} AND ancestor_id = ${scrapParent}`
    expect(closure, 'the closure table is derived, not an independent record').toHaveLength(0)

    await directSql`DELETE FROM plant_projects WHERE id IN (${scrapChild}, ${scrapParent})`
  })
})

describe('V4-PARENTPROJFK-001 — the fix: RESTRICT refuses instead of silently flattening', () => {
  it('hard-deleting a parent that has a child container fails 23503', async () => {
    const code = await sqlstateOf(() => directSql`DELETE FROM plant_projects WHERE id = ${midId}`)
    // 23503 = foreign_key_violation. Pre-fix this "succeeded", promoting leafId to top-level.
    expect(code).toBe('23503')
  })

  it('the refusal names plant_projects, so the obstacle is diagnosable from the error alone', async () => {
    let msg = ''
    try { await directSql`DELETE FROM plant_projects WHERE id = ${midId}` }
    catch (e) { msg = `${e.message} ${e.sourceError?.message ?? ''} ${e.constraint ?? ''}` }
    expect(msg).toMatch(/plant_projects/)
  })

  it('NOTHING is half-done: the child keeps its parent after the refused delete', async () => {
    // The defining property of the old behaviour was that it half-succeeded. Assert the absence of a
    // partial flatten explicitly rather than trusting the error code.
    const [child] = await directSql`SELECT parent_project_id FROM plant_projects WHERE id = ${leafId}`
    expect(child.parent_project_id).toBe(midId)
    const [parent] = await directSql`SELECT id FROM plant_projects WHERE id = ${midId}`
    expect(parent.id).toBe(midId)
  })

  it('did NOT over-block: a childless container still deletes cleanly', async () => {
    // A RESTRICT that refuses everything would pass every test above while breaking the one
    // operation that must keep working. childlessId has a PARENT but no CHILDREN — being a child is
    // not what this FK blocks on.
    const code = await sqlstateOf(() => directSql`DELETE FROM plant_projects WHERE id = ${childlessId}`)
    expect(code).toBeNull()
    expect(await directSql`SELECT id FROM plant_projects WHERE id = ${childlessId}`).toHaveLength(0)
  })

  it('a same-statement parent+child delete still SUCCEEDS — the teardown property', async () => {
    // The claim that killed the first draft of this flip was that a self-referential RESTRICT would
    // refuse this. It does not, and every teardown in the suite (and the deploy-staging.yml smoke
    // purge, one statement at :612) depends on that. Pinned here so a future action change cannot
    // break 20+ suites silently.
    const a = await newContainer('parentprojfk-sameA')
    const b = await newContainer('parentprojfk-sameB', a)
    const c = await newContainer('parentprojfk-sameC', b)   // 3-level chain, one statement
    const code = await sqlstateOf(() =>
      directSql`DELETE FROM plant_projects WHERE id IN (${a}, ${b}, ${c})`)
    expect(code).toBeNull()
    expect(await directSql`SELECT id FROM plant_projects WHERE id IN (${a}, ${b}, ${c})`).toHaveLength(0)
  })
})

describe('V4-PARENTPROJFK-001 — the escape hatches are explicit statements, not a routine', () => {
  it('(a) promote to top-level unblocks the delete — the same act, now stated rather than inferred', async () => {
    const p = await newContainer('parentprojfk-escA-p')
    const c = await newContainer('parentprojfk-escA-c', p)

    expect(await sqlstateOf(() => directSql`DELETE FROM plant_projects WHERE id = ${p}`)).toBe('23503')
    await directSql`UPDATE plant_projects SET parent_project_id = NULL WHERE parent_project_id = ${p}`
    expect(await sqlstateOf(() => directSql`DELETE FROM plant_projects WHERE id = ${p}`)).toBeNull()

    const [row] = await directSql`SELECT parent_project_id FROM plant_projects WHERE id = ${c}`
    expect(row.parent_project_id, 'the child survives, now deliberately top-level').toBeNull()
    await directSql`DELETE FROM plant_projects WHERE id = ${c}`
  })

  it('(b) re-home to the grandparent — the answer SET NULL could never give', async () => {
    // This is the case that makes RESTRICT a capability rather than a restriction. SET NULL's
    // implicit answer was ALWAYS "promote to top-level", which for a mid-level node is wrong.
    const g = await newContainer('parentprojfk-escB-g')
    const p = await newContainer('parentprojfk-escB-p', g)
    const c = await newContainer('parentprojfk-escB-c', p)

    expect(await sqlstateOf(() => directSql`DELETE FROM plant_projects WHERE id = ${p}`)).toBe('23503')
    await directSql`
      UPDATE plant_projects SET parent_project_id =
        (SELECT parent_project_id FROM plant_projects WHERE id = ${p})
       WHERE parent_project_id = ${p}`
    expect(await sqlstateOf(() => directSql`DELETE FROM plant_projects WHERE id = ${p}`)).toBeNull()

    const [row] = await directSql`SELECT parent_project_id FROM plant_projects WHERE id = ${c}`
    expect(row.parent_project_id, 'the subtree kept its depth instead of being scattered').toBe(g)
    await directSql`DELETE FROM plant_projects WHERE id IN (${c}, ${g})`
  })
})

describe('V4-PARENTPROJFK-001 — schema pins', () => {
  it('plant_projects.parent_project_id is ON DELETE RESTRICT and VALIDATED', async () => {
    const [row] = await directSql`
      SELECT confdeltype, convalidated FROM pg_constraint
       WHERE conname = 'plant_projects_parent_project_id_fkey'`
    expect(row.confdeltype).toBe('r')
    expect(row.convalidated).toBe(true)
  })

  it('NO SET NULL foreign key remains anywhere on plant_projects', async () => {
    // The class closure, and the reason this migration is worth shipping as more than a one-column
    // tidy. Every FK on this parent now either refuses a container delete or cascades a derived
    // cache. A new child table added with ON DELETE SET NULL fails here, in a table that does not
    // exist yet. Mirrors post_no_setnull_fk_remains_on_plant_projects in gates.yml, so the suite and
    // the gate corpus corroborate rather than one trusting the other.
    const rows = await directSql`
      SELECT t.relname || '.' || c.conname AS key, c.confdeltype
        FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
       WHERE c.contype = 'f' AND c.confrelid = 'public.plant_projects'::regclass
         AND c.confdeltype IN ('n','d')`
    expect(rows.map(r => r.key)).toEqual([])
  })

  it('no self-referencing container exists — such a row would be undeletable under RESTRICT', async () => {
    // A row whose parent_project_id is its own id satisfies the FK but could never be deleted by any
    // single-row statement: it is its own blocking child. SET NULL tolerated the cycle; RESTRICT
    // turns it into a permanently stuck row. The API rejects it (PATCH/PUT both 400 when
    // body.parent_project_id === projectId); this asserts the data agrees.
    const rows = await directSql`SELECT id FROM plant_projects WHERE parent_project_id = id`
    expect(rows).toHaveLength(0)
  })
})
