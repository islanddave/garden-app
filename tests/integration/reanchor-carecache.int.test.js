// tests/integration/reanchor-carecache.int.test.js
// V4-EVENTEDITFIELDS-001 Slice 3 (re-anchor) — the BEHAVIOURAL half of the care-cache guarantee.
//
// WHAT THE STATIC TESTS ALREADY PROVE, AND WHAT THEY DO NOT.
// lambda/events/edit-fields.test.js:246 ("the OLD-anchor arms assign from surv and NEVER through
// GREATEST") reads index.js as TEXT. It proves the re-anchor SQL is SHAPED so that a decrease is
// expressible. It cannot prove a decrease HAPPENS: it never executes the statement, never binds a
// parameter, never meets a row, and stays green against surv subqueries whose predicates are wrong,
// whose UPDATE matches zero rows, or that run before the event_log UPDATE has committed the new
// anchor. Falsifiable statement of the gap this file closes:
//
//   "Against real Postgres, after an event is re-anchored from A to B, A's entity_memory recency
//    values are STRICTLY LOWER than they were before the move (or NULL), and B's are at least as
//    high as the moved event."
//
// Nothing in this repository could make that sentence false before this file. Every assertion that
// reads the EVENT row passes whether or not the recompute ran — the event moves correctly either
// way, nothing 500s, nothing logs, and the vacated anchor silently keeps claiming a watering it no
// longer has, forever, because every forward upsert is GREATEST().
//
// CALIBRATION — BUG-CARECACHEUNDO-001 is the same family, one route over: event undo recomputed
// only last_watered_at, so undoing a harvest / fertilizing / pruning / observation left that column
// and last_event_at permanently ahead of the log. migrations/v4-carecacheundo-001 repaired the data
// (applied to prod 2026-08-07 14:47Z), and the proof it walked BACKWARDS ONLY was that the
// complementary "behind" population was UNCHANGED at 15 rows. The detector in staleForward() below
// is that migration's post gate `post_no_cache_ahead_of_event_log`, verbatim, scoped to this file's
// fixtures. Verified against live prod the same day: 0 ahead, 15 behind, 338 rows total.
//
// PER-ARM WRITER PARITY is asserted behaviourally here, not only as text: the plant-keyed writer
// maps event_type IN ('harvest','first_harvest') (index.js:1499, :1519) and the project-keyed one
// maps = 'harvest' (index.js:1450, :1472). A first_harvest therefore sets a PLANTING's
// last_harvested_at and must leave a CONTAINER's NULL. edit-fields.test.js:267 asserts the two SQL
// strings differ; this asserts the consequence — a unified filter would give a container a
// last_harvested_at that no forward write in this codebase could ever have produced.
//
// FIXTURE ISOLATION IS LOAD-BEARING, not tidiness. A vacated container recomputes from ALL of its
// surviving events, so a sibling describe's event parked on the same container silently holds the
// recompute up at the value the test is trying to watch it fall from — and the test then passes for
// the wrong reason, or fails blaming the handler. Every describe therefore builds its own
// containers and plantings, exactly as the PUT/harvest describe in events.int.test.js:75 does.
//
// TEARDOWN ORDER (BUG-EVTANCHORDEL-001). event_log.plant_id is ON DELETE RESTRICT since
// v4-evtanchordel-001, and event_log_has_anchor requires plant_id OR project_id, so the only safe
// order is: harvest_log -> event_log -> entity -> entity_memory -> plants -> plant_projects.
// Deleting plantings first fails 23503 post-migration, and pre-migration the FK's own SET NULL
// cascade produced a row violating the anchor CHECK and died 23514 naming nothing useful.
// entity_memory.plant_id is itself ON DELETE RESTRICT, and the plants_entity_ins trigger creates an
// `entity` row for every planting — both must go before the planting.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { directSql, callHandler, testRunId, setTestUserId, insertProject } from './_harness.js'
import { handler } from '../../lambda/events/index.js'

const RUN = testRunId()
const USER = `user_int_reanchor_${RUN}`

const DAY = 24 * 3600 * 1000
const T1 = new Date(Date.now() - 20 * DAY).toISOString()  // the SURVIVOR — where a vacated cache must land
const T2 = new Date(Date.now() - 10 * DAY).toISOString()  // the MOVED event — where the cache starts
const ms = (v) => (v == null ? null : new Date(v).getTime())

const RECENCY = ['last_event_at', 'last_watered_at', 'last_fertilized_at',
                 'last_pruned_at', 'last_observed_at', 'last_harvested_at']

const post = (body) => callHandler(handler, { method: 'POST', path: '/api/events', body, userId: USER })
const put = (id, body) => callHandler(handler, { method: 'PUT', path: `/api/events/${id}`, body, userId: USER })

async function newEvent(body) {
  const res = await post(body)
  expect(res.status, `POST failed: ${JSON.stringify(res.body)}`).toBe(201)
  return res.body.id ?? res.body.eventId
}
async function newProject(tag) {
  return (await insertProject({ name: `int-reanchor-${tag}-${RUN}`, createdBy: USER })).id
}
async function newPlanting({ project = null, tag }) {
  const rows = await directSql`
    INSERT INTO plants (project_id, name, created_by)
    VALUES (${project}, ${`int-reanchor-${tag}-${RUN}`}, ${USER}) RETURNING id`
  return rows[0].id
}

