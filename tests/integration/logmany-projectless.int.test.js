// logmany-projectless.int.test.js — BUG-LOGMANYPROJECTLESS-001, against a real database.
//
// THE DEFECT. The Log Many batch scope resolver and its event_log INSERT both read
//     FROM public.garden_node p JOIN public.container pp ON pp.id = p.container_id
// an INNER join. A planting with container_id IS NULL matched neither, so it was invisible to Log
// Many end to end: absent from the dry-run preview, absent from the review checklist, absent from
// the write. "All active plantings" meant "all active plantings that sit in a project" and nothing
// said so.
//
// Live prod 2026-08-21: 6 project-less plantings, 5 eligible (San Marzano rescue, Aloe Vera, Super
// Sweet 100 Rescue, Hydrangeas, Kousa Dogwood), against 221 project-bearing ones. Between them they
// hold 16 events and ZERO with source='app_batch' — every one logged by hand, one planting at a
// time, which is what a structural exclusion looks like from the data side.
//
// WHY INTEGRATION. lambda/events/logmany-projectless.test.js proves by source that both joins are
// LEFT and that ownership uses the two-arm predicate. It cannot prove the claim that matters: that
// a real container_id-NULL row comes back from a real resolver, survives a real transaction whose
// entity_memory upsert would violate entity_memory_exactly_one_parent if it touched it, and lands
// as a real event_log row with a NULL project. `container_id` is `plants.project_id` seen through
// the `garden_node` view — a view hop plus three-valued logic that source text cannot evaluate.
// Counting rows after a real POST is the only honest proof.
//
// THE ASSERTION THE TICKET IS ABOUT is "written === selected", asserted on a MIXED selection. A
// fixture of project-less plantings alone would go green against a resolver that returned nothing
// and an INSERT that wrote nothing, because 0 === 0.
//
// NOT-WIDER is asserted too, on the two axes a careless LEFT JOIN breaks:
//   * a project-less planting belonging to ANOTHER user must stay out — with the join gone, the
//     only thing scoping these rows is `p.created_by`, so the ownership arm is load-bearing here in
//     a way it never was for project-bearing rows;
//   * a planting whose project was SOFT-DELETED must stay out — it has a container_id, so LEFT
//     JOINing hands it a NULL pp row that the project-less arm would happily adopt, and Log Many
//     would start watering plantings out of beds Dave deleted.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId, insertProject } from './_harness.js'
import { handler as eventsHandler } from '../../lambda/events/index.js'

const RUN = testRunId()
const USER = `user_int_projless_${RUN}`
const OTHER = `user_int_projless_other_${RUN}`

let projectId          // owned by USER, alive
let deadProjectId      // owned by USER, soft-deleted after its planting is created
let inProjectA         // project-bearing control — must be logged
let inProjectB         // project-bearing control — must be logged
let projectLessA       // container_id IS NULL, USER  — the bug, must be logged
let projectLessB       // container_id IS NULL, USER  — the bug, must be logged
let foreignProjectLess // container_id IS NULL, OTHER — must NOT be logged
let orphanedByDelete   // container_id -> soft-deleted project — must NOT be logged

const mkPlant = async (name, { project = null, owner = USER, status = 'vegetative' } = {}) =>
  (await directSql`
    INSERT INTO plants (project_id, name, status, created_by)
    VALUES (${project}::uuid, ${name + '-' + RUN}, ${status}, ${owner}) RETURNING id`)[0].id

beforeAll(async () => {
  setTestUserId(USER)
  projectId = (await insertProject({ name: 'int-projless-' + RUN, createdBy: USER })).id
  deadProjectId = (await insertProject({ name: 'int-projless-dead-' + RUN, createdBy: USER })).id

  inProjectA = await mkPlant('projless-in-a', { project: projectId })
  inProjectB = await mkPlant('projless-in-b', { project: projectId })
  projectLessA = await mkPlant('projless-none-a')
  projectLessB = await mkPlant('projless-none-b')
  foreignProjectLess = await mkPlant('projless-foreign', { owner: OTHER })
  orphanedByDelete = await mkPlant('projless-orphan', { project: deadProjectId })

  // Soft-delete the parent AFTER the child exists: this is the shape that only appears once the
  // join is LEFT, and it is the one that would silently widen the batch.
  await directSql`UPDATE plant_projects SET deleted_at = NOW() WHERE id = ${deadProjectId}`
})