// Column lists are written out per helper rather than interpolated from a shared constant: the neon
// HTTP driver's tagged template parameterises EVERY ${} slot, so a spliced identifier list would be
// bound as a single text literal and the query would fail. There is no .unsafe() escape hatch here.
const plantCache = async (id) =>
  (await directSql`
    SELECT id, plant_id, project_id, location_id, next_water_at,
           last_event_at, last_watered_at, last_fertilized_at,
           last_pruned_at, last_observed_at, last_harvested_at,
           -- BUG-LASTISSUEPLANT-001 added this column the same day this file was written, and
           -- neither helper picked it up. GAP 4 asserts on it, so without this its precondition
           -- read undefined and the block could never distinguish the defect from the repair.
           last_issue_at
      FROM entity_memory WHERE plant_id = ${id}`)[0] ?? null
// BUG-EVENTPROJPLANTPAIR-001: the event's OWN project, read from the row rather than inferred from
// which cache row moved. A pair assertion has to name the column it is about.
const eventProject = async (id) =>
  (await directSql`SELECT project_id FROM event_log WHERE id = ${id}`)[0]?.project_id ?? null
const projectCache = async (id) =>
  (await directSql`
    SELECT id, plant_id, project_id, location_id, next_water_at,
           last_event_at, last_watered_at, last_fertilized_at,
           last_pruned_at, last_observed_at, last_harvested_at,
           -- BUG-LASTISSUEPLANT-001 added this column the same day this file was written, and
           -- neither helper picked it up. GAP 4 asserts on it, so without this its precondition
           -- read undefined and the block could never distinguish the defect from the repair.
           last_issue_at
      FROM entity_memory WHERE project_id = ${id}`)[0] ?? null

// THE CANONICAL STALE-FORWARD DETECTOR.
// Lifted from migrations/v4-carecacheundo-001/gates.yml `post_no_cache_ahead_of_event_log`, scoped
// to this run's fixtures via created_by. A row is an offender when ANY cached recency value is
// STRICTLY AHEAD of the surviving event log — including the cached-non-NULL / truth-NULL case,
// which is precisely the shape produced by re-anchoring a planting's ONLY event and which a
// GREATEST-based writer can neither create nor repair. The per-arm harvest filter split is baked
// into the CASE, so the detector cannot be satisfied by a recompute that unifies the two arms.
async function staleForward() {
  return directSql`
    WITH truth AS (
      SELECT em.id, em.plant_id, em.project_id,
             em.last_event_at, em.last_watered_at, em.last_fertilized_at,
             em.last_pruned_at, em.last_observed_at, em.last_harvested_at, em.last_issue_at,
             (SELECT MAX(e.event_date) FROM public.event_log e
               WHERE e.deleted_at IS NULL
                 AND (CASE WHEN em.plant_id IS NOT NULL THEN e.plant_id = em.plant_id
                           ELSE e.project_id = em.project_id END)) AS t_any,
             (SELECT MAX(e.event_date) FROM public.event_log e
               WHERE e.deleted_at IS NULL AND e.event_type IN ('watering','rain')
                 AND (CASE WHEN em.plant_id IS NOT NULL THEN e.plant_id = em.plant_id
                           ELSE e.project_id = em.project_id END)) AS t_water,
             (SELECT MAX(e.event_date) FROM public.event_log e
               WHERE e.deleted_at IS NULL AND e.event_type = 'fertilizing'
                 AND (CASE WHEN em.plant_id IS NOT NULL THEN e.plant_id = em.plant_id
                           ELSE e.project_id = em.project_id END)) AS t_fert,
             (SELECT MAX(e.event_date) FROM public.event_log e
               WHERE e.deleted_at IS NULL AND e.event_type = 'pruning'
                 AND (CASE WHEN em.plant_id IS NOT NULL THEN e.plant_id = em.plant_id
                           ELSE e.project_id = em.project_id END)) AS t_prune,
             (SELECT MAX(e.event_date) FROM public.event_log e
               WHERE e.deleted_at IS NULL AND e.event_type = 'observation'
                 AND (CASE WHEN em.plant_id IS NOT NULL THEN e.plant_id = em.plant_id
                           ELSE e.project_id = em.project_id END)) AS t_obs,
             (SELECT MAX(e.event_date) FROM public.event_log e
               WHERE e.deleted_at IS NULL
                 AND (CASE WHEN em.plant_id IS NOT NULL THEN e.event_type IN ('harvest','first_harvest')
                           ELSE e.event_type = 'harvest' END)
                 AND (CASE WHEN em.plant_id IS NOT NULL THEN e.plant_id = em.plant_id
                           ELSE e.project_id = em.project_id END)) AS t_harv,
             (SELECT MAX(e.event_date) FROM public.event_log e
               WHERE e.deleted_at IS NULL AND e.flagged_as_issue = true
                 AND (CASE WHEN em.plant_id IS NOT NULL THEN e.plant_id = em.plant_id
                           ELSE e.project_id = em.project_id END)) AS t_issue
        FROM public.entity_memory em
       WHERE em.plant_id IN (SELECT id FROM public.plants WHERE created_by = ${USER})
          OR em.project_id IN (SELECT id FROM public.plant_projects WHERE created_by = ${USER})
    )
    SELECT id, plant_id, project_id FROM truth
     WHERE (last_event_at      IS NOT NULL AND (t_any   IS NULL OR last_event_at      > t_any))
        OR (last_watered_at    IS NOT NULL AND (t_water IS NULL OR last_watered_at    > t_water))
        OR (last_fertilized_at IS NOT NULL AND (t_fert  IS NULL OR last_fertilized_at > t_fert))
        OR (last_pruned_at     IS NOT NULL AND (t_prune IS NULL OR last_pruned_at     > t_prune))
        OR (last_observed_at   IS NOT NULL AND (t_obs   IS NULL OR last_observed_at   > t_obs))
        OR (last_harvested_at  IS NOT NULL AND (t_harv  IS NULL OR last_harvested_at  > t_harv))
        OR (last_issue_at      IS NOT NULL AND (t_issue IS NULL OR last_issue_at      > t_issue))`
}