afterAll(async () => {
  for (const u of [USER, OTHER]) {
    await directSql`DELETE FROM xp_events WHERE user_id = ${u}`
    await directSql`DELETE FROM user_achievements WHERE user_id = ${u}`
    await directSql`DELETE FROM user_stats WHERE user_id = ${u}`
    await directSql`DELETE FROM app_events WHERE user_clerk_sub = ${u}`
    await directSql`DELETE FROM event_batches WHERE created_by = ${u}`
    await directSql`DELETE FROM entity_memory WHERE plant_id IN (SELECT id FROM plants WHERE created_by = ${u})`
    await directSql`DELETE FROM entity_memory WHERE project_id IN (SELECT id FROM plant_projects WHERE created_by = ${u})`
    await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id IN (SELECT id FROM plants WHERE created_by = ${u})`
    await directSql`DELETE FROM event_log WHERE created_by = ${u}`
    await directSql`DELETE FROM plants WHERE created_by = ${u}`
    await directSql`DELETE FROM plant_projects WHERE created_by = ${u}`
  }
})

let seq = 0
const postBatch = (over = {}) =>
  callHandler(eventsHandler, {
    method: 'POST', path: '/api/events/batch', userId: USER,
    body: {
      idempotency_key: `projless-${RUN}-${++seq}`,
      event_type: 'watering',
      scope: { type: 'all' },
      ...over,
    },
  })

const SELECTED = () => [inProjectA, inProjectB, projectLessA, projectLessB]

describe('Log Many writes one event per SELECTED planting, project or no project', () => {
  it('the dry-run preview includes project-less plantings alongside project-bearing ones', async () => {
    const { status, body } = await postBatch({ dry_run: true })
    expect(status).toBe(200)
    const ids = body.plantings.map((p) => p.id)
    expect(ids).toContain(projectLessA)
    expect(ids).toContain(projectLessB)
    expect(ids).toContain(inProjectA)
    expect(ids).toContain(inProjectB)
    // The count must agree with the list it came from, or a preview could show the right rows and
    // submit a different set.
    expect(body.count).toBe(ids.length)
    expect(new Set(ids)).toEqual(new Set(SELECTED()))
  })

  it('the WRITE path logs EVERY selected planting — written row count === selected count', async () => {
    // The ticket, in one assertion. Restoring either INNER join turns this from 4 into 2 with a
    // 200 response and no error anywhere, which is exactly the silence being fixed.
    const { status, body } = await postBatch()
    expect(status).toBe(200)
    const rows = await directSql`
      SELECT plant_id, project_id FROM event_log
       WHERE metadata->>'batch_id' = ${body.batch_id} AND deleted_at IS NULL`
    expect(rows).toHaveLength(SELECTED().length)
    expect(new Set(rows.map((r) => r.plant_id))).toEqual(new Set(SELECTED()))
    // …and the number the user reads must equal the number that exists.
    expect(body.count).toBe(rows.length)
  })

  it('a project-less planting yields a project-less EVENT — NULL project, plant_id anchor', async () => {
    // event_log_has_anchor is (plant_id IS NOT NULL OR project_id IS NOT NULL), so plant_id alone
    // satisfies it. This pins the VALUE, not just the row: a fix that invented a fallback project
    // would pass the count assertion above and quietly file these plantings under a bed they are
    // not in.
    const { body } = await postBatch()
    const rows = await directSql`
      SELECT plant_id, project_id FROM event_log
       WHERE metadata->>'batch_id' = ${body.batch_id} AND deleted_at IS NULL`
    const byPlant = Object.fromEntries(rows.map((r) => [r.plant_id, r.project_id]))
    expect(byPlant[projectLessA]).toBeNull()
    expect(byPlant[projectLessB]).toBeNull()
    expect(byPlant[inProjectA]).toBe(projectId)
    expect(byPlant[inProjectB]).toBe(projectId)
  })

  it("another user's project-less planting stays out — created_by is the ONLY scope left", async () => {
    // With the container join gone there is no pp.created_by to lean on for these rows. If the
    // ownership arm were widened to a bare `p.container_id IS NULL`, this batch would reach into a
    // stranger's garden and this is the only test that would notice.
    const { body } = await postBatch()
    const rows = await directSql`
      SELECT plant_id FROM event_log
       WHERE metadata->>'batch_id' = ${body.batch_id} AND deleted_at IS NULL`
    expect(rows.map((r) => r.plant_id)).not.toContain(foreignProjectLess)
    const foreign = await directSql`
      SELECT count(*)::int AS n FROM event_log WHERE plant_id = ${foreignProjectLess} AND deleted_at IS NULL`
    expect(foreign[0].n).toBe(0)
  })

  it('a planting whose project was soft-deleted still stays out — LEFT JOIN must not un-hide it', async () => {
    // The blast-radius pin. MEASURED, not assumed: deleting `AND (p.container_id IS NULL OR pp.id
    // IS NOT NULL)` alone leaves this test GREEN, because the ownership arm keys on the FK COLUMN
    // (p.container_id IS NULL), which is false for this row, so it is excluded twice over. The term
    // is defence in depth, not the load-bearing exclusion, and saying otherwise would have made
    // this a guard that cannot fail.
    // What it DOES catch is the realistic version of that mistake: rewriting the arm to key on the
    // JOINED ROW instead — `pp.id IS NULL AND p.created_by = ANY(householdIds)` — which reads
    // identically at a glance and is exactly what "we LEFT JOINed, so test the join" produces. That
    // spelling adopts every planting whose project was deleted, and this test goes red on it.
    const { body } = await postBatch({ dry_run: true })
    expect(body.plantings.map((p) => p.id)).not.toContain(orphanedByDelete)
    const { body: written } = await postBatch()
    const rows = await directSql`
      SELECT plant_id FROM event_log
       WHERE metadata->>'batch_id' = ${written.batch_id} AND deleted_at IS NULL`
    expect(rows.map((r) => r.plant_id)).not.toContain(orphanedByDelete)
  })
})