// THE STALE-BEHIND DETECTOR — the twin, and the reason BUG-CACHEFWDGAP-001 existed.
//
// staleForward() above and the gate it was lifted from both test `cached > truth` ONLY. That is not
// a sensitivity gap, it is a blind spot: no volume of BEHIND drift can ever trip them. 15 rows
// accreted on prod across three months and four unrelated causes with every gate green, and this
// file is exactly where they would have been caught behaviourally — it asserts at length that a
// VACATED anchor walks down, and never once asserts that a TARGET anchor walks up.
//
// The `t_x IS NOT NULL AND (cached IS NULL OR cached < t_x)` shape is load-bearing in both halves.
// A plain `cached < t_x` silently passes on every NULL cell — and NULL-against-a-populated-log was
// the worst of the prod population (ten cells, from a repair script whose INSERT column list was
// short). Symmetrically, `t_x IS NULL` means the entity has no such event and must NOT count as
// behind. IS DISTINCT FROM would collapse this into staleForward() and lose the direction, which is
// the whole point: the two directions have different causes and different repairs.
async function staleBehind() {
  return directSql`
    WITH truth AS (
      SELECT em.id, em.plant_id, em.project_id,
             em.last_event_at, em.last_watered_at, em.last_fertilized_at,
             em.last_pruned_at, em.last_observed_at, em.last_harvested_at, em.last_issue_at,
             (SELECT MAX(e.event_date) FROM public.event_log e
               WHERE e.deleted_at IS NULL
                 AND (CASE WHEN em.plant_id IS NOT NULL THEN e.plant_id = em.plant_id
                           ELSE e.project_id = em.project_id END)) AS t_any,
             (SELECT MAX(e.event_date) FROM public.event_log e
               WHERE e.deleted_at IS NULL AND e.event_type IN ('watering','rain')
                 AND (CASE WHEN em.plant_id IS NOT NULL THEN e.plant_id = em.plant_id
                           ELSE e.project_id = em.project_id END)) AS t_water,
             (SELECT MAX(e.event_date) FROM public.event_log e
               WHERE e.deleted_at IS NULL AND e.event_type = 'fertilizing'
                 AND (CASE WHEN em.plant_id IS NOT NULL THEN e.plant_id = em.plant_id
                           ELSE e.project_id = em.project_id END)) AS t_fert,
             (SELECT MAX(e.event_date) FROM public.event_log e
               WHERE e.deleted_at IS NULL AND e.event_type = 'pruning'
                 AND (CASE WHEN em.plant_id IS NOT NULL THEN e.plant_id = em.plant_id
                           ELSE e.project_id = em.project_id END)) AS t_prune,
             (SELECT MAX(e.event_date) FROM public.event_log e
               WHERE e.deleted_at IS NULL AND e.event_type = 'observation'
                 AND (CASE WHEN em.plant_id IS NOT NULL THEN e.plant_id = em.plant_id
                           ELSE e.project_id = em.project_id END)) AS t_obs,
             (SELECT MAX(e.event_date) FROM public.event_log e
               WHERE e.deleted_at IS NULL
                 AND (CASE WHEN em.plant_id IS NOT NULL THEN e.event_type IN ('harvest','first_harvest')
                           ELSE e.event_type = 'harvest' END)
                 AND (CASE WHEN em.plant_id IS NOT NULL THEN e.plant_id = em.plant_id
                           ELSE e.project_id = em.project_id END)) AS t_harv,
             (SELECT MAX(e.event_date) FROM public.event_log e
               WHERE e.deleted_at IS NULL AND e.flagged_as_issue = true
                 AND (CASE WHEN em.plant_id IS NOT NULL THEN e.plant_id = em.plant_id
                           ELSE e.project_id = em.project_id END)) AS t_issue
        FROM public.entity_memory em
       WHERE em.plant_id IN (SELECT id FROM public.plants WHERE created_by = ${USER})
          OR em.project_id IN (SELECT id FROM public.plant_projects WHERE created_by = ${USER})
    )
    SELECT id, plant_id, project_id FROM truth
     WHERE (t_any   IS NOT NULL AND (last_event_at      IS NULL OR last_event_at      < t_any))
        OR (t_water IS NOT NULL AND (last_watered_at    IS NULL OR last_watered_at    < t_water))
        OR (t_fert  IS NOT NULL AND (last_fertilized_at IS NULL OR last_fertilized_at < t_fert))
        OR (t_prune IS NOT NULL AND (last_pruned_at     IS NULL OR last_pruned_at     < t_prune))
        OR (t_obs   IS NOT NULL AND (last_observed_at   IS NULL OR last_observed_at   < t_obs))
        OR (t_harv  IS NOT NULL AND (last_harvested_at  IS NULL OR last_harvested_at  < t_harv))
        OR (t_issue IS NOT NULL AND (last_issue_at      IS NULL OR last_issue_at      < t_issue))`
}

beforeAll(() => { setTestUserId(USER) })

afterAll(async () => {
  await directSql`DELETE FROM xp_events WHERE user_id = ${USER}`
  await directSql`DELETE FROM user_achievements WHERE user_id = ${USER}`
  await directSql`DELETE FROM user_stats WHERE user_id = ${USER}`
  await directSql`DELETE FROM app_events WHERE user_clerk_sub = ${USER}`
  await directSql`DELETE FROM harvest_log WHERE created_by = ${USER}`
  await directSql`DELETE FROM event_log WHERE created_by = ${USER}`
  await directSql`DELETE FROM entity WHERE entity_type='planting' AND planting_ref_id IN (
                    SELECT id FROM plants WHERE created_by = ${USER})`
  await directSql`DELETE FROM entity_memory WHERE plant_id IN (
                    SELECT id FROM plants WHERE created_by = ${USER})`
  await directSql`DELETE FROM entity_memory WHERE project_id IN (
                    SELECT id FROM plant_projects WHERE created_by = ${USER})`
  await directSql`DELETE FROM plants WHERE created_by = ${USER}`
  await directSql`DELETE FROM plant_projects WHERE created_by = ${USER}`
})

describe('re-anchor between PLANTINGS: the vacated planting walks BACKWARDS', () => {
  let projectId, plantA, plantB, movedId

  beforeAll(async () => {
    projectId = await newProject('p1')
    // Sibling plantings under ONE container. plant_projects hold multiple sibling plantings, so
    // "watered the wrong tomato" is a plant-only move with projectChanged = false — the realistic
    // mis-log, and the case that isolates the plant-keyed arms.
    plantA = await newPlanting({ project: projectId, tag: 'p1-A' })
    plantB = await newPlanting({ project: projectId, tag: 'p1-B' })
    await newEvent({ project_id: projectId, plant_id: plantA, event_type: 'watering', event_date: T1 })
    movedId = await newEvent({ project_id: projectId, plant_id: plantA, event_type: 'watering', event_date: T2 })
  })

  it('PRECONDITION: plantA is cached at T2, plantB has no cache row at all', async () => {
    // Its own test so a failure reads as "the fixture never got built" rather than as a false
    // accusation against the recompute.
    const a = await plantCache(plantA)
    expect(ms(a.last_watered_at)).toBe(ms(T2))
    expect(ms(a.last_event_at)).toBe(ms(T2))
    expect(await plantCache(plantB)).toBeNull()
  })

  it('after the move plantA reads T1 — STRICTLY LOWER than before. This is the whole ticket', async () => {
    // MUTATION PROOF: rewrite the old-plant arm (index.js:1501) as
    //   last_watered_at = GREATEST(em.last_watered_at, surv.mw)
    // and every other assertion in this repository still passes while this one fails. The event row
    // is correct either way; only a read of the ABANDONED anchor can tell the difference.
    const res = await put(movedId, { event_type: 'watering', event_date: T2, plant_id: plantB })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.plant_id).toBe(plantB)

    const a = await plantCache(plantA)
    expect(ms(a.last_watered_at), 'plantA still claims the watering it no longer has').toBe(ms(T1))
    expect(ms(a.last_event_at)).toBe(ms(T1))
    expect(ms(a.last_watered_at)).toBeLessThan(ms(T2))
  })

  it('plantB gained a cache row it never had — an upsert, not a bare UPDATE', async () => {
    // A bare UPDATE matches zero rows on a destination that has never carried an event, and reports
    // nothing. The planting would silently have no care memory at all.
    const b = await plantCache(plantB)
    expect(b, 'no row was inserted for the destination planting').not.toBeNull()
    expect(ms(b.last_watered_at)).toBe(ms(T2))
    expect(ms(b.last_event_at)).toBe(ms(T2))
  })

  it('the CONTAINER cache is untouched — the event never left this project', async () => {
    // projectChanged is false, so no project arm may run. Asserting the negative stops a future
    // "just recompute everything, it is easier to reason about" refactor from quietly widening the
    // blast radius of a plant-only edit.
    const p = await projectCache(projectId)
    expect(ms(p.last_watered_at)).toBe(ms(T2))
    expect(ms(p.last_event_at)).toBe(ms(T2))
  })

  it('moving it BACK restores both caches — the operation is reversible in both directions', async () => {
    // The handler comment (index.js:1414) justifies the uniform recompute by direction-independence.
    // A recompute correct in one direction only passes every assertion above and fails here.
    const res = await put(movedId, { event_type: 'watering', event_date: T2, plant_id: plantA })
    expect(res.status).toBe(200)
    expect(ms((await plantCache(plantA)).last_watered_at)).toBe(ms(T2))
    expect((await plantCache(plantB)).last_watered_at, 'plantB must now walk backwards to NULL').toBeNull()
  })
})