describe('the transaction survives a project-less planting (the partial-commit trap)', () => {
  it('commits: the batch row, the events and the care caches all land together', async () => {
    // entity_memory_exactly_one_parent means a project-keyed upsert fed a NULL container_id would
    // abort the whole transaction AFTER the event rows were staged — a batch that appears to
    // succeed and writes nothing, which is strictly worse than the bug being fixed. The
    // project-keyed statement's `AND p.container_id IS NOT NULL` self-guard is what prevents it, and
    // until this fix no project-less planting could reach that statement to exercise it.
    const { status, body } = await postBatch()
    expect(status).toBe(200)

    const batch = await directSql`SELECT item_count FROM event_batches WHERE id = ${body.batch_id}`
    expect(batch).toHaveLength(1)
    expect(batch[0].item_count).toBe(SELECTED().length)

    // Plant-keyed cache: every selected planting, project-less included. This is the arm that must
    // NOT be guarded away — plant_id is always non-NULL, so it is always exactly one parent.
    const plantCache = await directSql`
      SELECT plant_id FROM entity_memory WHERE plant_id = ANY(${SELECTED()})`
    expect(plantCache).toHaveLength(SELECTED().length)

    // Project-keyed cache: one row for the shared project, and none minted for the project-less
    // pair. A parentless row cannot exist at all — the CHECK would have rejected it — so its
    // absence is the observable proof the guard fired rather than the constraint.
    const projCache = await directSql`
      SELECT project_id FROM entity_memory WHERE project_id = ${projectId}`
    expect(projCache).toHaveLength(1)
  })

  it('a germination batch stamps germinated_at on a project-less planting too', async () => {
    // The anchor UPDATE inside the same transaction used `UPDATE … FROM public.container pp` — an
    // inner join by another name. Left alone it would have traded a missing event for a missing
    // anchor: the event row writes, germinated_at silently does not, and the caller cannot
    // distinguish that from "already germinated". `germination` IS in BATCH_EVENT_TYPES.
    const seedless = await mkPlant('projless-germ', { status: 'seedling' })
    const inProj = await mkPlant('projless-germ-inproj', { project: projectId, status: 'seedling' })
    const { status } = await postBatch({ event_type: 'germination', event_date: '2026-08-15' })
    expect(status).toBe(200)
    const rows = await directSql`
      SELECT id, germinated_at, germinated_at_approx FROM plants WHERE id = ANY(${[seedless, inProj]})`
    for (const r of rows) {
      expect(r.germinated_at, `germinated_at must be stamped on ${r.id}`).not.toBeNull()
      expect(r.germinated_at_approx).toBe(false)
    }
  })
})