describe('re-anchor: vacating a planting of its ONLY event drives the cache to NULL', () => {
  // The sharpest assertion in the file. GREATEST(COALESCE(x, v), v) is total — it cannot return
  // NULL — so a cache that reaches NULL here is positive proof the value came from surv rather than
  // from a forward upsert. It is also exactly the shape BUG-CARECACHEUNDO-001 left on prod
  // ("Pineapple Tomato": last_harvested_at cached at 2026-08-04 with no surviving harvest at all).
  let projectId, plantC, plantD, soloId

  beforeAll(async () => {
    projectId = await newProject('p2')
    plantC = await newPlanting({ project: projectId, tag: 'p2-C' })
    plantD = await newPlanting({ project: projectId, tag: 'p2-D' })
    soloId = await newEvent({ project_id: projectId, plant_id: plantC, event_type: 'watering', event_date: T2 })
  })

  it('PRECONDITION: plantC is cached at T2 from its one and only event', async () => {
    expect(ms((await plantCache(plantC)).last_watered_at)).toBe(ms(T2))
  })

  it('every recency column on plantC goes to NULL — a state unreachable through GREATEST', async () => {
    const res = await put(soloId, { event_type: 'watering', event_date: T2, plant_id: plantD })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const c = await plantCache(plantC)
    expect(c, 'the row must be RECOMPUTED, not deleted').not.toBeNull()
    for (const col of RECENCY) expect(c[col], `${col} survived the vacate`).toBeNull()
  })

  it('the emptied row still satisfies entity_memory_exactly_one_parent', async () => {
    // A recompute that "tidied up" by nulling the anchor alongside the values would produce a
    // zero-parent row, abort the transaction, and surface as an opaque 500 AFTER the event had
    // already moved — the event_log UPDATE commits before sql.transaction(reanchor) runs.
    const c = await plantCache(plantC)
    expect([c.plant_id, c.project_id, c.location_id].filter((x) => x != null)).toEqual([plantC])
  })

  it('plantD received the event', async () => {
    expect(ms((await plantCache(plantD)).last_watered_at)).toBe(ms(T2))
  })
})

describe('re-anchor between CONTAINERS: the vacated project walks back, next_water_at included', () => {
  // Project-only events (plant_id null) so plantChanged stays false and the project arms are the
  // only thing under test. The destination has never carried an event, so its row must be INSERTed.
  let projectSrc, projectDst, movedId

  beforeAll(async () => {
    projectSrc = await newProject('p3-src')
    projectDst = await newProject('p3-dst')
    await newEvent({ project_id: projectSrc, event_type: 'watering', event_date: T1 })
    movedId = await newEvent({ project_id: projectSrc, event_type: 'watering', event_date: T2 })
  })

  it('PRECONDITION: the source is cached at T2 with next_water_at four days out', async () => {
    // 4 days is COALESCE(watering_interval_days, <location_type CASE>) with both NULL on a fresh
    // row — the same default the recompute uses (index.js:1456), so the two are comparable.
    const p = await projectCache(projectSrc)
    expect(ms(p.last_watered_at)).toBe(ms(T2))
    expect(ms(p.next_water_at)).toBe(ms(T2) + 4 * DAY)
    expect(await projectCache(projectDst)).toBeNull()
  })

  it('the source drops to T1 and its next_water_at is RE-DERIVED from T1, not left at T2+4d', async () => {
    // next_water_at is the one cached value a user sees as a due date. Left forward, the container
    // silently vanishes from "needs water" for ten days and nothing anywhere reports it.
    const res = await put(movedId, { event_type: 'watering', event_date: T2, project_id: projectDst })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.project_id).toBe(projectDst)

    const p = await projectCache(projectSrc)
    expect(ms(p.last_watered_at)).toBe(ms(T1))
    expect(ms(p.last_event_at)).toBe(ms(T1))
    expect(ms(p.next_water_at), 'the due date still points at the departed watering').toBe(ms(T1) + 4 * DAY)
  })

  it('the destination got a brand-new cache row at T2', async () => {
    const p = await projectCache(projectDst)
    expect(p, 'the destination has no cache row — the upsert degenerated to an UPDATE').not.toBeNull()
    expect(ms(p.last_watered_at)).toBe(ms(T2))
    expect(ms(p.last_event_at)).toBe(ms(T2))
  })
})

describe('per-arm writer parity survives a re-anchor: first_harvest is a PLANTING milestone only', () => {
  // first_harvest carries no quantity and writes no harvest_log row (validators.js:197), so it
  // exercises the harvest columns without dragging the weight resolver in.
  //
  // REWRITTEN for BUG-EVENTPROJPLANTPAIR-001 (dev 9492601), which changed the CONTRACT this block
  // was written against — it did not break the cache. This suite used to move the event by sending
  // project_id ALONE on a planting-anchored event. That body is now a NO-OP on project_id by
  // design: the pair invariant makes the PLANTING decide the project, so the event never leaves
  // projectSrc, `projectChanged` is correctly false and there is nothing to vacate. The tell that
  // the handler was right and the test was wrong: this file's own canonical detectors
  // (staleForward / staleBehind) stayed GREEN throughout the failure — the cached value the old
  // assertion demanded be NULL was pointing at an event the container genuinely still held.
  //
  // The parity property is unchanged and still the point. It is now driven through a move the pair
  // invariant actually performs — re-anchoring the event to a planting that lives in the other
  // container — which moves BOTH anchors and therefore runs all four arms, a strictly stronger
  // exercise of the same writers than the old project-only move.
  let projectSrc, projectDst, plantE, plantF, fhId

  beforeAll(async () => {
    projectSrc = await newProject('p4-src')
    projectDst = await newProject('p4-dst')
    plantE = await newPlanting({ project: projectSrc, tag: 'p4-E' })
    plantF = await newPlanting({ project: projectDst, tag: 'p4-F' })
    fhId = await newEvent({ project_id: projectSrc, plant_id: plantE, event_type: 'first_harvest', event_date: T1 })
  })

  it('PRECONDITION: the planting records the milestone, the container does not', async () => {
    expect(ms((await plantCache(plantE)).last_harvested_at)).toBe(ms(T1))
    expect((await projectCache(projectSrc)).last_harvested_at,
      'the project-keyed forward writer maps harvest only').toBeNull()
  })

  it('a project_id disagreeing with the planting is DISCARDED — so nothing is vacated', async () => {
    // The pair invariant seen from the cache's side. BUG-EVENTPROJPLANTPAIR-001's rule is that a
    // planting-bearing event takes its project from the planting; the corollary the cache arms
    // depend on is that such a request moves NOTHING, and a vacate here would be a claim about
    // something that did not happen (and would leave the container BEHIND the log, the direction
    // v4-cachefwdgap-001 exists for).
    const res = await put(fhId, { event_type: 'first_harvest', event_date: T1, project_id: projectDst })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await eventProject(fhId), 'the claimed project reached the row').toBe(projectSrc)
    expect(await projectCache(projectDst),
      'the destination got a cache row for an event that never arrived').toBeNull()
    expect(ms((await projectCache(projectSrc)).last_event_at),
      'the source was vacated of an event it still holds').toBe(ms(T1))
  })

  it('re-anchoring to a planting in the other container leaves BOTH containers last_harvested_at NULL', async () => {
    const res = await put(fhId, { event_type: 'first_harvest', event_date: T1, plant_id: plantF })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await eventProject(fhId), 'the event did not follow its planting').toBe(projectDst)
    expect((await projectCache(projectSrc)).last_harvested_at,
      'the vacated container invented a harvest it never had').toBeNull()
    expect((await projectCache(projectDst)).last_harvested_at,
      'the destination claims a harvest its own forward writer would never record').toBeNull()
  })

  it('the vacated container is emptied on every OTHER recency column too', async () => {
    const p = await projectCache(projectSrc)
    for (const col of RECENCY) expect(p[col], `${col} survived the vacate`).toBeNull()
  })

  it('the destination container records the EVENT while still recording no harvest', async () => {
    // Both halves together are the parity claim: the same row, same statement, one column set from
    // the event and one deliberately not, because = 'harvest' is what the project-keyed forward
    // writer maps. A recompute that unified the two arms passes the line above and fails this one.
    const p = await projectCache(projectDst)
    expect(ms(p.last_event_at)).toBe(ms(T1))
    expect(p.last_harvested_at).toBeNull()
  })

  it('the milestone follows the event: the vacated planting loses it, the destination gains it', async () => {
    // entity_memory is keyed plant-FIRST, so this is the arm that actually carries first_harvest —
    // asserting only on the containers above would check the wrong row for this property.
    expect((await plantCache(plantE)).last_harvested_at,
      'the vacated planting kept a milestone that moved off it').toBeNull()
    expect(ms((await plantCache(plantF)).last_harvested_at)).toBe(ms(T1))
  })
})

describe('the invariant, over everything this file touched', () => {
  it('no cached recency value is ahead of the surviving event log (canonical detector)', async () => {
    // The same query that gates migrations/v4-carecacheundo-001. Each describe above asserts one
    // cell; this asserts the property across every fixture at once, and it is what catches a
    // regression in an arm nobody thought to write a case for.
    const offenders = await staleForward()
    expect(offenders.map((r) => r.plant_id ?? r.project_id)).toEqual([])
  })

  it('no cached recency value is BEHIND the surviving event log either', async () => {
    // BUG-CACHEFWDGAP-001. Everything above this line asserts that a VACATED anchor walks DOWN;
    // nothing asserted that a TARGET anchor walks UP, and the canonical detector cannot express it.
    // That asymmetry is why 15 rows sat behind on prod for three months with every gate green.
    const offenders = await staleBehind()
    expect(offenders.map((r) => r.plant_id ?? r.project_id)).toEqual([])
  })
})

// ── THE FOUR GAPS — WERE RED, NOW FIXED AND LIVE ────────────────────────────────────────────────
//
// These landed SKIPPED alongside this file, complete and runnable and failing against dev HEAD, so
// that shipping the file would not red the fail-closed `integration-tests` promote gate for defects
// it did not introduce. BUG-CACHEGATE-001 fixed the shared root cause and un-skipped all four in
// the same commit. Do NOT "fix" a future failure here by weakening an assertion — each was derived
// exactly the way the passing cases above were, and each ran RED before the fix and GREEN after,
// which is the only evidence that distinguishes a repair from a coincidence.
//
// SHARED ROOT CAUSE (fixed): index.js gated the entire recompute on `projectChanged ||
// plantChanged`, and the predicate is now `cacheDirty` over four axes — anchors, event_type,
// event_date and the resolved flag.
// Anchor movement is only ONE of the three ways this PUT invalidates the cache. The other two —
// event_date moving backwards (index.js:1222) and event_type changing (index.js:1221) — run no
// recompute at all, and every forward upsert is GREATEST(), so the drift is permanent and accretes
// one cell per edit. That is BUG-CARECACHEUNDO-001's mechanism arriving through a different door,
// in a route that shipped AFTER the repair.
describe('GAP 1 — editing an event_date BACKWARDS leaves the cache forward', () => {
  let projectId, id
  beforeAll(async () => {
    projectId = await newProject('gap1')
    id = await newEvent({ project_id: projectId, event_type: 'watering', event_date: T2 })
  })
  it('moving the only watering back to T1 must lower last_watered_at', async () => {
    const res = await put(id, { event_type: 'watering', event_date: T1 })
    expect(res.status).toBe(200)
    const p = await projectCache(projectId)
    expect(ms(p.last_watered_at)).toBe(ms(T1))          // reads T2 today
    expect(ms(p.next_water_at)).toBe(ms(T1) + 4 * DAY)  // reads T2+4d today
  })
})

// GAP 4 (BUG-LASTISSUEPLANT-001 session, 2026-08-07): the SAME gate, reached through the flag.
// v4.2.0 shipped the ability to UNFLAG an event from EventDetail (clearFields.js:resolveFlagPair).
// Unflagging changes neither anchor, so `projectChanged || plantChanged` is false and no recompute
// runs — last_issue_at keeps pointing at an event that is no longer flagged, permanently, because
// its forward writer is GREATEST(). This is the fourth door into the same room, and it is the one
// that most directly undercuts adding last_issue_at to the six recompute arms: the arms are now
// correct, but the most likely way a user invalidates the column reaches none of them.
// UN-SKIPPED by that commit: the gate at index.js is now the four-axis cacheDirty predicate.
describe('GAP 4 — unflagging an event leaves last_issue_at pointing at it', () => {
  let projectId, id
  beforeAll(async () => {
    projectId = await newProject('gap4')
    id = await newEvent({ project_id: projectId, event_type: 'observation', event_date: T2,
      flagged_as_issue: true, severity: 2 })   // validators.js:107 — severity is 1|2|3, not a word
  })
  it('the container has no flagged event left, so last_issue_at must go NULL', async () => {
    const p0 = await projectCache(projectId)
    expect(ms(p0.last_issue_at)).toBe(ms(T2))    // the forward writer set it — this passes today

    const res = await put(id, { event_type: 'observation', event_date: T2, flagged_as_issue: false })
    expect(res.status).toBe(200)
    const p = await projectCache(projectId)
    expect(p.last_issue_at).toBeNull()           // reads T2 today
  })
})

describe('GAP 2 — retyping an event AWAY from watering leaves last_watered_at set', () => {
  let projectId, id
  beforeAll(async () => {
    projectId = await newProject('gap2')
    id = await newEvent({ project_id: projectId, event_type: 'watering', event_date: T2 })
  })
  it('the container has no watering left, so last_watered_at must go NULL', async () => {
    const res = await put(id, { event_type: 'observation', event_date: T2 })
    expect(res.status).toBe(200)
    const p = await projectCache(projectId)
    expect(p.last_watered_at).toBeNull()         // reads T2 today
    expect(ms(p.last_observed_at)).toBe(ms(T2))  // reads NULL today
  })
})

describe('GAP 3 — next_water_at is gated on the POST-edit event_type', () => {
  // index.js:1455 binds ${movedType} = body.event_type, i.e. what the event BECOMES. Re-anchor a
  // watering AND retype it in one save and the CASE takes the NOT IN ('watering','rain') arm, so
  // the vacated container keeps a next_water_at derived from a watering that is now neither its
  // event nor a watering. last_watered_at correctly walks backwards in the same statement, leaving
  // the pair mutually inconsistent — which is the tell, and is why this is a distinct defect from
  // GAP 2 rather than the same one seen twice.
  let projectSrc, projectDst, id
  beforeAll(async () => {
    projectSrc = await newProject('gap3-src')
    projectDst = await newProject('gap3-dst')
    await newEvent({ project_id: projectSrc, event_type: 'watering', event_date: T1 })
    id = await newEvent({ project_id: projectSrc, event_type: 'watering', event_date: T2 })
  })
  it('a simultaneous re-anchor + retype must still re-derive the vacated due date', async () => {
    const res = await put(id, { event_type: 'observation', event_date: T2, project_id: projectDst })
    expect(res.status).toBe(200)
    const p = await projectCache(projectSrc)
    expect(ms(p.last_watered_at)).toBe(ms(T1))          // passes today
    expect(ms(p.next_water_at)).toBe(ms(T1) + 4 * DAY)  // reads T2+4d today
  })
})

// ── THE FINAL SWEEP — BOTH DIRECTIONS, OVER EVERY FIXTURE INCLUDING THE FOUR GAPS ───────────────
//
// The mid-file invariant block runs BEFORE the GAP describes, so it never sees the rows they
// produce — the re-anchors, retypes, unflags and date moves that are the most cache-hostile
// operations in the file. This block runs last and covers everything.
//
// Both directions, deliberately as two separate assertions rather than one IS DISTINCT FROM. AHEAD
// and BEHIND have different causes and different repairs (v4-carecacheundo-001 walks the cache back,
// v4-cachefwdgap-001 walks it forward), so a single symmetric check would report "drift" without
// saying which ticket owns it, and would let a fix for one silently mask a regression in the other.
describe('the invariant, after the four gaps too — both directions', () => {
  it('nothing is ahead of the event log', async () => {
    const offenders = await staleForward()
    expect(offenders.map((r) => r.plant_id ?? r.project_id)).toEqual([])
  })

  it('nothing is behind the event log', async () => {
    const offenders = await staleBehind()
    expect(offenders.map((r) => r.plant_id ?? r.project_id)).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// V4-CACHEMISSINGROW-001 — THE THIRD DETECTOR, and the blind spot both existing ones share.
//
// staleForward() and staleBehind() above both enumerate `FROM public.entity_memory`. Each is
// therefore a statement about cache ROWS, not about PLANTINGS, and each silently carries the
// qualifier "for every entity that HAS a cache row". A planting with surviving events and no row is
// neither ahead nor behind — it is not a row. 14 plantings sat outside that qualifier on prod for
// three months with every gate and every test green.
//
//   THE RULE: an invariant of the form "for every X, P holds" must be enumerated FROM the relation
//   that DEFINES X, never from the relation that CARRIES P.
//
// missingCache() enumerates FROM plants — the side that can be MISSING. It carries NO lifecycle
// filter, and that absence is the single most load-bearing line in this block: adding
// `p.archived_at IS NULL` here is exactly the defect in migrations/care-rekey-001/0b-backfill.sql
// that CREATED the prod population, and it would re-hide 8 of the 14 rows. Scoped by created_by
// because the CI database is an ephemeral branch off staging — an unscoped detector would inherit
// staging's holes and be red forever, which is how a real detector gets deleted for being noisy.
async function missingCache() {
  return directSql`
    SELECT p.id AS plant_id
      FROM public.plants p
     WHERE p.created_by = ${USER}
       AND EXISTS (SELECT 1 FROM public.event_log e
                    WHERE e.plant_id = p.id AND e.deleted_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM public.entity_memory em WHERE em.plant_id = p.id)`
}

describe('V4-CACHEMISSINGROW-001 — a planting with events and no cache row', () => {
  let plantM, plantN, evtM, evtN, project
  // Relative, matching the module-level T1/T2 rather than fixed literals: every other describe in
  // this file anchors to Date.now(), and a hardcoded date drifts into "months old" as the file ages,
  // which is a validation surface this block has no business depending on. Shadowing the module
  // constants deliberately — this describe owns its own timeline.
  const T1 = new Date(Date.now() - 18 * DAY).toISOString()
  const T2 = new Date(Date.now() - 14 * DAY).toISOString()
  const T3 = new Date(Date.now() - 6 * DAY).toISOString()

  beforeAll(async () => {
    project = await newProject('missing')
    plantM = await newPlanting({ project, tag: 'missing-m' })
    plantN = await newPlanting({ project, tag: 'missing-n' })
    evtM = await newEvent({ plant_id: plantM, project_id: project, event_type: 'watering', event_date: T2 })
    evtN = await newEvent({ plant_id: plantN, project_id: project, event_type: 'first_harvest', event_date: T1 })
    // MANUFACTURE THE HOLE. The deployed POST writer has just created both rows, so a test that
    // merely created a planting and posted an event would pass for entirely the wrong reason.
    await directSql`DELETE FROM entity_memory WHERE plant_id IN (${plantM}, ${plantN})`
    // ARCHIVE one of them. This step is the mutation guard: without it, a future "tidy up" that
    // adds a lifecycle filter to missingCache() still passes — and that edit is the exact shape of
    // the bug in the tree that produced all 14 prod rows.
    await directSql`UPDATE plants SET archived_at = NOW() WHERE id = ${plantM}`
  })

  it('NEGATIVE CONTROL: the hole is invisible to BOTH shipped detectors', async () => {
    expect((await staleForward()).map((r) => r.plant_id ?? r.project_id)).toEqual([])
    expect((await staleBehind()).map((r) => r.plant_id ?? r.project_id)).toEqual([])
  })

  it('the third detector FIRES on it — including on the ARCHIVED planting', async () => {
    const found = (await missingCache()).map((r) => r.plant_id).sort()
    expect(found).toEqual([plantM, plantN].sort())
  })

  it('the row comes back AT TRUTH, not merely back', async () => {
    // Through the deployed writer, not by hand — the repair must be reachable by the code path
    // that is supposed to maintain this invariant going forward.
    //
    // The edit MOVES the event_date. A PUT that resends identical values is a no-op: the events
    // handler gates its recompute on the edit having actually dirtied the cache over four axes, so
    // a same-values PUT runs no arm and creates no row. The first draft of this test resent T2/T1
    // unchanged and failed in CI for exactly that reason — which is the writer behaving correctly
    // and the test being wrong about it.
    const rM = await put(evtM, { event_type: 'watering', event_date: T3, plant_id: plantM, project_id: project })
    expect(rM.status, `PUT M failed: ${JSON.stringify(rM.body)}`).toBe(200)
    const rN = await put(evtN, { event_type: 'first_harvest', event_date: T3, plant_id: plantN, project_id: project })
    expect(rN.status, `PUT N failed: ${JSON.stringify(rN.body)}`).toBe(200)

    expect((await missingCache()).map((r) => r.plant_id)).toEqual([])
    // Coverage ALONE would pass on two all-NULL rows, which is why this assertion is not optional:
    // the definition of done is coverage AND value together, never either one on its own.
    expect((await staleBehind()).map((r) => r.plant_id ?? r.project_id)).toEqual([])
    // The plant arm maps harvest as IN ('harvest','first_harvest'); the PROJECT arm uses
    // = 'harvest'. A backfill or writer that copied the project arm's mapping fails right here.
    expect(ms((await plantCache(plantN)).last_harvested_at)).toBe(ms(T3))
    expect(ms((await plantCache(plantM)).last_watered_at)).toBe(ms(T3))
  })
})
